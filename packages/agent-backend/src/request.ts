import type { ModelRequest } from "@agent-workbench/agent-contracts";
import { validateModelRequest } from "@agent-workbench/agent-contracts";
import type { LocalAgentRunnerRequest } from "@agent-workbench/local-agent-api";

import { AgentBackendError } from "./errors.js";

/** Documented fallback when the caller configures no default max tokens. */
export const DEFAULT_BACKEND_MAX_TOKENS = 4096;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Converts a Local Agent runner request into a gateway `ModelRequest`.
 *
 * - `requestId` is the runner's `turnId`: no second, untrackable id is minted.
 * - `routeId` and `model` are mandatory; the backend never auto-selects.
 * - `maxTokens` falls back to the caller-configured default and must be a
 *   positive safe integer.
 * - `messages` and `tools` are defensively copied; the caller's objects are
 *   never mutated or aliased.
 *
 * Throws the fixed `invalid_request` error; nothing here reads credentials or
 * performs HTTP.
 */
export function toModelRequest(
  request: LocalAgentRunnerRequest,
  defaultMaxTokens: number = DEFAULT_BACKEND_MAX_TOKENS,
): ModelRequest {
  if (!isNonEmptyString(request.turnId)) {
    throw new AgentBackendError("invalid_request");
  }
  if (!isNonEmptyString(request.routeId) || !isNonEmptyString(request.model)) {
    throw new AgentBackendError("invalid_request");
  }
  const maxTokens = request.maxTokens ?? defaultMaxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new AgentBackendError("invalid_request");
  }
  const modelRequest: ModelRequest = {
    requestId: request.turnId,
    routeId: request.routeId,
    model: request.model,
    messages: Array.from(request.messages),
    tools: Array.from(request.tools ?? []),
    maxTokens,
  };
  try {
    validateModelRequest(modelRequest);
  } catch {
    // The validator's message may quote payload details; only the fixed
    // backend error is allowed to escape.
    throw new AgentBackendError("invalid_request");
  }
  return modelRequest;
}
