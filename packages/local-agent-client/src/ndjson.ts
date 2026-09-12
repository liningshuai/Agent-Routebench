import type { AgentEvent } from "@agent-workbench/agent-core";
import {
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  type NDJSONLimits,
} from "./types.js";
import { failLocalAgentClient } from "./errors.js";

const TERMINAL_TYPES = new Set<AgentEvent["type"]>(["completed", "error"]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function readWithAbort<T>(
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
  const abort = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const result = await Promise.race([operation, abort]);
  signal.removeEventListener("abort", onAbort);
  return result;
}

const ABORTED = Symbol("aborted");

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    failLocalAgentClient("aborted");
  }
}

export function parseNDJSONStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limits?: Partial<NDJSONLimits>,
): AsyncIterable<AgentEvent>;
export function parseNDJSONStream(
  stream: ReadableStream<Uint8Array>,
  limits: Partial<NDJSONLimits>,
): AsyncIterable<AgentEvent>;
export async function* parseNDJSONStream(
  stream: ReadableStream<Uint8Array>,
  signalOrLimits?: AbortSignal | Partial<NDJSONLimits>,
  limits: Partial<NDJSONLimits> = {},
): AsyncIterable<AgentEvent> {
  const signal = isAbortSignalLike(signalOrLimits) ? signalOrLimits : undefined;
  const effectiveLimits: Partial<NDJSONLimits> = signal === undefined
    ? (signalOrLimits ?? {}) as Partial<NDJSONLimits>
    : limits;
  const maxLineBytes = effectiveLimits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxTotalBytes = effectiveLimits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maxLineBytes) ||
    maxLineBytes <= 0 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes <= 0
  ) {
    failLocalAgentClient("invalidArguments");
  }

  checkAbort(signal);
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  let terminated = false;

  try {
    for (;;) {
      checkAbort(signal);
      const readPromise = reader.read();
      readPromise.catch(() => undefined);
      const result = await readWithAbort(readPromise, signal);
      if (result === ABORTED) {
        void reader.cancel().catch(() => undefined);
        failLocalAgentClient("aborted");
      }

      if (result.done === true) {
        try {
          buffer += decoder.decode();
        } catch {
          failLocalAgentClient("apiProtocolError");
        }
        if (buffer.length > 0 || !terminated) {
          failLocalAgentClient("apiProtocolError");
        }
        return;
      }

      if (!isUint8Array(result.value)) {
        failLocalAgentClient("apiProtocolError");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxTotalBytes) {
        failLocalAgentClient("streamTooLarge");
      }

      let decoded: string;
      try {
        decoded = decoder.decode(result.value, { stream: true });
      } catch {
        failLocalAgentClient("apiProtocolError");
      }
      buffer += decoded;
      if (byteLength(buffer) > maxLineBytes && !buffer.includes("\n")) {
        failLocalAgentClient("streamTooLarge");
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (byteLength(buffer) > maxLineBytes) {
        failLocalAgentClient("streamTooLarge");
      }

      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) {
          continue;
        }
        if (byteLength(line) > maxLineBytes) {
          failLocalAgentClient("streamTooLarge");
        }
        if (terminated) {
          failLocalAgentClient("apiProtocolError");
        }

        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          failLocalAgentClient("apiProtocolError");
        }
        const event = validateAgentEvent(value);
        yield event;
        if (TERMINAL_TYPES.has(event.type)) {
          terminated = true;
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function"
  );
}

export function validateAgentEvent(value: unknown): AgentEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failLocalAgentClient("apiProtocolError");
  }
  const object = value as Record<string, unknown>;
  const type = object.type;
  if (type === "route_selected") {
    exactFields(object, ["type", "requestId", "routeId", "model"]);
    stringField(object.requestId);
    stringField(object.routeId);
    stringField(object.model);
    return object as unknown as AgentEvent;
  }
  if (type === "text_delta") {
    exactFields(object, ["type", "requestId", "text"]);
    stringField(object.requestId);
    stringField(object.text);
    return object as unknown as AgentEvent;
  }
  if (type === "tool_call") {
    exactFields(object, ["type", "requestId", "id", "name", "input"]);
    stringField(object.requestId);
    stringField(object.id);
    stringField(object.name);
    if (typeof object.input !== "object" || object.input === null || Array.isArray(object.input)) {
      failLocalAgentClient("apiProtocolError");
    }
    return object as unknown as AgentEvent;
  }
  if (type === "usage") {
    exactFields(object, ["type", "requestId", "inputTokens", "outputTokens"]);
    stringField(object.requestId);
    finiteNumberField(object.inputTokens);
    finiteNumberField(object.outputTokens);
    return object as unknown as AgentEvent;
  }
  if (type === "completed") {
    exactFields(object, ["type", "requestId"]);
    stringField(object.requestId);
    return object as unknown as AgentEvent;
  }
  if (type === "error") {
    exactFields(object, ["type", "requestId", "code", "message", "retryable"]);
    stringField(object.requestId);
    stringField(object.code);
    stringField(object.message);
    if (typeof object.retryable !== "boolean") {
      failLocalAgentClient("apiProtocolError");
    }
    return object as unknown as AgentEvent;
  }
  failLocalAgentClient("apiProtocolError");
}

function exactFields(object: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(object);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(object, field))) {
    failLocalAgentClient("apiProtocolError");
  }
}

function stringField(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    failLocalAgentClient("apiProtocolError");
  }
}

function finiteNumberField(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failLocalAgentClient("apiProtocolError");
  }
}
