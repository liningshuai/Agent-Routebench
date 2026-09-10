import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import { createOpenAIChatCompletionsAdapter } from "../packages/model-gateway/src/index.js";
import {
  SSE_DONE,
  bytes,
  collectEvents,
  dataFrame,
  fromChunks,
  splitBytes,
  textOf,
} from "./helpers/adapter-fixtures.js";

const adapter = createOpenAIChatCompletionsAdapter();

/** Builds a chat.completion.chunk with a single choice. */
function choiceChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  index = 0,
): string {
  return dataFrame({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "offline-model",
    choices: [{ index, delta, finish_reason: finishReason }],
  });
}

function usageChunk(
  promptTokens: number,
  completionTokens: number,
): string {
  return dataFrame({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "offline-model",
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function toolCallDelta(
  index: number,
  fragment: {
    id?: string;
    name?: string;
    arguments?: string;
    type?: string;
  },
): string {
  const call: Record<string, unknown> = { index };
  if (fragment.id !== undefined) {
    call.id = fragment.id;
  }
  if (fragment.type !== undefined) {
    call.type = fragment.type;
  }
  if (fragment.name !== undefined || fragment.arguments !== undefined) {
    const fn: Record<string, unknown> = {};
    if (fragment.name !== undefined) {
      fn.name = fragment.name;
    }
    if (fragment.arguments !== undefined) {
      fn.arguments = fragment.arguments;
    }
    call.function = fn;
  }
  return choiceChunk({ tool_calls: [call] });
}

async function decode(payloads: readonly string[]): Promise<ModelStreamEvent[]> {
  return collectEvents(adapter.decode(fromChunks([bytes(payloads.join(""))])));
}

function expectSingleError(events: readonly ModelStreamEvent[]): string {
  const errors = events.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
  expect(events[events.length - 1]).toEqual(errors[0]);
  return errors[0].type === "error" ? errors[0].code : "";
}

describe("task 3 openai chat stream — text", () => {
  it("emits text deltas, usage and a single completed", async () => {
    const events = await decode([
      choiceChunk({ role: "assistant", content: "" }),
      choiceChunk({ content: "Hello" }),
      choiceChunk({ content: ", " }),
      choiceChunk({ content: "world" }),
      choiceChunk({}, "stop"),
      usageChunk(12, 7),
      SSE_DONE,
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", " },
      { type: "text_delta", text: "world" },
      { type: "usage", inputTokens: 12, outputTokens: 7 },
      { type: "completed" },
    ]);
  });

  it("ignores a role only chunk and empty text fragments", async () => {
    const events = await decode([
      choiceChunk({ role: "assistant" }),
      choiceChunk({ content: "" }),
      choiceChunk({ content: "only" }),
      choiceChunk({ content: "" }),
      choiceChunk({}, "stop"),
      SSE_DONE,
    ]);

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "only" },
    ]);
  });

  it("does not fabricate usage when the provider never sends it", async () => {
    const events = await decode([
      choiceChunk({ content: "hi" }),
      choiceChunk({}, "stop"),
      SSE_DONE,
    ]);

    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(events[events.length - 1]).toEqual({ type: "completed" });
  });

  it("keeps reading after finish_reason to collect the trailing usage chunk", async () => {
    const events = await decode([
      choiceChunk({ content: "done" }),
      choiceChunk({}, "stop"),
      usageChunk(3, 4),
      SSE_DONE,
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "done" },
      { type: "usage", inputTokens: 3, outputTokens: 4 },
      { type: "completed" },
    ]);
  });

  it("decodes when the byte stream is split into single byte chunks", async () => {
    const payload = [
      choiceChunk({ content: "\u4f60\u597d" }),
      choiceChunk({}, "stop"),
      usageChunk(1, 2),
      SSE_DONE,
    ].join("");

    const events = await collectEvents(
      adapter.decode(fromChunks(splitBytes(bytes(payload), 1))),
    );

    expect(textOf(events)).toBe("\u4f60\u597d");
    expect(events[events.length - 1]).toEqual({ type: "completed" });
  });
});

