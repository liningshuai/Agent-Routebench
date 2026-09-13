import { validateAgentEvent } from "@agent-workbench/local-agent-client";
import type { AgentEvent } from "@agent-workbench/agent-core";
import {
  validateAgentMessages,
  validateAgentToolDefinitions,
} from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";
import { createDesktopError } from "./errors.js";
import type { DesktopApiClient } from "./types.js";

export const TAURI_COMMANDS = Object.freeze({
  health: "agent_health",
  createSession: "agent_create_session",
  startTurn: "agent_start_turn",
  cancelTurn: "agent_cancel_turn",
  getConfig: "agent_get_config",
  createProvider: "agent_create_provider",
  updateProvider: "agent_update_provider",
  deleteProvider: "agent_delete_provider",
  createRoute: "agent_create_route",
  updateRoute: "agent_update_route",
  deleteRoute: "agent_delete_route",
} as const);

export const TAURI_EVENTS = Object.freeze({
  turnEvent: "agent_turn_event",
} as const);

export interface TauriEvent<T> {
  readonly payload: T;
}

export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type TauriUnlisten = () => void | Promise<void>;

export type TauriListen = <T>(
  eventName: string,
  handler: (event: TauriEvent<T>) => void,
) => Promise<TauriUnlisten>;

export interface TauriDesktopApiClientOptions {
  readonly invoke: TauriInvoke;
  readonly listen: TauriListen;
}

interface RecordLike {
  readonly [key: string]: unknown;
}

interface TauriTurnEventPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly event: unknown;
}

const ABORT = Symbol("tauri_abort");
const TURN_FIELDS = new Set([
  "messages",
  "tools",
  "routeId",
  "model",
  "maxTokens",
]);

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCallableMethod(value: unknown, name: string): boolean {
  return isRecord(value) && typeof value[name] === "function";
}

function assertBridgeOptions(
  options: unknown,
): asserts options is TauriDesktopApiClientOptions {
  if (
    !isRecord(options) ||
    !hasCallableMethod(options, "invoke") ||
    !hasCallableMethod(options, "listen")
  ) {
    throw createDesktopError("CONNECTION_FAILED");
  }
}

function assertAbortSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (!isRecord(signal) ||
      typeof signal.aborted !== "boolean" ||
      !hasCallableMethod(signal, "addEventListener") ||
      !hasCallableMethod(signal, "removeEventListener"))
  ) {
    throw createDesktopError("TURN_FAILED");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  assertAbortSignal(signal);
  if (signal?.aborted === true) {
    throw new Error("Request aborted.");
  }
}

function consumeLate<T>(operation: Promise<T>): void {
  void operation.catch(() => undefined);
}

async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  consumeLate(operation);
  if (signal === undefined) {
    return operation;
  }
  if (signal.aborted) {
    throw ABORT;
  }

  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(ABORT);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isAbortFailure(error: unknown): boolean {
  return error === ABORT || (error instanceof Error && error.message === "Request aborted.");
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid");
  }
}

function parseSession(value: unknown): LocalAgentSession {
  if (!isRecord(value)) {
    throw new Error("invalid");
  }
  const candidate = isRecord(value.session) ? value.session : value;
  if (Object.hasOwn(value, "session") && Object.keys(value).length !== 1) {
    throw new Error("invalid");
  }
  const keys = Object.keys(candidate);
  const allowed = new Set(["id", "status", "createdAt", "updatedAt", "activeTurnId"]);
  if (keys.some((key) => !allowed.has(key))) {
    throw new Error("invalid");
  }
  assertNonEmptyString(candidate.id);
  if (
    candidate.status !== "idle" &&
    candidate.status !== "running" &&
    candidate.status !== "completed" &&
    candidate.status !== "cancelled" &&
    candidate.status !== "failed"
  ) {
    throw new Error("invalid");
  }
  if (
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    throw new Error("invalid");
  }
  if (
    candidate.activeTurnId !== undefined &&
    (typeof candidate.activeTurnId !== "string" || candidate.activeTurnId.length === 0)
  ) {
    throw new Error("invalid");
  }
  return {
    id: candidate.id,
    status: candidate.status,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    ...(candidate.activeTurnId === undefined
      ? {}
      : { activeTurnId: candidate.activeTurnId }),
  };
}

