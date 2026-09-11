import type { AgentEvent } from "@agent-workbench/agent-core";
import { failSession } from "./errors.js";
import type { PersistedSessionRecord, SessionStatus } from "./types.js";

const STATUSES = new Set<SessionStatus>([
  "idle",
  "running",
  "completed",
  "cancelled",
  "failed",
]);

const EVENT_TYPES = new Set([
  "route_selected",
  "text_delta",
  "tool_call",
  "usage",
  "completed",
  "error",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSerializableJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value);
  if (t !== "object") return false;
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(value)) return value.every((i) => isSerializableJsonValue(i, seen));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((i) => isSerializableJsonValue(i, seen));
}

export function assertSessionStatus(value: unknown): asserts value is SessionStatus {
  if (typeof value !== "string" || !STATUSES.has(value as SessionStatus)) {
    failSession("invalidStatus");
  }
}

export function assertSessionId(value: unknown): asserts value is string {
  if (!isNonEmptyString(value) || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    failSession("invalidOptions");
  }
}

export function assertAgentEvent(
  input: unknown,
  maxEventBytes: number,
): asserts input is AgentEvent {
  if (!isPlainObject(input)) {
    failSession("invalidEvent");
  }
  const type = input.type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
    failSession("invalidEvent");
  }

  if (!isNonEmptyString(input.requestId)) {
    failSession("invalidEvent");
  }

  switch (type) {
    case "route_selected": {
      if (!isNonEmptyString(input.routeId) || !isNonEmptyString(input.model)) {
        failSession("invalidEvent");
      }
      break;
    }
    case "text_delta": {
      if (typeof input.text !== "string") {
        failSession("invalidEvent");
      }
      break;
    }
    case "tool_call": {
      if (!isNonEmptyString(input.id) || !isNonEmptyString(input.name)) {
        failSession("invalidEvent");
      }
      if (!isSerializableJsonValue(input.input, new WeakSet())) {
        failSession("invalidEvent");
      }
      break;
    }
    case "usage": {
      if (
        typeof input.inputTokens !== "number" ||
        !Number.isInteger(input.inputTokens) ||
        input.inputTokens < 0 ||
        typeof input.outputTokens !== "number" ||
        !Number.isInteger(input.outputTokens) ||
        input.outputTokens < 0
      ) {
        failSession("invalidEvent");
      }
      break;
    }
    case "completed": {
      break;
    }
    case "error": {
      if (
        !isNonEmptyString(input.code) ||
        !isNonEmptyString(input.message) ||
        typeof input.retryable !== "boolean"
      ) {
        failSession("invalidEvent");
      }
      break;
    }
    default:
      failSession("invalidEvent");
  }

  // Reject unknown top-level fields per event type.
  const allowed = new Set<string>(["type", "requestId"]);
  switch (type) {
    case "route_selected":
      allowed.add("routeId");
      allowed.add("model");
      break;
    case "text_delta":
      allowed.add("text");
      break;
    case "tool_call":
      allowed.add("id");
      allowed.add("name");
      allowed.add("input");
      break;
    case "usage":
      allowed.add("inputTokens");
      allowed.add("outputTokens");
      break;
    case "error":
      allowed.add("code");
      allowed.add("message");
      allowed.add("retryable");
      break;
    default:
      break;
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      failSession("invalidEvent");
    }
  }

  const size = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (size > maxEventBytes) {
    failSession("eventTooLarge");
  }
}

export function assertPersistedSession(
  input: unknown,
): asserts input is PersistedSessionRecord {
  if (!isPlainObject(input)) {
    failSession("fileInvalid");
  }
  const allowed = new Set([
    "id",
    "status",
    "createdAt",
    "updatedAt",
    "activeTurnId",
    "events",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      failSession("fileInvalid");
    }
  }
  assertSessionId(input.id);
  assertSessionStatus(input.status);
  if (!isFiniteNumber(input.createdAt) || !isFiniteNumber(input.updatedAt)) {
    failSession("fileInvalid");
  }
  if (input.activeTurnId !== undefined && !isNonEmptyString(input.activeTurnId)) {
    failSession("fileInvalid");
  }
  if (!Array.isArray(input.events)) {
    failSession("fileInvalid");
  }
}

export function validatePersistedFile(
  input: unknown,
): asserts input is { version: 1; sessions: PersistedSessionRecord[] } {
  if (!isPlainObject(input)) {
    failSession("fileInvalid");
  }
  for (const key of Object.keys(input)) {
    if (key !== "version" && key !== "sessions") {
      failSession("fileInvalid");
    }
  }
  if (input.version !== 1) {
    failSession("fileInvalid");
  }
  if (!Array.isArray(input.sessions)) {
    failSession("fileInvalid");
  }
  const seen = new Set<string>();
  for (const session of input.sessions) {
    assertPersistedSession(session);
    if (seen.has(session.id)) {
      failSession("fileInvalid");
    }
    seen.add(session.id);
  }
}
