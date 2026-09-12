import type {
  CredentialStore,
  ProviderRegistry,
} from "@agent-workbench/provider-registry";
import type { HttpClient, RetryPolicy, RetryWait } from "@agent-workbench/model-gateway";
import type {
  ToolApprovalHandler,
  ToolExecutor,
  ToolPolicy,
} from "@agent-workbench/agent-runtime";

import { AgentBackendError } from "./errors.js";
import type { AgentBackendOptions } from "./types.js";

/** Runtime shape check: only the required methods must be callable functions. */
function hasCallableMethod(value: unknown, name: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[name] === "function";
}

export function isProviderRegistry(value: unknown): value is ProviderRegistry {
  return hasCallableMethod(value, "resolveRoute");
}

export function isCredentialStore(value: unknown): value is CredentialStore {
  return hasCallableMethod(value, "get");
}

export function isHttpClient(value: unknown): value is HttpClient {
  return typeof value === "function";
}

export function isToolExecutor(value: unknown): value is ToolExecutor {
  return hasCallableMethod(value, "execute");
}

export function isToolPolicy(value: unknown): value is ToolPolicy {
  return hasCallableMethod(value, "decide");
}

export function isToolApprovalHandler(value: unknown): value is ToolApprovalHandler {
  return hasCallableMethod(value, "requestApproval");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates raw backend options before anything is constructed. Throws the
 * fixed `invalid_options` error; the message never echoes the rejected
 * values. Construction never reads credentials and never touches HTTP.
 */
export function validateBackendOptions(options: unknown): asserts options is AgentBackendOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new AgentBackendError("invalid_options");
  }
  const candidate = options as Record<string, unknown>;
  if (!isProviderRegistry(candidate.registry) || !isCredentialStore(candidate.credentials)) {
    throw new AgentBackendError("invalid_options");
  }
  if (candidate.httpClient !== undefined && !isHttpClient(candidate.httpClient)) {
    throw new AgentBackendError("invalid_options");
  }
  if (candidate.toolExecutor !== undefined && !isToolExecutor(candidate.toolExecutor)) {
    throw new AgentBackendError("invalid_options");
  }
  if (candidate.policy !== undefined && !isToolPolicy(candidate.policy)) {
    throw new AgentBackendError("invalid_options");
  }
  if (candidate.approvalHandler !== undefined && !isToolApprovalHandler(candidate.approvalHandler)) {
    throw new AgentBackendError("invalid_options");
  }
  for (const key of ["defaultMaxTokens", "maxTurns", "maxToolCallsPerTurn", "maxToolResultBytes", "maxFrameBytes", "maxToolInputBytes"]) {
    if (candidate[key] !== undefined && !isPositiveSafeInteger(candidate[key])) {
      throw new AgentBackendError("invalid_options");
    }
  }
  if (candidate.retryPolicy !== undefined) {
    if (typeof candidate.retryPolicy !== "object" || candidate.retryPolicy === null || Array.isArray(candidate.retryPolicy)) {
      throw new AgentBackendError("invalid_options");
    }
    const policy = candidate.retryPolicy as Record<string, unknown>;
    for (const key of ["maxAttemptsPerProvider", "maxTotalAttempts"]) {
      if (policy[key] !== undefined && !isPositiveSafeInteger(policy[key])) {
        throw new AgentBackendError("invalid_options");
      }
    }
  }
  if (candidate.wait !== undefined && typeof candidate.wait !== "function") {
    throw new AgentBackendError("invalid_options");
  }
}