function cloneTurnRequest(request: LocalAgentTurnRequest): Record<string, unknown> {
  const cloneValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(cloneValue);
    }
    if (isRecord(value)) {
      const copy: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        copy[key] = cloneValue(nested);
      }
      return copy;
    }
    return value;
  };
  const copy: Record<string, unknown> = {
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block) => cloneValue(block)),
    })),
  };
  if (request.tools !== undefined) {
    copy.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: cloneValue(tool.inputSchema),
    }));
  }
  if (request.routeId !== undefined) copy.routeId = request.routeId;
  if (request.model !== undefined) copy.model = request.model;
  if (request.maxTokens !== undefined) copy.maxTokens = request.maxTokens;
  return copy;
}

function assertSafeTurnRequest(request: unknown): asserts request is LocalAgentTurnRequest {
  if (!isRecord(request)) {
    throw new Error("invalid");
  }
  if (Object.keys(request).some((key) => !TURN_FIELDS.has(key))) {
    throw new Error("invalid");
  }
  validateAgentMessages(request.messages as never);
  if (request.tools !== undefined) {
    validateAgentToolDefinitions(request.tools as never);
  }
  for (const field of ["routeId", "model"] as const) {
    if (request[field] !== undefined) {
      assertNonEmptyString(request[field]);
    }
  }
  if (
    request.maxTokens !== undefined &&
    (typeof request.maxTokens !== "number" ||
      !Number.isSafeInteger(request.maxTokens) ||
      request.maxTokens <= 0)
  ) {
    throw new Error("invalid");
  }
}

function parseTurnId(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new Error("invalid");
  }
  assertNonEmptyString(value.turnId);
  return value.turnId;
}

function parseTurnEventPayload(value: unknown): TauriTurnEventPayload {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new Error("invalid");
  }
  assertNonEmptyString(value.sessionId);
  assertNonEmptyString(value.turnId);
  return {
    sessionId: value.sessionId,
    turnId: value.turnId,
    event: value.event,
  };
}

