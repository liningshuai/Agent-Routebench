import type {
  JsonValue,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";

/**
 * An encoded provider request body.
 *
 * The body carries protocol fields only. It never carries a URL, a header, an
 * authentication value, a provider credential reference or the internal
 * request/route identifiers.
 */
export interface EncodedModelRequest {
  readonly body: {
    readonly [key: string]: JsonValue;
  };
}

export interface StreamDecodeOptions {
  readonly signal?: AbortSignal;
  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}

export interface ProtocolAdapter {
  encode(request: ModelRequest): EncodedModelRequest;

  decode(
    source: AsyncIterable<Uint8Array>,
    options?: StreamDecodeOptions,
  ): AsyncIterable<ModelStreamEvent>;
}

export interface OpenAIChatAdapterOptions {
  readonly tokenLimitField?: "max_tokens" | "max_completion_tokens";
}

/** Default cap for a single buffered SSE frame, in UTF-8 bytes. */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

/** Default cap for accumulated tool call arguments, in UTF-8 bytes. */
export const DEFAULT_MAX_TOOL_INPUT_BYTES = 1024 * 1024;

export const OPENAI_TOKEN_LIMIT_FIELDS: ReadonlySet<string> = new Set([
  "max_tokens",
  "max_completion_tokens",
]);
