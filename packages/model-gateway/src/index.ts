export type { ModelGateway, ModelStreamEvent } from "./contracts.js";
export type { FakeGatewayOptions } from "./fake-gateway.js";
export { DeterministicFakeModelGateway } from "./fake-gateway.js";
export type { JsonValue, ModelRequest } from "@agent-workbench/agent-contracts";

export type {
  EncodedModelRequest,
  OpenAIChatAdapterOptions,
  ProtocolAdapter,
  StreamDecodeOptions,
} from "./adapters/types.js";
export {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_TOOL_INPUT_BYTES,
} from "./adapters/types.js";

export type {
  AdapterErrorCode,
  StreamErrorCode,
} from "./adapters/errors.js";
export {
  ADAPTER_ERROR_CODES,
  AdapterError,
  AdapterStreamError,
  STREAM_ERROR_CODES,
} from "./adapters/errors.js";

export type { SseEvent, SseParserOptions } from "./adapters/sse.js";
export { SseFrameParser, parseSseStream } from "./adapters/sse.js";

export { assertAdapterRequest } from "./adapters/request-validation.js";
export {
  encodeAnthropicMessagesRequest,
} from "./adapters/anthropic-request.js";
export {
  decodeAnthropicMessagesStream,
} from "./adapters/anthropic-stream.js";
export {
  encodeOpenAIChatRequest,
  encodeToolResultEnvelope,
} from "./adapters/openai-chat-request.js";
export {
  decodeOpenAIChatCompletionsStream,
} from "./adapters/openai-chat-stream.js";
export {
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter,
} from "./adapters/index.js";