class AsyncEventQueue<T> {
  #values: T[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failure: unknown = undefined;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    this.#drain();
  }

  fail(error: unknown): void {
    if (this.#closed && this.#failure === undefined) {
      this.#failure = error;
    } else if (!this.#closed) {
      this.#failure = error;
      this.#closed = true;
    }
    this.#drain();
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      return Promise.resolve({ done: false, value: this.#values.shift() as T });
    }
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  #drain(): void {
    if (this.#values.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value: this.#values.shift() as T });
      }
    }
    if (this.#values.length > 0) return;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift() as {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
      };
      if (this.#failure !== undefined) {
        waiter.reject(this.#failure);
      } else if (this.#closed) {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }
}

export class TauriDesktopApiClient implements DesktopApiClient {
  readonly #invoke: TauriInvoke;
  readonly #listen: TauriListen;

  constructor(options: TauriDesktopApiClientOptions) {
    assertBridgeOptions(options);
    this.#invoke = options.invoke.bind(options);
    this.#listen = options.listen.bind(options);
  }

  async load(): Promise<void> {
    try {
      const value = await this.#invoke<unknown>(TAURI_COMMANDS.health);
      if (!isRecord(value) || value.ok !== true) {
        throw new Error("invalid");
      }
    } catch {
      throw createDesktopError("CONNECTION_FAILED");
    }
  }

  async createSession(): Promise<LocalAgentSession> {
    try {
      return parseSession(
        await this.#invoke<unknown>(TAURI_COMMANDS.createSession),
      );
    } catch {
      throw createDesktopError("SESSION_CREATE_FAILED");
    }
  }

  async *submitTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const queue = new AsyncEventQueue<AgentEvent>();
    let unlisten: TauriUnlisten | undefined;
    let cleanupRequested = false;
    let released = false;
    let release: ((candidate: TauriUnlisten) => void) | undefined;
    let activeTurnId = "";

    try {
      throwIfAborted(signal);
      assertNonEmptyString(sessionId);
      assertSafeTurnRequest(request);

      let listenPromise: Promise<TauriUnlisten>;
      try {
        listenPromise = Promise.resolve(this.#listen<TauriTurnEventPayload>(
          TAURI_EVENTS.turnEvent,
          (envelope) => {
            try {
              if (!isRecord(envelope.payload)) {
                queue.fail(createDesktopError("TURN_FAILED"));
                return;
              }
              if (
                envelope.payload.sessionId !== sessionId ||
                envelope.payload.turnId !== activeTurnId
              ) {
                return;
              }
              const payload = parseTurnEventPayload(envelope.payload);
              if (payload.sessionId !== sessionId) return;
              const event = validateAgentEvent(payload.event);
              if (payload.turnId !== activeTurnId) return;
              const safeEvent = event.type === "error"
                ? {
                    ...event,
                    message: event.code === "aborted"
                      ? "Request aborted."
                      : "Model gateway request failed.",
                  }
                : event;
              queue.push(safeEvent);
              if (safeEvent.type === "completed" || safeEvent.type === "error") {
                queue.close();
              }
            } catch {
              queue.fail(createDesktopError("TURN_FAILED"));
            }
          },
        ));
      } catch {
        throw createDesktopError("TURN_FAILED");
      }

      release = (candidate: TauriUnlisten): void => {
        if (released) return;
        released = true;
        try {
          void Promise.resolve(candidate()).catch(() => undefined);
        } catch {
          // Host cleanup errors never escape the renderer boundary.
        }
      };

      listenPromise.then((candidate) => {
        if (cleanupRequested) release?.(candidate);
      }).catch(() => undefined);

      try {
        unlisten = await raceAbort(listenPromise, signal);
      } catch (error) {
        if (isAbortFailure(error)) throw new Error("Request aborted.");
        throw error;
      }

      let startPromise: Promise<unknown>;
      try {
        startPromise = Promise.resolve(this.#invoke<unknown>(TAURI_COMMANDS.startTurn, {
          sessionId,
          request: cloneTurnRequest(request),
        }));
      } catch {
        throw createDesktopError("TURN_FAILED");
      }
      try {
        activeTurnId = await raceAbort(startPromise, signal).then(parseTurnId);
      } catch (error) {
        if (isAbortFailure(error)) throw new Error("Request aborted.");
        throw error;
      }

      for (;;) {
        throwIfAborted(signal);
        let result: IteratorResult<AgentEvent>;
        try {
          result = await raceAbort(queue.next(), signal);
        } catch (error) {
          if (isAbortFailure(error)) throw new Error("Request aborted.");
          throw error;
        }
        if (result.done) return;
        yield result.value;
      }
    } catch (error) {
      if (isAbortFailure(error) || signal?.aborted === true) {
        throw new Error("Request aborted.");
      }
      throw createDesktopError("TURN_FAILED");
    } finally {
      cleanupRequested = true;
      queue.close();
      if (unlisten) release?.(unlisten);
    }
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    try {
      assertNonEmptyString(sessionId);
      assertNonEmptyString(turnId);
      await this.#invoke(TAURI_COMMANDS.cancelTurn, { sessionId, turnId });
    } catch {
      throw createDesktopError("CANCEL_FAILED");
    }
  }
}

export function createTauriDesktopApiClient(
  options: TauriDesktopApiClientOptions,
): DesktopApiClient {
  return new TauriDesktopApiClient(options);
}
