import type { AgentEvent } from "@agent-workbench/agent-core";
import { failCli } from "./errors.js";

const MAX_LINE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const TERMINATING_TYPES = new Set(["completed", "error"]);

export async function* parseNDJSONStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  if (signal?.aborted) {
    failCli("aborted");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let totalBytes = 0;
  let lastEventType: string | undefined;
  let terminated = false;

  const abortHandler = () => {
    reader.cancel().catch(() => {});
  };

  try {
    signal?.addEventListener("abort", abortHandler);

    while (true) {
      if (signal?.aborted) {
        failCli("aborted");
      }

      const { done, value } = await reader.read();

      if (done) {
        if (buffer.length > 0) {
          failCli("apiProtocolError");
        }
        if (!terminated) {
          failCli("apiProtocolError");
        }
        break;
      }

      totalBytes += value.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        failCli("streamTooLarge");
      }

      let chunk: string;
      try {
        chunk = decoder.decode(value, { stream: true });
      } catch {
        failCli("apiProtocolError");
      }

      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      if (buffer.length > MAX_LINE_BYTES) {
        failCli("streamTooLarge");
      }

      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }

        if (line.length > MAX_LINE_BYTES) {
          failCli("streamTooLarge");
        }

        if (terminated) {
          failCli("apiProtocolError");
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          failCli("apiProtocolError");
        }

        const event = validateAgentEvent(parsed);
        yield event;

        if (TERMINATING_TYPES.has(event.type)) {
          terminated = true;
        }
        lastEventType = event.type;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    reader.releaseLock();
  }
}

function validateAgentEvent(value: unknown): AgentEvent {
  if (!value || typeof value !== "object") {
    failCli("apiProtocolError");
  }

  const obj = value as Record<string, unknown>;
  const { type } = obj;

  if (type === "route_selected") {
    validateFields(obj, ["type", "requestId", "routeId", "model"]);
    validateString(obj.requestId, "requestId");
    validateString(obj.routeId, "routeId");
    validateString(obj.model, "model");
    return obj as AgentEvent;
  }

  if (type === "text_delta") {
    validateFields(obj, ["type", "requestId", "text"]);
    validateString(obj.requestId, "requestId");
    validateString(obj.text, "text");
    return obj as AgentEvent;
  }

  if (type === "tool_call") {
    validateFields(obj, ["type", "requestId", "id", "name", "input"]);
    validateString(obj.requestId, "requestId");
    validateString(obj.id, "id");
    validateString(obj.name, "name");
    return obj as AgentEvent;
  }

  if (type === "usage") {
    validateFields(obj, ["type", "requestId", "inputTokens", "outputTokens"]);
    validateString(obj.requestId, "requestId");
    validateNumber(obj.inputTokens, "inputTokens");
    validateNumber(obj.outputTokens, "outputTokens");
    return obj as AgentEvent;
  }

  if (type === "completed") {
    validateFields(obj, ["type", "requestId"]);
    validateString(obj.requestId, "requestId");
    return obj as AgentEvent;
  }

  if (type === "error") {
    validateFields(obj, ["type", "requestId", "code", "message", "retryable"]);
    validateString(obj.requestId, "requestId");
    validateString(obj.code, "code");
    validateString(obj.message, "message");
    validateBoolean(obj.retryable, "retryable");
    return obj as AgentEvent;
  }

  failCli("apiProtocolError");
}

function validateFields(
  obj: Record<string, unknown>,
  required: readonly string[],
): void {
  const keys = Object.keys(obj);
  if (keys.length !== required.length) {
    failCli("apiProtocolError");
  }
  for (const key of required) {
    if (!(key in obj)) {
      failCli("apiProtocolError");
    }
  }
}

function validateString(value: unknown, _field: string): asserts value is string {
  if (typeof value !== "string") {
    failCli("apiProtocolError");
  }
}

function validateNumber(value: unknown, _field: string): asserts value is number {
  if (typeof value !== "number") {
    failCli("apiProtocolError");
  }
}

function validateBoolean(value: unknown, _field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    failCli("apiProtocolError");
  }
}
