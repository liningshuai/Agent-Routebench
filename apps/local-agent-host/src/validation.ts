import type { LocalAgentRunner, LocalAgentSessionStore } from "@agent-workbench/local-agent-api";

import { LocalAgentHostError } from "./errors.js";
import type { LocalAgentHostOptions, RunnableLocalAgentHostOptions } from "./types.js";

/** The only host names a Local Agent host may listen on. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;

/**
 * Runtime shape check for an injected runner. Accepts object literals,
 * null-prototype objects and class instances; rejects null, arrays,
 * primitives, missing methods and non-function methods.
 */
export function isLocalAgentRunner(value: unknown): value is LocalAgentRunner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.run === "function";
}

/** Runtime shape check for an injected session store (all methods callable). */
export function isLocalAgentSessionStore(value: unknown): value is LocalAgentSessionStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.create === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.listEvents === "function" &&
    typeof candidate.appendEvent === "function" &&
    typeof candidate.setStatus === "function"
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateLoopbackAndPort(candidate: Record<string, unknown>): void {
  const host = candidate.host;
  if (host !== undefined) {
    if (typeof host !== "string") {
      throw new LocalAgentHostError("invalid_options");
    }
    if (!LOOPBACK_HOSTS.includes(host as (typeof LOOPBACK_HOSTS)[number])) {
      throw new LocalAgentHostError("host_not_loopback");
    }
  }
  const port = candidate.port;
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new LocalAgentHostError("invalid_port");
  }
}

/**
 * Validates raw host options before any listener exists. Throws the fixed
 * `host_not_loopback`, `invalid_port` or `invalid_options` errors; messages
 * never echo the rejected values.
 */
export function validateHostOptions(options: unknown): asserts options is LocalAgentHostOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new LocalAgentHostError("invalid_options");
  }
  const candidate = options as Record<string, unknown>;
  const allowedKeys = new Set(["host", "port", "runner", "store", "maxBodyBytes"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new LocalAgentHostError("invalid_options");
  }
  validateLoopbackAndPort(candidate);
  if (candidate.runner !== undefined && !isLocalAgentRunner(candidate.runner)) {
    throw new LocalAgentHostError("invalid_options");
  }
  if (candidate.store !== undefined && !isLocalAgentSessionStore(candidate.store)) {
    throw new LocalAgentHostError("invalid_options");
  }
  if (candidate.maxBodyBytes !== undefined && !isPositiveSafeInteger(candidate.maxBodyBytes)) {
    throw new LocalAgentHostError("invalid_options");
  }
}

/**
 * Validates the runnable composition options. The `backend` member is only
 * shape-checked here; its full validation (and the runner assembly) happens
 * synchronously inside `createAgentBackendRunner`, still before any listener
 * exists. A `runner` member is rejected: mixing a hand-built runner with
 * backend options is an ambiguous configuration.
 */
export function validateRunnableHostOptions(
  options: unknown,
): asserts options is RunnableLocalAgentHostOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new LocalAgentHostError("invalid_options");
  }
  const candidate = options as Record<string, unknown>;
  const allowedKeys = new Set(["host", "port", "backend", "store", "maxBodyBytes"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new LocalAgentHostError("invalid_options");
  }
  validateLoopbackAndPort(candidate);
  if (typeof candidate.backend !== "object" || candidate.backend === null || Array.isArray(candidate.backend)) {
    throw new LocalAgentHostError("invalid_options");
  }
  if (candidate.store !== undefined && !isLocalAgentSessionStore(candidate.store)) {
    throw new LocalAgentHostError("invalid_options");
  }
  if (candidate.maxBodyBytes !== undefined && !isPositiveSafeInteger(candidate.maxBodyBytes)) {
    throw new LocalAgentHostError("invalid_options");
  }
}
