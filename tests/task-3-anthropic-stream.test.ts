import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import { createAnthropicMessagesAdapter } from "../packages/model-gateway/src/index.js";
import {
  anthropicFrame as frame,
  bytes,
  collectEvents,
  concatBytes,
  createCountingSource,
  fromChunks,
  splitBytes,
  textOf,
} from "./helpers/adapter-fixtures.js";

const adapter = createAnthropicMessagesAdapter();

function stream(frames: readonly string[]): Uint8Array[] {
  return [bytes(frames.join(""))];
}

function messageStart(inputTokens = 25, outputTokens = 1): string {
  return frame({
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [],
      model: "offline-model",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  });
}

function textBlock(index = 0): string {
  return frame({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

function textDelta(text: string, index = 0): string {
  return frame({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function toolBlock(
  index: number,
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): string {
  return frame({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input },
  });
}

function jsonDelta(partialJson: string, index: number): string {
  return frame({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

function blockStop(index: number): string {
  return frame({ type: "content_block_stop", index });
}

function messageDelta(stopReason: string, outputTokens?: number): string {
  const payload: Record<string, unknown> = {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
  };
  if (outputTokens !== undefined) {
    payload.usage = { output_tokens: outputTokens };
  }
  return frame(payload);
}

const messageStop = frame({ type: "message_stop" });
const ping = frame({ type: "ping" });

async function decode(frames: readonly string[]): Promise<ModelStreamEvent[]> {
  return collectEvents(adapter.decode(fromChunks(stream(frames))));
}

function expectTail(
  events: readonly ModelStreamEvent[],
  inputTokens: number,
  outputTokens: number,
): void {
  expect(events.slice(-2)).toEqual([
    { type: "usage", inputTokens, outputTokens },
    { type: "completed" },
  ]);
}

function expectSingleError(events: readonly ModelStreamEvent[]): string {
  const errors = events.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
  expect(events[events.length - 1]).toEqual(errors[0]);
  return errors[0].type === "error" ? errors[0].code : "";
}

describe("task 3 anthropic stream — text", () => {
  it("emits text deltas in order and ends with usage and completed", async () => {
    const events = await decode([
      messageStart(25, 1),
      textBlock(0),
      textDelta("Hello"),
      textDelta(", "),
      textDelta("world"),
      blockStop(0),
      messageDelta("end_turn", 15),
      messageStop,
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", " },
      { type: "text_delta", text: "world" },
      { type: "usage", inputTokens: 25, outputTokens: 15 },
      { type: "completed" },
    ]);
  });

  it("ignores ping keep alive events", async () => {
    const events = await decode([
      messageStart(5, 1),
      ping,
      textBlock(0),
      textDelta("hi"),
      ping,
      blockStop(0),
      messageDelta("end_turn", 7),
      ping,
      messageStop,
    ]);

    expect(textOf(events)).toBe("hi");
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("ping");
  });

  it("produces exactly one usage and one completed even with many message_delta events", async () => {
    const events = await decode([
      messageStart(10, 1),
      textBlock(0),
      textDelta("a"),
      messageDelta("end_turn", 5),
      messageDelta("end_turn", 12),
      blockStop(0),
      messageStop,
    ]);

    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expectTail(events, 10, 12);
  });

  it("updates output tokens with the cumulative value instead of summing", async () => {
    const events = await decode([
      messageStart(40, 0),
      messageDelta("end_turn", 3),
      messageDelta("end_turn", 9),
      messageDelta("end_turn", 21),
      messageStop,
    ]);

    const usage = events.find((event) => event.type === "usage");
    expect(usage).toEqual({ type: "usage", inputTokens: 40, outputTokens: 21 });
  });

  it("decodes correctly when the byte stream is split mid frame and mid character", async () => {
    const payload = [
      messageStart(3, 1),
      textBlock(0),
      textDelta("\u4f60\u597d\ud83d\ude80"),
      blockStop(0),
      messageDelta("end_turn", 4),
      messageStop,
    ].join("");

    const events = await collectEvents(
      adapter.decode(fromChunks(splitBytes(bytes(payload), 1))),
    );

    expect(textOf(events)).toBe("\u4f60\u597d\ud83d\ude80");
    expectTail(events, 3, 4);
  });
});

describe("task 3 anthropic stream — tool use", () => {
  it("emits a tool call parsed from partial json", async () => {
    const events = await decode([
      messageStart(11, 1),
      toolBlock(0, "toolu_1", "read_file"),
      jsonDelta('{"pa', 0),
      jsonDelta('th":"a.txt"}', 0),
      blockStop(0),
      messageDelta("tool_use", 20),
      messageStop,
    ]);

    expect(events).toEqual([
      {
        type: "tool_call",
        id: "toolu_1",
        name: "read_file",
        input: { path: "a.txt" },
      },
      { type: "usage", inputTokens: 11, outputTokens: 20 },
      { type: "completed" },
    ]);
  });

  it("keeps parallel tool arguments on their own block index", async () => {
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_a", "alpha"),
      toolBlock(1, "toolu_b", "beta"),
      jsonDelta('{"a"', 1),
      jsonDelta('{"x"', 0),
      jsonDelta(":1}", 0),
      jsonDelta(":2}", 1),
      blockStop(0),
      blockStop(1),
      messageDelta("tool_use", 9),
      messageStop,
    ]);

    const calls = events.filter((event) => event.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", id: "toolu_a", name: "alpha", input: { x: 1 } },
      { type: "tool_call", id: "toolu_b", name: "beta", input: { a: 2 } },
    ]);
  });

  it("accepts a tool call with no argument deltas as an empty object", async () => {
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_empty", "ping"),
      blockStop(0),
      messageDelta("tool_use", 2),
      messageStop,
    ]);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "toolu_empty",
      name: "ping",
      input: {},
    });
  });

  it("preserves nested tool arguments losslessly", async () => {
    const input = { filters: { tags: ["a", "b"], limit: 3 }, flags: [true, null, 1.5] };
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_nested", "search"),
      jsonDelta(JSON.stringify(input).slice(0, 7), 0),
      jsonDelta(JSON.stringify(input).slice(7), 0),
      blockStop(0),
      messageDelta("tool_use", 2),
      messageStop,
    ]);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "toolu_nested",
      name: "search",
      input,
    });
  });

  it("never emits a tool call when the turn was truncated", async () => {
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_cut", "read_file"),
      jsonDelta('{"path":"a.txt"}', 0),
      blockStop(0),
      messageDelta("max_tokens", 2),
      messageStop,
    ]);

    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a tool block whose arguments are not a JSON object", async () => {
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_bad", "read_file"),
      jsonDelta('"just a string"', 0),
      blockStop(0),
      messageDelta("tool_use", 2),
      messageStop,
    ]);

    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects truncated tool arguments", async () => {
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_bad", "read_file"),
      jsonDelta('{"path":', 0),
      blockStop(0),
      messageDelta("tool_use", 2),
      messageStop,
    ]);

    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a duplicated tool_use id", async () => {
    const events = await decode([
      messageStart(1, 1),
      toolBlock(0, "toolu_dup", "alpha"),
      blockStop(0),
      toolBlock(1, "toolu_dup", "beta"),
      blockStop(1),
      messageDelta("tool_use", 2),
      messageStop,
    ]);

    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });
});

