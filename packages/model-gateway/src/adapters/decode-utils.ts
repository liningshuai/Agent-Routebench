import { AdapterStreamError, type StreamErrorCode } from "./errors.js";

/**
 * Shared decode primitives used by both protocol decoders.
 *
 * These helpers only ever report a fixed protocol error: they never echo the
 * offending payload, so a malformed provider frame cannot leak through an
 * exception message.
 */

export function protocolError(): AdapterStreamError {
  return new AdapterStreamError("provider_protocol_error");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parses an SSE data payload that must be a JSON object. */
export function parseJsonObjectFrame(data: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw protocolError();
  }
  if (!isPlainObject(parsed)) {
    throw protocolError();
  }
  return parsed;
}

/** Reads an optional token count, rejecting anything that is not a safe count. */
export function readTokenCount(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isNonNegativeInteger(value)) {
    throw protocolError();
  }
  return value;
}

/**
 * This stage does not enable prompt caching. A non-zero cache count is outside
 * the supported subset, and silently dropping it would report a misleading
 * total token count, so it is rejected instead.
 */
const CACHE_TOKEN_FIELDS = [
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

export function assertNoCacheTokens(usage: Record<string, unknown>): void {
  for (const field of CACHE_TOKEN_FIELDS) {
    const value = usage[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (value !== 0) {
      throw protocolError();
    }
  }
}

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Maps a provider structured error type to a stable stream error code.
 *
 * Only explicitly recognised types may become `rate_limited` or
 * `upstream_unavailable`; free text is never inspected. Everything else is a
 * generic gateway error.
 */
export function mapStructuredErrorType(
  type: unknown,
  rateLimitedTypes: ReadonlySet<string>,
  unavailableTypes: ReadonlySet<string>,
): StreamErrorCode {
  if (typeof type !== "string") {
    return "gateway_error";
  }
  if (rateLimitedTypes.has(type)) {
    return "rate_limited";
  }
  if (unavailableTypes.has(type)) {
    return "upstream_unavailable";
  }
  return "gateway_error";
}