describe("task 3 openai chat stream — tool calls", () => {
  it("assembles a tool call from streamed argument fragments", async () => {
    const events = await decode([
      choiceChunk({ role: "assistant" }),
      toolCallDelta(0, { id: "call_1", type: "function", name: "read_file" }),
      toolCallDelta(0, { arguments: '{"pa' }),
      toolCallDelta(0, { arguments: 'th":"a.txt"}' }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);

    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "read_file",
        input: { path: "a.txt" },
      },
      { type: "completed" },
    ]);
  });

  it("emits parallel tool calls ordered by index regardless of arrival order", async () => {
    const events = await decode([
      toolCallDelta(1, { id: "call_b", type: "function", name: "beta" }),
      toolCallDelta(0, { id: "call_a", type: "function", name: "alpha" }),
      toolCallDelta(1, { arguments: '{"b":2}' }),
      toolCallDelta(0, { arguments: '{"a":1}' }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);

    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_a", name: "alpha", input: { a: 1 } },
      { type: "tool_call", id: "call_b", name: "beta", input: { b: 2 } },
    ]);
  });

  it("treats an empty argument string as an empty object", async () => {
    const events = await decode([
      toolCallDelta(0, { id: "call_e", type: "function", name: "ping" }),
      toolCallDelta(0, { arguments: "" }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "call_e",
      name: "ping",
      input: {},
    });
  });

  it("preserves nested tool arguments losslessly", async () => {
    const input = { filters: { tags: ["a", "b"] }, flags: [true, null, 1.5] };
    const json = JSON.stringify(input);
    const events = await decode([
      toolCallDelta(0, { id: "call_n", type: "function", name: "search" }),
      toolCallDelta(0, { arguments: json.slice(0, 9) }),
      toolCallDelta(0, { arguments: json.slice(9) }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "call_n",
      name: "search",
      input,
    });
  });

  it("keeps a text part and tool calls together", async () => {
    const events = await decode([
      choiceChunk({ content: "calling a tool" }),
      toolCallDelta(0, { id: "call_t", type: "function", name: "alpha" }),
      toolCallDelta(0, { arguments: "{}" }),
      choiceChunk({}, "tool_calls"),
      usageChunk(5, 6),
      SSE_DONE,
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "calling a tool" },
      { type: "tool_call", id: "call_t", name: "alpha", input: {} },
      { type: "usage", inputTokens: 5, outputTokens: 6 },
      { type: "completed" },
    ]);
  });
});

