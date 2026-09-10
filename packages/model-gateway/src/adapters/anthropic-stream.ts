import type {
  JsonValue,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
import {
  assertNoCacheTokens,
  isNonNegativeInteger,
  isPlainObject,
  mapStructuredErrorType,
  parseJsonObjectFrame,
  protocolError,
  readTokenCount,
  utf8ByteLength,
} from "./decode-utils.js";
import { streamErrorEvent, type StreamErrorCode } from "./errors.js";
import type { SseEvent } from "./sse.js";
import {
  decodeFrameStream,
  normalizeDecodeOptions,
  type FrameDecoder,
  type NormalizedDecodeOptions,
} from "./stream-runtime.js";
import type { StreamDecodeOptions } from "./types.js";

/** Anthropic error types that this stage recognises as retryable classes. */
const RATE_LIMITED_TYPES: ReadonlySet<string> = new Set(["rate_limit_error"]);
const UNAVAILABLE_TYPES: ReadonlySet<string> = new Set(["overloaded_error"]);

/** Stop reasons the supported subset accepts. */
const SUPPORTED_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "tool_use",
]);

type BlockState =
  | { readonly kind: "text" }
  | {
      readonly kind: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly initialInput: JsonValue;
      json: string;
      bytes: number;
    };

interface PendingToolCall {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

interface AnthropicState {
  readonly maxToolInputBytes: number;
  started: boolean;
  stopped: boolean;
  terminal: boolean;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  readonly blocks: Map<number, BlockState>;
  readonly toolIds: Set<string>;
  readonly pendingToolCalls: PendingToolCall[];
}

function readIndex(payload: Record<string, unknown>): number {
  const index = payload.index;
  if (!isNonNegativeInteger(index)) {
    throw protocolError();
  }
  return index;
}

function handleMessageStart(
  state: AnthropicState,
  payload: Record<string, unknown>,
): readonly ModelStreamEvent[] {
  if (state.started || state.stopped) {
    throw protocolError();
  }
  state.started = true;

  const message = payload.message;
  if (!isPlainObject(message)) {
    throw protocolError();
  }

  const usage = message.usage;
  if (usage !== undefined) {
    if (!isPlainObject(usage)) {
      throw protocolError();
    }
    assertNoCacheTokens(usage);
    const input = readTokenCount(usage.input_tokens);
    const output = readTokenCount(usage.output_tokens);
    if (input !== undefined) {
      state.inputTokens = input;
    }
    if (output !== undefined) {
      state.outputTokens = output;
    }
  }

  return [];
}

function handleBlockStart(
  state: AnthropicState,
  payload: Record<string, unknown>,
): readonly ModelStreamEvent[] {
  if (!state.started || state.stopped) {
    throw protocolError();
  }
  const index = readIndex(payload);
  if (state.blocks.has(index)) {
    throw protocolError();
  }

  const contentBlock = payload.content_block;
  if (!isPlainObject(contentBlock)) {
    throw protocolError();
  }

  if (contentBlock.type === "text") {
    state.blocks.set(index, { kind: "text" });
    return [];
  }

  if (contentBlock.type === "tool_use") {
    const id = contentBlock.id;
    const name = contentBlock.name;
    if (typeof id !== "string" || id.length === 0) {
      throw protocolError();
    }
    if (typeof name !== "string" || name.length === 0) {
      throw protocolError();
    }
    if (state.toolIds.has(id)) {
      throw protocolError();
    }
    state.toolIds.add(id);

    const initialInput = isPlainObject(contentBlock.input)
      ? (contentBlock.input as JsonValue)
      : ({} as JsonValue);

    state.blocks.set(index, {
      kind: "tool_use",
      id,
      name,
      initialInput,
      json: "",
      bytes: 0,
    });
    return [];
  }

  // thinking, redacted_thinking, server_tool_use, web_search_tool_result, ...
  throw protocolError();
}

function handleBlockDelta(
  state: AnthropicState,
  payload: Record<string, unknown>,
): readonly ModelStreamEvent[] {
  if (!state.started || state.stopped) {
    throw protocolError();
  }
  const index = readIndex(payload);

  const block = state.blocks.get(index);
  if (block === undefined) {
    throw protocolError();
  }

  const delta = payload.delta;
  if (!isPlainObject(delta)) {
    throw protocolError();
  }

  if (delta.type === "text_delta") {
    if (block.kind !== "text") {
      throw protocolError();
    }
    const text = delta.text;
    if (typeof text !== "string") {
      throw protocolError();
    }
    if (text.length === 0) {
      return [];
    }
    return [{ type: "text_delta", text }];
  }

  if (delta.type === "input_json_delta") {
    if (block.kind !== "tool_use") {
      throw protocolError();
    }
    const partial = delta.partial_json;
    if (typeof partial !== "string") {
      throw protocolError();
    }
    block.bytes += utf8ByteLength(partial);
    if (block.bytes > state.maxToolInputBytes) {
      throw protocolError();
    }
    block.json += partial;
    return [];
  }

  // thinking_delta, signature_delta and future delta kinds are unsupported.
  throw protocolError();
}

function handleBlockStop(
  state: AnthropicState,
  payload: Record<string, unknown>,
): readonly ModelStreamEvent[] {
  if (!state.started || state.stopped) {
    throw protocolError();
  }
  const index = readIndex(payload);

  const block = state.blocks.get(index);
  if (block === undefined) {
    throw protocolError();
  }
  state.blocks.delete(index);

  if (block.kind === "text") {
    return [];
  }

  const accumulated = block.json.trim();
  let input: JsonValue;
  if (accumulated.length === 0) {
    input = block.initialInput;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(accumulated);
    } catch {
      throw protocolError();
    }
    if (!isPlainObject(parsed)) {
      throw protocolError();
    }
    input = parsed as JsonValue;
  }

