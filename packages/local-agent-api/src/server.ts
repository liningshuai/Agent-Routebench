import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentEvent } from "@agent-workbench/agent-core";
import { apiErrorPayload } from "./errors.js";
import { writeNdjsonLine } from "./ndjson.js";
import { InMemoryLocalAgentSessionStore } from "./session-store.js";
import {
  ApiValidationError,
  parseApiOptions,
  parseTurnRequest,
} from "./validation.js";
import type {
  LocalAgentApiOptions,
  LocalAgentConfigManager,
  LocalAgentApiServer,
  LocalAgentSessionStore,
} from "./types.js";

const SAFE_ABORT_MESSAGE = "Turn aborted.";

const CONFIG_FORBIDDEN_FIELDS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "token",
  "authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "endpoint",
  "access_token",
  "refresh_token",
  "client_secret",
  "bearer",
  "oauth",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoConfigSecrets(value: unknown, depth = 0): void {
  if (depth > 32) {
    throw new ApiValidationError("invalidConfigRequest");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoConfigSecrets(item, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (CONFIG_FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      throw new ApiValidationError("invalidConfigRequest");
    }
    assertNoConfigSecrets(nested, depth + 1);
  }
}

const PROVIDER_RESPONSE_FIELDS = new Set([
  "id",
  "name",
  "protocol",
  "baseUrl",
  "credentialRef",
  "models",
  "enabled",
]);

const ROUTE_RESPONSE_FIELDS = new Set([
  "id",
  "name",
  "providerId",
  "model",
  "enabled",
  "fallbackProviderIds",
]);

function assertSafeProvider(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROVIDER_RESPONSE_FIELDS.has(key))) {
    throw new Error("invalid config response");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.protocol !== "anthropic_messages" && value.protocol !== "openai_compatible") ||
    typeof value.baseUrl !== "string" ||
    (value.credentialRef !== null && typeof value.credentialRef !== "string") ||
    !Array.isArray(value.models) ||
    !value.models.every((model) => typeof model === "string") ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("invalid config response");
  }
  return structuredClone(value);
}

function assertSafeRoute(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !ROUTE_RESPONSE_FIELDS.has(key))) {
    throw new Error("invalid config response");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.model !== "string" ||
    typeof value.enabled !== "boolean" ||
    (value.fallbackProviderIds !== undefined &&
      (!Array.isArray(value.fallbackProviderIds) ||
        !value.fallbackProviderIds.every((id) => typeof id === "string")))
  ) {
    throw new Error("invalid config response");
  }
  return structuredClone(value);
}

function safeConfigSnapshot(value: unknown): {
  version: 1;
  providers: Record<string, unknown>[];
  routes: Record<string, unknown>[];
} {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("invalid config response");
  }
  const keys = Object.keys(value);
  if (!keys.every((key) => key === "version" || key === "providers" || key === "routes")) {
    throw new Error("invalid config response");
  }
  if (!Array.isArray(value.providers) || !Array.isArray(value.routes)) {
    throw new Error("invalid config response");
  }
  return {
    version: 1,
    providers: value.providers.map(assertSafeProvider),
    routes: value.routes.map(assertSafeRoute),
  };
}

function safeConfigEntity(
  value: unknown,
  key: "provider" | "route",
): Record<string, unknown> {
  return {
    [key]: key === "provider" ? assertSafeProvider(value) : assertSafeRoute(value),
  };
}

function configErrorKey(error: unknown): keyof typeof import("./errors.js").API_ERRORS {
  if (error instanceof ApiValidationError) {
    return "invalidConfigRequest";
  }
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "invalid_config_request") {
    return "invalidConfigRequest";
  }
  if (code === "config_persistence_failed") {
    return "configPersistenceFailed";
  }
  // ConfigManager deliberately preserves stable registry error codes for
  // callers that need to distinguish a failed operation.  They are all
  // client/configuration failures at this HTTP boundary, however, and must
  // never become an indistinguishable 500 response.
  if (
    code === "invalid_config_request" ||
    code === "invalid_provider_id" ||
    code === "invalid_provider_name" ||
    code === "invalid_provider_protocol" ||
    code === "invalid_provider_url" ||
    code === "invalid_provider_models" ||
    code === "invalid_provider_enabled" ||
    code === "invalid_credential_ref" ||
    code === "forbidden_provider_field" ||
    code === "duplicate_provider_id" ||
    code === "provider_not_found" ||
    code === "provider_has_routes" ||
    code === "provider_disabled" ||
    code === "invalid_route_id" ||
    code === "invalid_route_name" ||
    code === "invalid_route_model" ||
    code === "invalid_route_enabled" ||
    code === "invalid_fallback_provider_ids" ||
    code === "duplicate_fallback_provider_id" ||
    code === "too_many_fallback_providers" ||
    code === "forbidden_route_field" ||
    code === "duplicate_route_id" ||
    code === "route_not_found" ||
    code === "fallback_provider_not_found" ||
    code === "fallback_model_not_available" ||
    code === "model_not_available"
  ) {
    return "invalidConfigRequest";
  }
  return "serverError";
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded.includes("\0")) {
      return value;
    }
    return decoded;
  } catch {
    // Keep malformed path data opaque. The route handler will pass it through
    // the normal fixed validation/error mapping instead of allowing a native
    // URIError to escape as an HTTP 500.
    return value;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  status: number,
  key: keyof typeof import("./errors.js").API_ERRORS,
): void {
  sendJson(res, status, apiErrorPayload(key));
}

