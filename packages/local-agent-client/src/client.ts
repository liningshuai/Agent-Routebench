import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";
import {
  failLocalAgentClient,
  LocalAgentClientError,
} from "./errors.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  type LocalAgentClientOptions,
  type LocalAgentFetch,
} from "./types.js";
import { encodePathSegment, normalizeLoopbackBaseUrl } from "./url.js";
import { parseNDJSONStream, validateAgentEvent } from "./ndjson.js";

const TURN_FIELDS = new Set(["messages", "tools", "routeId", "model", "maxTokens"]);

const DEFAULT_FETCH: LocalAgentFetch = (url, init) => {
  if (typeof globalThis.fetch !== "function") {
    failLocalAgentClient("apiUnavailable");
  }
  return globalThis.fetch(url, init);
};

const ABORTED = Symbol("aborted");

function releaseBody(response: Response): void {
  const cancel = response.body?.cancel();
  if (cancel !== undefined) {
    void cancel.catch(() => undefined);
  }
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    failLocalAgentClient("aborted");
  }
}

async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) {
    return operation;
  }
  if (signal.aborted) {
    operation.catch(() => undefined);
    return ABORTED;
  }
  let onAbort!: () => void;
  const abortPromise = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const result = await Promise.race([operation, abortPromise]);
  signal.removeEventListener("abort", onAbort);
  return result;
}

