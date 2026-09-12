import type { LocalAgentRunner } from "@agent-workbench/local-agent-api";

import { LocalAgentHostError } from "./errors.js";
import type { LocalAgentHostOptions } from "./types.js";

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
  const allowedKeys = new Set(["host", "port", "runner"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new LocalAgentHostError("invalid_options");
  }
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
  if (candidate.runner !== undefined && !isLocalAgentRunner(candidate.runner)) {
    throw new LocalAgentHostError("invalid_options");
  }
}
