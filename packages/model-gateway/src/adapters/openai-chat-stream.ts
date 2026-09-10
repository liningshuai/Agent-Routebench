import type {
  JsonValue,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
import {
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

/**
 * Structured OpenAI error types recognised by this stage.
 *
 * Only these may become retryable classes; every other upstream error is folded
 * into `gateway_error` and its text is discarded.
 */
const RATE_LIMITED_TYPES: ReadonlySet<string> = new Set([
  "rate_limit_error",
  "rate_limit_exceeded",
]);
const UNAVAILABLE_TYPES: ReadonlySet<string> = new Set([
  "server_error",
  "overloaded_error",
]);

const DONE_SENTINEL = "[DONE]";

interface ToolCallState {
  readonly index: number;
  id: string | null;
  name: string | null;
  args: string;
  bytes: number;
}

interface OpenAIState {
  readonly maxToolInputBytes: number;
  sawFinishReason: boolean;
  finishReason: string | null;
  toolsEmitted: boolean;
  terminal: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  readonly toolCalls: Map<number, ToolCallState>;
}

function mapOpenAIError(error: unknown): StreamErrorCode {
  if (!isPlainObject(error)) {
    return "gateway_error";
  }
  const byType = mapStructuredErrorType(
    error.type,
    RATE_LIMITED_TYPES,
    UNAVAILABLE_TYPES,
  );
  if (byType !== "gateway_error") {
    return byType;
  }
  return mapStructuredErrorType(error.code, RATE_LIMITED_TYPES, UNAVAILABLE_TYPES);
}

function applyToolCallDelta(
  state: OpenAIState,
  raw: unknown,
): void {
  if (!isPlainObject(raw)) {
    throw protocolError();
  }
  const index = raw.index;
  if (!isNonNegativeInteger(index)) {
    throw protocolError();
  }

  let entry = state.toolCalls.get(index);
  if (entry === undefined) {
    entry = { index, id: null, name: null, args: "", bytes: 0 };
    state.toolCalls.set(index, entry);
  }

  if (raw.type !== undefined && raw.type !== null && raw.type !== "function") {
    throw protocolError();
  }

  const id = raw.id;
  if (id !== undefined && id !== null) {
    if (typeof id !== "string" || id.length === 0) {
      throw protocolError();
    }
    if (entry.id === null) {
      entry.id = id;
    } else if (entry.id !== id) {
      // An established id is never overwritten by a conflicting value.
      throw protocolError();
    }
  }

  const fn = raw.function;
  if (fn === undefined || fn === null) {
    return;
  }
  if (!isPlainObject(fn)) {
    throw protocolError();
  }

  const name = fn.name;
  if (name !== undefined && name !== null) {
    if (typeof name !== "string" || name.length === 0) {
      throw protocolError();
    }
    if (entry.name === null) {
      entry.name = name;
    } else if (entry.name !== name) {
      throw protocolError();
    }
  }

  const args = fn.arguments;
  if (args !== undefined && args !== null) {
    if (typeof args !== "string") {
      throw protocolError();
    }
    entry.bytes += utf8ByteLength(args);
    if (entry.bytes > state.maxToolInputBytes) {
      throw protocolError();
    }
    entry.args += args;
  }
}

function handleDelta(
  state: OpenAIState,
  delta: Record<string, unknown>,
  events: ModelStreamEvent[],
): void {
  const content = delta.content;

  if (state.sawFinishReason) {
    const hasContent = typeof content === "string" && content.length > 0;
    if (hasContent || delta.tool_calls !== undefined) {
      // Nothing valid may follow the finish marker besides usage.
      throw protocolError();
    }
  }

  if (delta.role !== undefined && delta.role !== null && delta.role !== "assistant") {
    throw protocolError();
  }
  if (delta.refusal !== undefined && delta.refusal !== null) {
    throw protocolError();
  }
  if (delta.function_call !== undefined && delta.function_call !== null) {
    // The legacy function_call shape is out of scope for this stage.
    throw protocolError();
  }
  if (
    (delta.reasoning_content !== undefined && delta.reasoning_content !== null) ||
    (delta.reasoning !== undefined && delta.reasoning !== null)
  ) {
    throw protocolError();
  }

  if (content !== undefined && content !== null) {
    if (typeof content !== "string") {
      throw protocolError();
    }
    if (content.length > 0) {
      events.push({ type: "text_delta", text: content });
    }
  }

  const toolCalls = delta.tool_calls;
  if (toolCalls !== undefined && toolCalls !== null) {
    if (!Array.isArray(toolCalls)) {
      throw protocolError();
    }
    for (const call of toolCalls) {
      applyToolCallDelta(state, call);
    }
  }
}

function emitToolCalls(
  state: OpenAIState,
  events: ModelStreamEvent[],
): void {
  const ordered = [...state.toolCalls.values()].sort((a, b) => a.index - b.index);

  for (const entry of ordered) {
    if (entry.id === null || entry.name === null) {
      throw protocolError();
    }
    const trimmed = entry.args.trim();
    let input: JsonValue;
    if (trimmed.length === 0) {
      input = {} as JsonValue;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw protocolError();
      }
      if (!isPlainObject(parsed)) {
        throw protocolError();
      }
      input = parsed as JsonValue;
    }
    events.push({
      type: "tool_call",
      id: entry.id,
      name: entry.name,
      input,
    });
  }

  state.toolsEmitted = true;
}

function handleFinishReason(
  state: OpenAIState,
  reason: string,
  events: ModelStreamEvent[],
): void {
  state.sawFinishReason = true;
  state.finishReason = reason;

  if (reason === "stop") {
    if (state.toolCalls.size > 0) {
      throw protocolError();
    }
    return;
  }

  if (reason === "tool_calls") {
    emitToolCalls(state, events);
    return;
  }

  // length, content_filter, function_call and anything unknown are truncations
  // or unsupported outcomes, never a success.
  throw protocolError();
}

function handleChoices(
  state: OpenAIState,
  choices: unknown,
  events: ModelStreamEvent[],
): void {
  if (!Array.isArray(choices)) {
    throw protocolError();
  }
  if (choices.length === 0) {
    // The terminal usage-only chunk has no choices.
    return;
  }
  if (choices.length > 1) {
    // This stage only supports n = 1.
    throw protocolError();
  }

  const choice = choices[0];
  if (!isPlainObject(choice)) {
    throw protocolError();
  }
  if (choice.index !== undefined && choice.index !== 0) {
    throw protocolError();
  }

  const delta = choice.delta;
  if (delta !== undefined && delta !== null) {
    if (!isPlainObject(delta)) {
      throw protocolError();
    }
    handleDelta(state, delta, events);
  }

  const finishReason = choice.finish_reason;
  if (finishReason !== undefined && finishReason !== null) {
    if (typeof finishReason !== "string") {
      throw protocolError();
    }
    if (state.sawFinishReason) {
      throw protocolError();
    }
    handleFinishReason(state, finishReason, events);
  }
}

function handleUsage(
  state: OpenAIState,
  usage: unknown,
  events: ModelStreamEvent[],
): void {
  if (usage === undefined || usage === null) {
    return;
  }
  if (!isPlainObject(usage)) {
    throw protocolError();
  }

  const prompt = readTokenCount(usage.prompt_tokens);
  const completion = readTokenCount(usage.completion_tokens);

  if (prompt !== undefined) {
    state.promptTokens = prompt;
  }
  if (completion !== undefined) {
    state.completionTokens = completion;
  }

  // Usage is only reported when the provider actually sent it; zero values are
  // never fabricated.
  if (prompt !== undefined && completion !== undefined) {
    events.push({
      type: "usage",
      inputTokens: prompt,
      outputTokens: completion,
    });
  }
}

function handleDone(state: OpenAIState): readonly ModelStreamEvent[] {
  if (!state.sawFinishReason) {
    throw protocolError();
  }
  if (state.finishReason === "tool_calls" && !state.toolsEmitted) {
    throw protocolError();
  }
  state.terminal = true;
  return [{ type: "completed" }];
}

const openAIChatDecoder: FrameDecoder<OpenAIState> = {
  createState(options: NormalizedDecodeOptions): OpenAIState {
    return {
      maxToolInputBytes: options.maxToolInputBytes,
      sawFinishReason: false,
      finishReason: null,
      toolsEmitted: false,
      terminal: false,
      promptTokens: null,
      completionTokens: null,
      toolCalls: new Map<number, ToolCallState>(),
    };
  },

  handleFrame(state, frame: SseEvent): readonly ModelStreamEvent[] {
    if (frame.data.trim() === DONE_SENTINEL) {
      return handleDone(state);
    }

    const payload = parseJsonObjectFrame(frame.data);

    if (payload.error !== undefined && payload.error !== null) {
      state.terminal = true;
      return [streamErrorEvent(mapOpenAIError(payload.error))];
    }

    const choices = payload.choices;
    const usage = payload.usage;

    if (choices === undefined && usage === undefined) {
      throw protocolError();
    }

    const events: ModelStreamEvent[] = [];
    if (choices !== undefined) {
      handleChoices(state, choices, events);
    }
    handleUsage(state, usage, events);
    return events;
  },

  isTerminal(state: OpenAIState): boolean {
    return state.terminal;
  },

  finish(): readonly ModelStreamEvent[] {
    // EOF without [DONE] is a truncated response.
    throw protocolError();
  },
};

/**
 * Decodes an OpenAI Chat Completions SSE byte stream into ModelStreamEvents.
 *
 * Invalid options throw synchronously; every other failure is reported as a
 * ModelStreamEvent error event.
 */
export function decodeOpenAIChatCompletionsStream(
  source: AsyncIterable<Uint8Array>,
  options: StreamDecodeOptions = {},
): AsyncIterable<ModelStreamEvent> {
  const normalized = normalizeDecodeOptions(options);
  return decodeFrameStream(source, normalized, openAIChatDecoder);
}