async function readBodyText(
  response: Response,
  signal: AbortSignal | undefined,
  maxBodyBytes: number,
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let total = 0;
  try {
    for (;;) {
      checkAbort(signal);
      const read = reader.read();
      read.catch(() => undefined);
      const result = await raceAbort(read, signal);
      if (result === ABORTED) {
        void reader.cancel().catch(() => undefined);
        failLocalAgentClient("aborted");
      }
      if (result.done === true) {
        try {
          return text + decoder.decode();
        } catch {
          failLocalAgentClient("apiProtocolError");
        }
      }
      if (!isUint8Array(result.value)) {
        failLocalAgentClient("apiProtocolError");
      }
      total += result.value.byteLength;
      if (total > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        failLocalAgentClient("streamTooLarge");
      }
      try {
        text += decoder.decode(result.value, { stream: true });
      } catch {
        failLocalAgentClient("apiProtocolError");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

export class LocalAgentApiClient {
  readonly #baseUrl: string;
  readonly #fetch: LocalAgentFetch;
  readonly #maxLineBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxBodyBytes: number;

  constructor(baseUrl: string, fetchImpl?: LocalAgentFetch);
  constructor(options: LocalAgentClientOptions);
  constructor(
    baseUrlOrOptions: string | LocalAgentClientOptions,
    fetchImpl?: LocalAgentFetch,
  ) {
    const options = typeof baseUrlOrOptions === "string"
      ? { baseUrl: baseUrlOrOptions, fetch: fetchImpl }
      : baseUrlOrOptions;
    this.#baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? DEFAULT_FETCH;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (
      !Number.isSafeInteger(this.#maxLineBytes) ||
      this.#maxLineBytes <= 0 ||
      this.#maxLineBytes > DEFAULT_MAX_TOTAL_BYTES ||
      !Number.isSafeInteger(this.#maxTotalBytes) ||
      this.#maxTotalBytes <= 0 ||
      this.#maxTotalBytes > DEFAULT_MAX_TOTAL_BYTES ||
      !Number.isSafeInteger(this.#maxBodyBytes) ||
      this.#maxBodyBytes <= 0 ||
      this.#maxBodyBytes > DEFAULT_MAX_TOTAL_BYTES
    ) {
      failLocalAgentClient("invalidArguments");
    }
  }

  health(signal?: AbortSignal): Promise<unknown> {
    return this.#fetchJson("GET", "/health", undefined, signal);
  }

  async createSession(signal?: AbortSignal): Promise<LocalAgentSession> {
    return this.#validateSession(
      await this.#fetchJson("POST", "/v1/sessions", {}, signal),
    );
  }

  async getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<LocalAgentSession> {
    const value = await this.#fetchJson(
      "GET",
      `/v1/sessions/${encodePathSegment(sessionId)}`,
      undefined,
      signal,
    );
    return this.#validateSession(value);
  }

  async listEvents(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentEvent[]> {
    const value = await this.#fetchJson(
      "GET",
      `/v1/sessions/${encodePathSegment(sessionId)}/events`,
      undefined,
      signal,
    );
    const events = Array.isArray(value)
      ? value
      : this.#isRecord(value) && Array.isArray(value.events)
        ? value.events
        : undefined;
    if (events === undefined) {
      failLocalAgentClient("apiProtocolError");
    }
    return events.map(validateAgentEvent);
  }

  async *runTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    checkAbort(signal);
    const body = this.#serializeTurnRequest(request);
    const response = await this.#fetchResponse(
      `${this.#baseUrl}/v1/sessions/${encodePathSegment(sessionId)}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      },
      signal,
    );
    if (!response.ok) {
      releaseBody(response);
      failLocalAgentClient("apiHttpError");
    }
    if (response.body === null) {
      failLocalAgentClient("apiProtocolError");
    }
    yield* parseNDJSONStream(response.body, signal, {
      maxLineBytes: this.#maxLineBytes,
      maxTotalBytes: this.#maxTotalBytes,
    });
  }

  cancel(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.#fetchJson(
      "POST",
      `/v1/sessions/${encodePathSegment(sessionId)}/cancel`,
      {},
      signal,
    );
  }

  async #fetchJson(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const response = await this.#fetchResponse(
      `${this.#baseUrl}${path}`,
      {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : this.#serializeJson(body),
        signal,
      },
      signal,
    );
    if (!response.ok) {
      releaseBody(response);
      failLocalAgentClient("apiHttpError");
    }
    let text: string;
    try {
      text = await readBodyText(response, signal, this.#maxBodyBytes);
    } catch (error) {
      if (error instanceof LocalAgentClientError) {
        throw error;
      }
      failLocalAgentClient("apiProtocolError");
    }
    try {
      return JSON.parse(text);
    } catch {
      failLocalAgentClient("apiProtocolError");
    }
  }

  async #fetchResponse(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    checkAbort(signal);
    let operation: Promise<Response>;
    try {
      operation = Promise.resolve(this.#fetch(url, init));
    } catch {
      failLocalAgentClient("apiUnavailable");
    }
    operation = operation.then(
      (response) => {
        if (signal?.aborted) {
          releaseBody(response);
        }
        return response;
      },
      () => {
        if (signal?.aborted) {
          return Promise.reject(new LocalAgentClientError("aborted"));
        }
        return Promise.reject(new LocalAgentClientError("apiUnavailable"));
      },
    );
    const result = await raceAbort(operation, signal);
    if (result === ABORTED) {
      operation.catch(() => undefined);
      failLocalAgentClient("aborted");
    }
    return result;
  }

  #serializeTurnRequest(request: LocalAgentTurnRequest): string {
    if (!this.#isRecord(request) || !Array.isArray(request.messages)) {
      failLocalAgentClient("invalidArguments");
    }
    if (Object.keys(request).some((key) => !TURN_FIELDS.has(key))) {
      failLocalAgentClient("invalidArguments");
    }
    try {
      return this.#serializeJson(request);
    } catch {
      failLocalAgentClient("invalidArguments");
    }
  }

  #serializeJson(value: unknown): string {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        failLocalAgentClient("invalidArguments");
      }
      return serialized;
    } catch {
      failLocalAgentClient("invalidArguments");
    }
  }

  #validateSession(value: unknown): LocalAgentSession {
    const candidate = this.#isRecord(value) && "session" in value ? value.session : value;
    if (!this.#isRecord(candidate)) {
      failLocalAgentClient("apiProtocolError");
    }
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.status !== "string" ||
      !Number.isFinite(candidate.createdAt) ||
      !Number.isFinite(candidate.updatedAt) ||
      (candidate.activeTurnId !== undefined && typeof candidate.activeTurnId !== "string")
    ) {
      failLocalAgentClient("apiProtocolError");
    }
    return { ...candidate } as unknown as LocalAgentSession;
  }

  #isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export function createLocalAgentApiClient(
  options: LocalAgentClientOptions,
): LocalAgentApiClient {
  return new LocalAgentApiClient(options);
}