describe("task 3 anthropic stream — protocol violations", () => {
  it("rejects malformed JSON in a data frame", async () => {
    const events = await decode([messageStart(), 'data: {"type": broken}\n\n']);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a duplicated content block index", async () => {
    const events = await decode([
      messageStart(),
      textBlock(0),
      textBlock(0),
      blockStop(0),
      messageDelta("end_turn", 1),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a delta for a block that never started", async () => {
    const events = await decode([
      messageStart(),
      textDelta("orphan", 7),
      messageDelta("end_turn", 1),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a stop for a block that never started", async () => {
    const events = await decode([
      messageStart(),
      blockStop(3),
      messageDelta("end_turn", 1),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a message_stop while a block is still open", async () => {
    const events = await decode([
      messageStart(),
      textBlock(0),
      textDelta("dangling"),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects message_stop without message_start", async () => {
    const events = await decode([messageStop]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a duplicated message_start", async () => {
    const events = await decode([messageStart(), messageStart(), messageStop]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects unsupported stop reasons", async () => {
    for (const stopReason of ["stop_sequence", "refusal", "pause_turn"]) {
      const events = await decode([
        messageStart(),
        textBlock(0),
        textDelta("partial"),
        blockStop(0),
        messageDelta(stopReason, 1),
        messageStop,
      ]);
      expect(expectSingleError(events), stopReason).toBe("provider_protocol_error");
    }
  });

  it("rejects thinking and signature deltas as unsupported content", async () => {
    const events = await decode([
      messageStart(),
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");

    const signature = await decode([
      messageStart(),
      textBlock(0),
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "abc" },
      }),
      blockStop(0),
      messageDelta("end_turn", 1),
      messageStop,
    ]);
    expect(expectSingleError(signature)).toBe("provider_protocol_error");
  });

  it("rejects server side tool blocks", async () => {
    const events = await decode([
      messageStart(),
      frame({
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srv_1", name: "web_search" },
      }),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects an unknown business event type", async () => {
    const events = await decode([
      messageStart(),
      frame({ type: "some_future_event", payload: 1 }),
      messageStop,
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects a non zero cache token count instead of reporting a misleading total", async () => {
    const events = await decode([
      frame({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 5,
          },
        },
      }),
      messageStop,
    ]);

    expect(events.filter((event) => event.type === "usage")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("accepts an explicit zero cache token count", async () => {
    const events = await decode([
      frame({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      textBlock(0),
      textDelta("ok"),
      blockStop(0),
      messageDelta("end_turn", 2),
      messageStop,
    ]);

    expectTail(events, 10, 2);
  });

  it("rejects a data frame that is not a JSON object", async () => {
    const events = await decode([messageStart(), "data: 42\n\n", messageStop]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");

    const fromDone = await decode([messageStart(), "data: [DONE]\n\n"]);
    expect(expectSingleError(fromDone)).toBe("provider_protocol_error");
  });

  it("stops consuming input after the first terminal event", async () => {
    const consumed: string[] = [];
    async function* tracked(): AsyncGenerator<Uint8Array> {
      for (const chunk of [
        messageStart(),
        textBlock(0),
        textDelta("ok"),
        blockStop(0),
        messageDelta("end_turn", 2),
        messageStop,
        textDelta("garbage after completion"),
        frame({ type: "unknown_event" }),
      ]) {
        consumed.push(chunk);
        yield bytes(chunk);
      }
    }

    const events = await collectEvents(adapter.decode(tracked()));

    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(textOf(events)).toBe("ok");
    expect(consumed.length).toBeLessThan(9);
  });
});

describe("task 3 anthropic stream — rework: initial tool input validation", () => {
  function startBlock(
    inputJson: string | null,
    index = 0,
    id = "toolu_1",
    name = "read_file",
  ): string {
    const inputPart = inputJson === null ? "" : `,"input":${inputJson}`;
    return `event: content_block_start\ndata: {"type":"content_block_start","index":${index},"content_block":{"type":"tool_use","id":"${id}","name":"${name}"${inputPart}}}\n\n`;
  }

  function streamWith(
    inputJson: string | null,
    deltas: readonly string[] = [],
  ): string {
    return [
      messageStart(1, 1),
      startBlock(inputJson),
      ...deltas.map((fragment) => jsonDelta(fragment, 0)),
      blockStop(0),
      messageDelta("tool_use", 2),
      messageStop,
    ].join("");
  }

  it("rejects a tool_use block whose initial input is not an object", async () => {
    for (const raw of ["[]", "null", '"{}"', "123", "false", '"text"']) {
      const events = await decode([streamWith(raw)]);
      expect(expectSingleError(events), raw).toBe("provider_protocol_error");
      expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    }
  });

  it("rejects a tool_use block with no input field at all", async () => {
    const events = await decode([streamWith(null)]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("accepts an empty initial object", async () => {
    const events = await decode([streamWith("{}")]);
    expect(events[0]).toEqual({
      type: "tool_call",
      id: "toolu_1",
      name: "read_file",
      input: {},
    });
    expect(events[events.length - 1]).toEqual({ type: "completed" });
  });

  it("accepts a non empty initial object with no argument deltas", async () => {
    const events = await decode([streamWith('{"path":"a.txt","n":2}')]);
    expect(events[0]).toEqual({
      type: "tool_call",
      id: "toolu_1",
      name: "read_file",
      input: { path: "a.txt", n: 2 },
    });
    expect(events[events.length - 1]).toEqual({ type: "completed" });
  });

  it("still supports an empty initial object plus streamed deltas", async () => {
    const events = await decode([
      streamWith("{}", ['{"pa', 'th":"a.txt"}']),
    ]);

    expect(events[0]).toEqual({
      type: "tool_call",
      id: "toolu_1",
      name: "read_file",
      input: { path: "a.txt" },
    });
    expect(events[events.length - 1]).toEqual({ type: "completed" });
  });

  it("rejects a non empty initial object combined with argument deltas", async () => {
    const events = await decode([
      streamWith('{"path":"a.txt"}', ['{"other":1}']),
    ]);

    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects an initial object larger than the tool input limit", async () => {
    const oversized = `{"path":"${"a".repeat(64)}"}`;

    const accepted = await decode([streamWith(oversized)]);
    expect(accepted[0]?.type).toBe("tool_call");

    const rejected = await collectEvents(
      adapter.decode(fromChunks(stream([streamWith(oversized)])), {
        maxToolInputBytes: 32,
      }),
    );
    expect(rejected.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(rejected)).toBe("provider_protocol_error");
  });

  it("rejects an initial object containing a non finite number", async () => {
    const events = await decode([streamWith('{"n":1e400}')]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects streamed arguments that parse to a non finite number", async () => {
    const events = await decode([streamWith("{}", ['{"n":1e400}'])]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("rejects streamed arguments that exceed the tool input limit", async () => {
    const events = await collectEvents(
      adapter.decode(
        fromChunks(stream([streamWith("{}", [`{"p":"${"a".repeat(64)}"}`])])),
        { maxToolInputBytes: 32 },
      ),
    );

    expect(events.filter((event) => event.type === "tool_call")).toEqual([]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });
});

describe("task 3 anthropic stream — rework: terminal boundary", () => {
  const COMPLETE_STREAM = [
    messageStart(1, 1),
    textBlock(0),
    textDelta("ok"),
    blockStop(0),
    messageDelta("end_turn", 2),
    messageStop,
  ].join("");

  it("keeps the completed response when invalid utf-8 follows message_stop", async () => {
    const payload = concatBytes([
      bytes(COMPLETE_STREAM),
      new Uint8Array([0xff, 0xfe]),
      bytes("\n\n"),
    ]);

    const events = await collectEvents(adapter.decode(fromChunks([payload])));

    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed" },
    ]);
  });

  it("does not parse an oversized trailing frame after message_stop", async () => {
    const payload = concatBytes([
      bytes(COMPLETE_STREAM),
      bytes("data: " + "x".repeat(4096)),
    ]);

    const events = await collectEvents(adapter.decode(fromChunks([payload])));

    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  it("keeps a single safe error when garbage follows an upstream error", async () => {
    const payload = concatBytes([
      bytes(
        `${messageStart(1, 1)}${frame({ type: "error", error: { type: "overloaded_error", message: "boom" } })}`,
      ),
      new Uint8Array([0xff, 0xfe]),
      bytes("\n\n"),
    ]);

    const events = await collectEvents(adapter.decode(fromChunks([payload])));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].code).toBe("upstream_unavailable");
    }
  });

  it("still reports invalid utf-8 that appears before message_stop", async () => {
    const payload = concatBytes([
      bytes(`${messageStart(1, 1)}${textBlock(0)}${textDelta("before")}`),
      new Uint8Array([0xff, 0xfe]),
      bytes("\n\n"),
      bytes(`${blockStop(0)}${messageDelta("end_turn", 2)}${messageStop}`),
    ]);

    const events = await collectEvents(adapter.decode(fromChunks([payload])));

    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("keeps already emitted text when a malformed frame appears before termination", async () => {
    const payload = [
      messageStart(1, 1),
      textBlock(0),
      textDelta("first"),
      textDelta("second"),
      "data: {broken}\n\n",
      messageDelta("end_turn", 2),
      messageStop,
    ].join("");

    const events = await collectEvents(adapter.decode(fromChunks([bytes(payload)])));

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "first" },
      { type: "text_delta", text: "second" },
    ]);
    expect(expectSingleError(events)).toBe("provider_protocol_error");
  });

  it("does not read the next source chunk after message_stop", async () => {
    const source = createCountingSource([
      bytes(COMPLETE_STREAM),
      bytes(textDelta("never read")),
    ]);

    const events = await collectEvents(adapter.decode(source.stream));

    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(source.nextCalls).toBe(1);
  });

  it("produces identical events whatever the chunking of the same stream", async () => {
    const payload = [
      messageStart(7, 1),
      textBlock(0),
      textDelta("alpha"),
      textDelta(" beta"),
      blockStop(0),
      messageDelta("end_turn", 9),
      messageStop,
    ].join("");

    const whole = await collectEvents(
      adapter.decode(fromChunks([bytes(payload)])),
    );
    const perFrame = await collectEvents(
      adapter.decode(
        fromChunks([
          messageStart(7, 1),
          textBlock(0),
          textDelta("alpha"),
          textDelta(" beta"),
          blockStop(0),
          messageDelta("end_turn", 9),
          messageStop,
        ].map((frame) => bytes(frame))),
      ),
    );
    const perByte = await collectEvents(
      adapter.decode(fromChunks(splitBytes(bytes(payload), 1))),
    );

    expect(perFrame).toEqual(whole);
    expect(perByte).toEqual(whole);
  });
});

describe("task 3 anthropic stream — upstream errors", () => {
  function errorFrame(type: string, message: string): string {
    return frame({ type: "error", error: { type, message } });
  }

  it("maps a structured rate limit error", async () => {
    const events = await decode([
      messageStart(),
      errorFrame("rate_limit_error", "slow down"),
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

  it("maps a structured overload error to upstream availability", async () => {
    const events = await decode([
      messageStart(),
      errorFrame("overloaded_error", "Overloaded"),
    ]);

    expect(events[0]).toEqual({
      type: "error",
      code: "upstream_unavailable",
      message: "The upstream provider is currently unavailable.",
      retryable: true,
    });
  });

  it("falls back to a gateway error for unknown structured types", async () => {
    const events = await decode([
      messageStart(),
      errorFrame("authentication_error", "invalid x-api-key"),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      code: "gateway_error",
      message: "Model gateway request failed.",
      retryable: false,
    });
  });

  it("never leaks the raw upstream error payload", async () => {
    const secret = "TOP_SECRET_FIXTURE_VALUE";
    const events = await decode([
      messageStart(),
      errorFrame(
        "internal_error",
        `failed calling https://provider.invalid/v1 with Bearer ${secret}`,
      ),
    ]);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/bearer/i);
    expect(serialized).not.toContain("x-api-key");
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
  });

  it("does not guess the error class from free text", async () => {
    const events = await decode([
      messageStart(),
      errorFrame("invalid_request_error", "you are being rate limited, retry later"),
    ]);

    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].code).toBe("gateway_error");
    }
  });
});
