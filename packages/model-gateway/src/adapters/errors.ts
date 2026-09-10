import type { ModelStreamEvent } from "@agent-workbench/agent-contracts";

/**
 * Encode side failure codes.
 *
 * `encode` is synchronous and pure, so it reports problems by throwing.
 */
export const ADAPTER_ERROR_CODES = Object.freeze({
  invalidAdapterRequest: "invalid_adapter_request",
  unsupportedAdapterInput: "unsupported_adapter_input",
  invalidAdapterOptions: "invalid_adapter_options",
} as const);

export type AdapterErrorCode =
  (typeof ADAPTER_ERROR_CODES)[keyof typeof ADAPTER_ERROR_CODES];

/**
 * Fixed messages only. Adapter errors must never echo the caller supplied
 * request: no values, no JSON, no field names, no `cause`.
 */
const ADAPTER_ERROR_MESSAGES: Readonly<Record<AdapterErrorCode, string>> =
  Object.freeze({
    invalid_adapter_request:
      "The model request cannot be expressed with the supported provider protocol subset.",
    unsupported_adapter_input:
      "The model request contains a value that cannot be represented losslessly.",
    invalid_adapter_options: "The adapter options are invalid.",
  });

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode) {
    super(ADAPTER_ERROR_MESSAGES[code]);
    this.name = "AdapterError";
    this.code = code;
  }
}

export function adapterError(code: AdapterErrorCode): AdapterError {
  return new AdapterError(code);
}

/**
 * Decode side failure codes.
 *
 * `decode` never throws at the consumer: it converts failures into an existing
 * `ModelStreamEvent` error event, so the code space is exactly the one Agent
 * Core already understands.
 */
export const STREAM_ERROR_CODES = Object.freeze({
  aborted: "aborted",
  providerProtocolError: "provider_protocol_error",
  upstreamUnavailable: "upstream_unavailable",
  rateLimited: "rate_limited",
  gatewayError: "gateway_error",
} as const);

export type StreamErrorCode =
  (typeof STREAM_ERROR_CODES)[keyof typeof STREAM_ERROR_CODES];

const STREAM_ERROR_MESSAGES: Readonly<Record<StreamErrorCode, string>> =
  Object.freeze({
    aborted: "Request aborted.",
    provider_protocol_error:
      "The provider stream is outside the supported protocol subset.",
    upstream_unavailable: "The upstream provider is currently unavailable.",
    rate_limited: "The upstream provider rate limited this request.",
    gateway_error: "Model gateway request failed.",
  });

/** Internal control-flow error used between the framing layer and decoders. */
export class AdapterStreamError extends Error {
  readonly code: StreamErrorCode;

  constructor(code: StreamErrorCode) {
    super(STREAM_ERROR_MESSAGES[code]);
    this.name = "AdapterStreamError";
    this.code = code;
  }
}

export function streamErrorMessage(code: StreamErrorCode): string {
  return STREAM_ERROR_MESSAGES[code];
}

export function streamErrorEvent(code: StreamErrorCode): ModelStreamEvent {
  return {
    type: "error",
    code,
    message: STREAM_ERROR_MESSAGES[code],
    retryable: code === "rate_limited" || code === "upstream_unavailable",
  };
}