describe("task 3 openai chat stream — protocol violations", () => {
  it("rejects malformed JSON", async () => {
    const events = await decode(["data: {broken}\n\n", SSE_DONE]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects invalid UTF-8", async () => {
    const events = await collectEvents(
      adapter.decode(
        fromChunks([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a])]),
      ),
    );
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a conflicting tool call id for the same index", async () => {
    const events = await decode([
      toolCallDelta(0, { id: "call_1", type: "function", name: "alpha" }),
      toolCallDelta(0, { id: "call_2" }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a conflicting tool call name for the same index", async () => {
    const events = await decode([
      toolCallDelta(0, { id: "call_1", type: "function", name: "alpha" }),
      toolCallDelta(0, { name: "beta" }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a tool call that never receives an id or a name", async () => {
    const events = await decode([
      toolCallDelta(0, { arguments: "{}" }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects truncated tool arguments at finish_reason", async () => {
    const events = await decode([
      toolCallDelta(0, { id: "call_1", type: "function", name: "alpha" }),
      toolCallDelta(0, { arguments: '{"unfinished":' }),
      choiceChunk({}, "tool_calls"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects unsupported finish reasons", async () => {
    for (const finishReason of ["length", "content_filter", "function_call"]) {
      const events = await decode([
        choiceChunk({ content: "partial" }),
        choiceChunk({}, finishReason),
        SSE_DONE,
      ]);
      expect(expectSingleError(events), finishReason).toBe(
        "provider_protocol_error",
      );
    }
  });

  it("rejects a refusal delta", async () => {
    const events = await decode([
      choiceChunk({ refusal: "I cannot help with that" }),
      choiceChunk({}, "stop"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects the legacy function_call delta shape", async () => {
    const events = await decode([
      choiceChunk({ function_call: { name: "alpha", arguments: "{}" } }),
      choiceChunk({}, "stop"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects vendor reasoning extensions", async () => {
    const events = await decode([
      choiceChunk({ reasoning_content: "thinking out loud" }),
      choiceChunk({}, "stop"),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects more than one choice", async () => {
    const events = await decode([
      dataFrame({
        choices: [
          { index: 0, delta: { content: "a" }, finish_reason: null },
          { index: 1, delta: { content: "b" }, finish_reason: null },
        ],
      }),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a choice index other than zero", async () => {
    const events = await decode([choiceChunk({ content: "a" }, null, 1), SSE_DONE]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a chunk that is neither a choice nor a usage payload", async () => {
    const events = await decode([
      dataFrame({ id: "chatcmpl-fixture", object: "chat.completion.chunk" }),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects an invalid usage payload", async () => {
    const events = await decode([
      choiceChunk({ content: "x" }),
      choiceChunk({}, "stop"),
      dataFrame({
        choices: [],
        usage: { prompt_tokens: -1, completion_tokens: 2 },
      }),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects EOF without the done sentinel", async () => {
    const events = await decode([
      choiceChunk({ content: "x" }),
      choiceChunk({}, "stop"),
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects the done sentinel without a finish reason", async () => {
    const events = await decode([choiceChunk({ content: "x" }), SSE_DONE]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects an empty stream", async () => {
    const events = await collectEvents(adapter.decode(fromChunks([])));
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("does not accept a truncated turn as a success", async () => {
    const events = await decode([
      choiceChunk({ content: "start of a longer answer" }),
      SSE_DONE,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
  });

  it("stops consuming input once a terminal event has been emitted", async () => {
    const consumed: string[] = [];
    async function* tracked(): AsyncGenerator<Uint8Array> {
      for (const payload of [
        choiceChunk({ content: "ok" }),
        choiceChunk({}, "stop"),
        SSE_DONE,
        choiceChunk({ content: "garbage after done" }),
      ]) {
        consumed.push(payload);
        yield bytes(payload);
      }
    }

    const events = await collectEvents(adapter.decode(tracked()));

    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(textOf(events)).toBe("ok");
    expect(consumed.length).toBeLessThan(4);
  });
});

describe("task 3 openai chat stream — upstream errors", () => {
  it("maps a structured rate limit error", async () => {
    const events = await decode([
      dataFrame({
        error: {
          message: "Rate limit reached for requests",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      }),
    ]);

    expect(events).toEqual([
      {
        type: "error",
        code: "rate_limited",
        message: "The upstream provider rate limited this request.",
        retryable: true,
      },
    ]);
  });

  it("maps a structured server error to upstream availability", async () => {
    const events = await decode([
      dataFrame({
        error: { message: "The server had an error", type: "server_error" },
      }),
    ]);

    expect(events[0]).toEqual({
      type: "error",
      code: "upstream_unavailable",
      message: "The upstream provider is currently unavailable.",
      retryable: true,
    });
  });

  it("never leaks the raw upstream error payload", async () => {
    const secret = "TOP_SECRET_FIXTURE_VALUE";
    const events = await decode([
      dataFrame({
        error: {
          message: `POST https://provider.invalid/v1 failed with Bearer ${secret}`,
          type: "invalid_request_error",
          code: "bad_request",
        },
      }),
    ]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/bearer/i);
    expect(events[0]).toEqual({
      type: "error",
      code: "gateway_error",
      message: "Model gateway request failed.",
      retryable: false,
    });
  });

  it("does not guess the error class from free text", async () => {
    const events = await decode([
      dataFrame({
        error: { message: "too many requests, please slow down", type: "api_error" },
      }),
    ]);

    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].code).toBe("gateway_error");
    }
  });
});