function abortedEvent(turnId: string): AgentEvent {
  return {
    type: "error",
    requestId: turnId,
    code: "aborted",
    message: SAFE_ABORT_MESSAGE,
    retryable: false,
  };
}

function runnerErrorEvent(turnId: string): AgentEvent {
  return {
    type: "error",
    requestId: turnId,
    code: "runner_error",
    message: "Agent runner failed.",
    retryable: false,
  };
}

async function readBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBodyBytes) {
        req.pause();
        finish(() => {
          reject(new ApiValidationError("payloadTooLarge"));
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      finish(() => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("error", () => {
      finish(() => {
        reject(new ApiValidationError("invalidJson"));
      });
    });
  });
}

function parseJsonBody(raw: string): unknown {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiValidationError("invalidJson");
  }
}

interface ActiveTurn {
  readonly controller: AbortController;
  readonly turnId: string;
}

class LocalAgentHttpServer implements LocalAgentApiServer {
  readonly #options: ReturnType<typeof parseApiOptions>;
  readonly #store: LocalAgentSessionStore;
  readonly #active = new Map<string, ActiveTurn>();
  #server: Server | undefined;
  #address: string | undefined;

  constructor(options: LocalAgentApiOptions) {
    this.#options = parseApiOptions(options);
    this.#store = this.#options.store ?? new InMemoryLocalAgentSessionStore();
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) {
      return;
    }
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) {
          sendError(res, 500, "serverError");
        } else {
          res.end();
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (address === null) {
      this.#server = undefined;
      throw new Error("failed to bind");
    }
    const host = address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
    this.#address = `http://${host}:${String(address.port)}`;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    this.#server = undefined;
    for (const turn of this.#active.values()) {
      turn.controller.abort();
    }
    this.#active.clear();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections?.();
    });
    this.#address = undefined;
  }

  address(): string | undefined {
    return this.#address;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/health") {
      if (method !== "GET") {
        sendError(res, 405, "methodNotAllowed");
        return;
      }
      sendJson(res, 200, {
        ok: true,
        service: "agent-workbench-local-api",
        version: 1,
      });
      return;
    }

    if (await this.#handleConfig(req, res, path, method)) {
      return;
    }

    if (path === "/v1/sessions") {
      if (method !== "POST") {
        sendError(res, 405, "methodNotAllowed");
        return;
      }
      await this.#readJson(req, res, () => {
        const session = this.#store.create();
        sendJson(res, 201, { session });
      });
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null) {
      const sessionId = decodePathSegment(sessionMatch[1] ?? "");
      if (method !== "GET") {
        sendError(res, 405, "methodNotAllowed");
        return;
      }
      const session = this.#store.get(sessionId);
      if (session === undefined) {
        sendError(res, 404, "sessionNotFound");
        return;
      }
      sendJson(res, 200, { session });
      return;
    }

    const eventsMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(path);
    if (eventsMatch !== null) {
      const sessionId = decodePathSegment(eventsMatch[1] ?? "");
      if (method !== "GET") {
        sendError(res, 405, "methodNotAllowed");
        return;
      }
      if (this.#store.get(sessionId) === undefined) {
        sendError(res, 404, "sessionNotFound");
        return;
      }
      sendJson(res, 200, {
        sessionId,
        events: this.#store.listEvents(sessionId),
      });
      return;
    }

    const cancelMatch = /^\/v1\/sessions\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch !== null) {
      const sessionId = decodePathSegment(cancelMatch[1] ?? "");
      if (method !== "POST") {
        sendError(res, 405, "methodNotAllowed");
        return;
      }
      if (this.#store.get(sessionId) === undefined) {
        sendError(res, 404, "sessionNotFound");
        return;
      }
      const active = this.#active.get(sessionId);
      if (active === undefined) {
        sendJson(res, 200, {
          ok: true,
          code: "not_running",
          message: "No turn is running.",
        });
        return;
      }
      active.controller.abort();
      sendJson(res, 200, { ok: true, code: "cancelling" });
      return;
    }

    const turnMatch = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
    if (turnMatch !== null) {
      const sessionId = decodePathSegment(turnMatch[1] ?? "");
      if (method !== "POST") {
        sendError(res, 405, "methodNotAllowed");
        return;
      }
      await this.#handleTurn(req, res, sessionId);
      return;
    }

    sendError(res, 404, "notFound");
  }

  async #readJson(
    req: IncomingMessage,
    res: ServerResponse,
    onBody: (body: unknown) => void | Promise<void>,
  ): Promise<void> {
    try {
      const raw = await readBody(req, this.#options.maxBodyBytes);
      const body = parseJsonBody(raw);
      await onBody(body);
    } catch (error) {
      if (error instanceof ApiValidationError) {
        sendJson(res, error.payload.error.code === "payload_too_large" ? 413 : 400, error.payload);
        return;
      }
      sendError(res, 400, "invalidJson");
    }
  }

  async #handleConfig(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
  ): Promise<boolean> {
    const isConfigPath =
      path === "/v1/config" ||
      path === "/v1/providers" ||
      /^\/v1\/providers\/[^/]+$/.test(path) ||
      path === "/v1/routes" ||
      /^\/v1\/routes\/[^/]+$/.test(path);
    if (!isConfigPath) {
      return false;
    }

    const manager: LocalAgentConfigManager | undefined = this.#options.configManager;
    if (manager === undefined) {
      sendError(res, 503, "configurationUnavailable");
      return true;
    }

    const sendConfigFailure = (error: unknown): void => {
      const key = configErrorKey(error);
      const status = key === "invalidConfigRequest" ? 400 : 500;
      sendError(res, status, key);
    };

    if (path === "/v1/config") {
      if (method !== "GET") {
        sendError(res, 405, "methodNotAllowed");
        return true;
      }
      try {
        sendJson(res, 200, safeConfigSnapshot(manager.getSnapshot()));
      } catch (error) {
        sendConfigFailure(error);
      }
      return true;
    }

    if (path === "/v1/providers" && method === "POST") {
      await this.#readJson(req, res, async (body) => {
        try {
          assertNoConfigSecrets(body);
          if (!isRecord(body)) {
            throw new ApiValidationError("invalidConfigRequest");
          }
          sendJson(res, 201, safeConfigEntity(await manager.createProvider(body), "provider"));
        } catch (error) {
          sendConfigFailure(error);
        }
      });
      return true;
    }
    if (path === "/v1/routes" && method === "POST") {
      await this.#readJson(req, res, async (body) => {
        try {
          assertNoConfigSecrets(body);
          if (!isRecord(body)) {
            throw new ApiValidationError("invalidConfigRequest");
          }
          sendJson(res, 201, safeConfigEntity(await manager.createRoute(body), "route"));
        } catch (error) {
          sendConfigFailure(error);
        }
      });
      return true;
    }

    const providerMatch = /^\/v1\/providers\/([^/]+)$/.exec(path);
    if (providerMatch !== null) {
      const id = decodePathSegment(providerMatch[1] ?? "");
      if (method === "DELETE") {
        try {
          await manager.deleteProvider(id);
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendConfigFailure(error);
        }
        return true;
      }
      if (method === "PUT") {
        await this.#readJson(req, res, async (body) => {
          try {
            assertNoConfigSecrets(body);
            if (!isRecord(body) || body.id !== id) {
              throw new ApiValidationError("invalidConfigRequest");
            }
            sendJson(res, 200, safeConfigEntity(await manager.updateProvider(body), "provider"));
          } catch (error) {
            sendConfigFailure(error);
          }
        });
        return true;
      }
      sendError(res, 405, "methodNotAllowed");
      return true;
    }

    const routeMatch = /^\/v1\/routes\/([^/]+)$/.exec(path);
    if (routeMatch !== null) {
      const id = decodePathSegment(routeMatch[1] ?? "");
      if (method === "DELETE") {
        try {
          await manager.deleteRoute(id);
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendConfigFailure(error);
        }
        return true;
      }
      if (method === "PUT") {
        await this.#readJson(req, res, async (body) => {
          try {
            assertNoConfigSecrets(body);
            if (!isRecord(body) || body.id !== id) {
              throw new ApiValidationError("invalidConfigRequest");
            }
            sendJson(res, 200, safeConfigEntity(await manager.updateRoute(body), "route"));
          } catch (error) {
            sendConfigFailure(error);
          }
        });
        return true;
      }
      sendError(res, 405, "methodNotAllowed");
      return true;
    }

    sendError(res, 405, "methodNotAllowed");
    return true;
  }

  async #handleTurn(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (this.#store.get(sessionId) === undefined) {
      sendError(res, 404, "sessionNotFound");
      return;
    }
    if (this.#active.has(sessionId)) {
      sendJson(res, 409, apiErrorPayload("sessionBusy"));
      return;
    }

    let body: unknown;
    try {
      const raw = await readBody(req, this.#options.maxBodyBytes);
      body = parseJsonBody(raw);
    } catch (error) {
      if (error instanceof ApiValidationError) {
        sendJson(
          res,
          error.payload.error.code === "payload_too_large" ? 413 : 400,
          error.payload,
        );
        return;
      }
      sendError(res, 400, "invalidJson");
      return;
    }

    let turnRequest;
    try {
      turnRequest = parseTurnRequest(body);
    } catch (error) {
      if (error instanceof ApiValidationError) {
        sendJson(res, 400, error.payload);
        return;
      }
      sendError(res, 400, "invalidRequest");
      return;
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    this.#active.set(sessionId, { controller, turnId });
    this.#store.setStatus(sessionId, "running", turnId);

    const onClientClose = () => {
      controller.abort();
    };
    req.on("aborted", onClientClose);
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-agent-turn-id": turnId,
    });

    let sawTerminal = false;
    // The last terminal event decides the session's final status: a streamed
    // terminal `error` must not be reported as `completed`.
    let lastTerminalEvent: AgentEvent | undefined;
    let stream: AsyncIterable<AgentEvent> | undefined;
    let iterator: AsyncIterator<AgentEvent> | undefined;

    const emit = (event: AgentEvent) => {
      if (sawTerminal) {
        return;
      }
      this.#store.appendEvent(sessionId, event);
      writeNdjsonLine(res, event);
      if (event.type === "completed" || event.type === "error") {
        sawTerminal = true;
        lastTerminalEvent = event;
      }
    };

    const finish = (status: "completed" | "cancelled" | "failed") => {
      this.#active.delete(sessionId);
      this.#store.setStatus(sessionId, status);
      if (!res.writableEnded) {
        res.end();
      }
      req.off("aborted", onClientClose);
    };

    try {
      if (controller.signal.aborted) {
        emit(abortedEvent(turnId));
        finish("cancelled");
        return;
      }

      stream = await this.#options.runner.run({
        sessionId,
        turnId,
        messages: turnRequest.messages,
        tools: turnRequest.tools ?? [],
        routeId: turnRequest.routeId,
        model: turnRequest.model,
        maxTokens: turnRequest.maxTokens,
        signal: controller.signal,
      });

      iterator = stream[Symbol.asyncIterator]();

      while (!sawTerminal) {
        if (controller.signal.aborted) {
          emit(abortedEvent(turnId));
          finish("cancelled");
          await this.#release(iterator);
          return;
        }

        const nextPromise = iterator.next();
        const raced = await Promise.race([
          nextPromise.then(
            (result) => ({ kind: "next" as const, result }),
            (error: unknown) => ({ kind: "throw" as const, error }),
          ),
          new Promise<{ kind: "abort" }>((resolve) => {
            if (controller.signal.aborted) {
              resolve({ kind: "abort" });
              return;
            }
            controller.signal.addEventListener("abort", () => resolve({ kind: "abort" }), {
              once: true,
            });
          }),
        ]);

        if (raced.kind === "abort") {
          // Swallow a late next() so it cannot become an unhandled rejection.
          void nextPromise.then(
            () => undefined,
            () => undefined,
          );
          emit(abortedEvent(turnId));
          finish("cancelled");
          await this.#release(iterator);
          return;
        }

        if (raced.kind === "throw") {
          emit(runnerErrorEvent(turnId));
          finish("failed");
          await this.#release(iterator);
          return;
        }

        if (raced.result.done === true) {
          finish("completed");
          await this.#release(iterator);
          return;
        }

        emit(raced.result.value);
      }

      if (lastTerminalEvent?.type === "error") {
        // A terminal error event decides the final status: aborted errors
        // mean the turn was cancelled, everything else failed.
        finish(lastTerminalEvent.code === "aborted" ? "cancelled" : "failed");
        await this.#release(iterator);
        return;
      }
      finish("completed");
      await this.#release(iterator);
    } catch {
      if (iterator !== undefined) {
        await this.#release(iterator);
      }
      emit(runnerErrorEvent(turnId));
      finish("failed");
    }
  }

  async #release(iterator: AsyncIterator<AgentEvent> | undefined): Promise<void> {
    if (iterator === undefined) {
      return;
    }
    try {
      const returned = iterator.return?.();
      if (returned !== undefined) {
        await Promise.race([
          returned.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => setTimeout(resolve, 0)),
        ]);
      }
    } catch {
      // ignore
    }
  }
}

export function createLocalAgentApiServer(
  options: LocalAgentApiOptions,
): LocalAgentApiServer {
  return new LocalAgentHttpServer(options);
}
