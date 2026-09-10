import { encodeAnthropicMessagesRequest } from "./anthropic-request.js";
import { decodeAnthropicMessagesStream } from "./anthropic-stream.js";
import {
  encodeOpenAIChatRequest,
  normalizeTokenLimitField,
} from "./openai-chat-request.js";
import { decodeOpenAIChatCompletionsStream } from "./openai-chat-stream.js";
import type {
  OpenAIChatAdapterOptions,
  ProtocolAdapter,
} from "./types.js";

/**
 * Creates the Anthropic Messages adapter (streaming text + client side tools).
 *
 * Offline codec only: it never opens a connection, resolves a URL or attaches a
 * credential.
 */
export function createAnthropicMessagesAdapter(): ProtocolAdapter {
  return {
    encode: encodeAnthropicMessagesRequest,
    decode: decodeAnthropicMessagesStream,
  };
}

/**
 * Creates the OpenAI Chat Completions adapter.
 *
 * Chat Completions only, single choice, streaming text + function tools. It is
 * not an implementation of the Responses API.
 */
export function createOpenAIChatCompletionsAdapter(
  options?: OpenAIChatAdapterOptions,
): ProtocolAdapter {
  const tokenLimitField = normalizeTokenLimitField(options?.tokenLimitField);
  return {
    encode: (request) => encodeOpenAIChatRequest(request, tokenLimitField),
    decode: decodeOpenAIChatCompletionsStream,
  };
}
