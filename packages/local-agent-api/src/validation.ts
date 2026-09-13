import type { AgentMessage, AgentToolDefinition } from "@agent-workbench/agent-core";
import {
  validateAgentMessages,
  validateAgentToolDefinitions,
} from "@agent-workbench/agent-core";
import { apiErrorPayload } from "./errors.js";
import type {
  LocalAgentApiOptions,
  LocalAgentConfigManager,
  LocalAgentRunner,
  LocalAgentSessionStore,
  LocalAgentTurnRequest,
} from "./types.js";
import { DEFAULT_MAX_BODY_BYTES } from "./types.js";

export class ApiValidationError extends Error {
  readonly payload: { error: { code: string; message: string } };

  constructor(key: keyof typeof import("./errors.js").API_ERRORS) {
    const payload = apiErrorPayload(key);
    super(payload.error.message);
    this.name = "ApiValidationError";
    this.payload = payload;
  }
}

const SENSITIVE_FIELDS = new Set([
  "apikey",
  "api_key",
  "token",
  "authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "endpoint",
  "baseurl",
  "base_url",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively rejects objects that carry any sensitive field name.
 *
 * Fail-closed on excessive depth: a value nested past the bound is rejected
 * rather than silently skipped, so a secret cannot hide past the limit.
 */
const MAX_SENSITIVE_SCAN_DEPTH = 32;

export function assertNoSensitiveFields(value: unknown, depth = 0): void {
  if (depth > MAX_SENSITIVE_SCAN_DEPTH) {
    throw new ApiValidationError("invalidRequest");
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSensitiveFields(item, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      throw new ApiValidationError("invalidRequest");
    }
    assertNoSensitiveFields(item, depth + 1);
  }
}

function assertCallableMethod(value: unknown, name: string): void {
  if (typeof value !== "object" || value === null) {
    throw new ApiValidationError("invalidRequest");
  }
  const method = (value as Record<string, unknown>)[name];
  if (typeof method !== "function") {
    throw new ApiValidationError("invalidRequest");
  }
}

function isConfigManager(value: unknown): value is LocalAgentConfigManager {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return [
    "getSnapshot",
    "createProvider",
    "updateProvider",
    "deleteProvider",
    "createRoute",
    "updateRoute",
    "deleteRoute",
  ].every((name) => typeof candidate[name] === "function");
}

/**
 * Options validation deliberately accepts class instances for `runner` and
 * `store`: only the *method* presence is checked, never the prototype shape.
 */
export function parseApiOptions(
  options: LocalAgentApiOptions,
): {
  host: "127.0.0.1" | "localhost";
  port: number;
  runner: LocalAgentRunner;
  store: LocalAgentSessionStore | undefined;
  maxBodyBytes: number;
  configManager: LocalAgentConfigManager | undefined;
} {
  // Reject null / undefined / arrays / primitives before any field access.
  // `typeof null === "object"`, so a plain typeof check is not enough.
  if (
    options === null ||
    options === undefined ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new ApiValidationError("invalidRequest");
  }
  const raw = options as Partial<LocalAgentApiOptions>;

  const host = raw.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new ApiValidationError("invalidHost");
  }

  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ApiValidationError("invalidRequest");
  }

  if (raw.runner === undefined || raw.runner === null) {
    throw new ApiValidationError("invalidRequest");
  }
  assertCallableMethod(raw.runner, "run");

  const store = raw.store;
  if (store !== undefined) {
    assertCallableMethod(store, "create");
    assertCallableMethod(store, "get");
    assertCallableMethod(store, "listEvents");
    assertCallableMethod(store, "appendEvent");
    assertCallableMethod(store, "setStatus");
  }

  const maxBodyBytes = raw.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    typeof maxBodyBytes !== "number" ||
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes <= 0
  ) {
    throw new ApiValidationError("invalidRequest");
  }

  assertNoSensitiveFields(raw);

  const configManager = raw.configManager;
  if (configManager !== undefined && !isConfigManager(configManager)) {
    throw new ApiValidationError("invalidRequest");
  }

  return { host, port, runner: raw.runner, store, maxBodyBytes, configManager };
}

export function parseTurnRequest(input: unknown): LocalAgentTurnRequest {
  if (!isPlainObject(input)) {
    throw new ApiValidationError("invalidRequest");
  }
  assertNoSensitiveFields(input);

  for (const key of Object.keys(input)) {
    if (
      !["messages", "tools", "routeId", "model", "maxTokens"].includes(key)
    ) {
      throw new ApiValidationError("invalidRequest");
    }
  }

  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiValidationError("invalidRequest");
  }
  try {
    validateAgentMessages(messages as AgentMessage[]);
  } catch {
    throw new ApiValidationError("invalidRequest");
  }

  const tools = input.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      throw new ApiValidationError("invalidRequest");
    }
    try {
      validateAgentToolDefinitions(tools as AgentToolDefinition[]);
    } catch {
      throw new ApiValidationError("invalidRequest");
    }
  }

  if (input.routeId !== undefined && typeof input.routeId !== "string") {
    throw new ApiValidationError("invalidRequest");
  }
  if (input.model !== undefined && typeof input.model !== "string") {
    throw new ApiValidationError("invalidRequest");
  }
  if (input.maxTokens !== undefined) {
    const maxTokens = input.maxTokens;
    if (
      typeof maxTokens !== "number" ||
      !Number.isInteger(maxTokens) ||
      maxTokens <= 0
    ) {
      throw new ApiValidationError("invalidRequest");
    }
  }

  return structuredClone({
    messages: messages as LocalAgentTurnRequest["messages"],
    tools: tools as LocalAgentTurnRequest["tools"],
    routeId: input.routeId as string | undefined,
    model: input.model as string | undefined,
    maxTokens: input.maxTokens as number | undefined,
  });
}