  state.pendingToolCalls.push({
    index,
    id: block.id,
    name: block.name,
    input,
  });
  return [];
}

function handleMessageDelta(
  state: AnthropicState,
  payload: Record<string, unknown>,
): readonly ModelStreamEvent[] {
  if (!state.started || state.stopped) {
    throw protocolError();
  }

  const delta = payload.delta;
  if (delta !== undefined) {
    if (!isPlainObject(delta)) {
      throw protocolError();
    }
    const stopReason = delta.stop_reason;
    if (stopReason !== undefined && stopReason !== null) {
      if (typeof stopReason !== "string") {
        throw protocolError();
      }
      state.stopReason = stopReason;
    }
  }

  const usage = payload.usage;
  if (usage !== undefined) {
    if (!isPlainObject(usage)) {
      throw protocolError();
    }
    assertNoCacheTokens(usage);
    // Cumulative: assign, never accumulate.
    const output = readTokenCount(usage.output_tokens);
    if (output !== undefined) {
      state.outputTokens = output;
    }
  }

  return [];
}

function handleMessageStop(
  state: AnthropicState,
): readonly ModelStreamEvent[] {
  if (!state.started || state.stopped) {
    throw protocolError();
  }
  if (state.blocks.size > 0) {
    throw protocolError();
  }
  if (state.stopReason === null || !SUPPORTED_STOP_REASONS.has(state.stopReason)) {
    throw protocolError();
  }

  state.stopped = true;
  state.terminal = true;

  const events: ModelStreamEvent[] = [];
  const ordered = [...state.pendingToolCalls].sort((a, b) => a.index - b.index);
  for (const call of ordered) {
    events.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }

  if (state.inputTokens !== null && state.outputTokens !== null) {
    events.push({
      type: "usage",
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    });
  }
  events.push({ type: "completed" });
  return events;
}

function handleError(
  state: AnthropicState,
  payload: Record<string, unknown>,
): readonly ModelStreamEvent[] {
  state.terminal = true;
  const error = payload.error;
  const type = isPlainObject(error) ? error.type : undefined;
  const code: StreamErrorCode = mapStructuredErrorType(
    type,
    RATE_LIMITED_TYPES,
    UNAVAILABLE_TYPES,
  );
  return [streamErrorEvent(code)];
}

const anthropicDecoder: FrameDecoder<AnthropicState> = {
  createState(options: NormalizedDecodeOptions): AnthropicState {
    return {
      maxToolInputBytes: options.maxToolInputBytes,
      started: false,
      stopped: false,
      terminal: false,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
      blocks: new Map<number, BlockState>(),
      toolIds: new Set<string>(),
      pendingToolCalls: [],
    };
  },

  handleFrame(state, frame: SseEvent): readonly ModelStreamEvent[] {
    const payload = parseJsonObjectFrame(frame.data);
    const type = payload.type;
    if (typeof type !== "string") {
      throw protocolError();
    }

    switch (type) {
      case "ping":
        return [];
      case "message_start":
        return handleMessageStart(state, payload);
      case "content_block_start":
        return handleBlockStart(state, payload);
      case "content_block_delta":
        return handleBlockDelta(state, payload);
      case "content_block_stop":
        return handleBlockStop(state, payload);
      case "message_delta":
        return handleMessageDelta(state, payload);
      case "message_stop":
        return handleMessageStop(state);
      case "error":
        return handleError(state, payload);
      default:
        throw protocolError();
    }
  },

  isTerminal(state: AnthropicState): boolean {
    return state.terminal;
  },

  finish(): readonly ModelStreamEvent[] {
    // The byte stream ended without message_stop: a truncated response must
    // never be reported as a successful completion.
    throw protocolError();
  },
};

/**
 * Decodes an Anthropic Messages SSE byte stream into ModelStreamEvents.
 *
 * Invalid options throw synchronously; every other failure is reported as a
 * ModelStreamEvent error event.
 */
export function decodeAnthropicMessagesStream(
  source: AsyncIterable<Uint8Array>,
  options: StreamDecodeOptions = {},
): AsyncIterable<ModelStreamEvent> {
  const normalized = normalizeDecodeOptions(options);
  return decodeFrameStream(source, normalized, anthropicDecoder);
}
