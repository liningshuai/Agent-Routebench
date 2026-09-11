import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import type {
  AgentEvent,
  ModelGateway,
  ModelRequest,
} from "../packages/agent-core/src/index.js";
import { createAgentCore } from "../packages/agent-core/src/index.js";
import {
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter,
  type EncodedModelRequest,
  type ProtocolAdapter,
} from "../packages/model-gateway/src/index.js";
import {
  bytes,
  collectEvents,
  createCountingSource,
  createGatedSource,
  fromChunks,
  makeRequest,
  nextEvent,
  tick,
  toolDefinition,
} from "./helpers/adapter-fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = dirname(__dirname);

const anthropic = createAnthropicMessagesAdapter();
const openai = createOpenAIChatCompletionsAdapter();

const ABORTED: ModelStreamEvent = {
  type: "error",
  code: "aborted",
  message: "Request aborted.",
  retryable: false,
};

/* ------------------------------------------------------------------ *
 * Offline integration: adapter -> gateway wrapper -> Agent Core
 * ------------------------------------------------------------------ */

interface ScriptedGateway {
  readonly gateway: ModelGateway;
  readonly bodies: EncodedModelRequest["body"][];
  readonly requests: ModelRequest[];
  calls(): number;
}

function scriptedGateway(adapter: ProtocolAdapter, payload: string): ScriptedGateway {
  const bodies: EncodedModelRequest["body"][] = [];
  const requests: ModelRequest[] = [];
  let calls = 0;

  const gateway: ModelGateway = {
    stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      calls += 1;
      requests.push(request);
      bodies.push(adapter.encode(request).body);
      return adapter.decode(fromChunks([bytes(payload)]));
    },
  };

  return { gateway, bodies, requests, calls: () => calls };
}

async function runCore(
  gateway: ModelGateway,
  request: ModelRequest,
): Promise<AgentEvent[]> {
  const core = createAgentCore(gateway);
  const events: AgentEvent[] = [];
  for await (const event of core.run(request)) {
    events.push(event);
  }
  return events;
}

const ANTHROPIC_TEXT_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"alpha"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" beta"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const ANTHROPIC_TOOL_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"read_file","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

const OPENAI_TEXT_STREAM = [
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":"alpha"},"finish_reason":null}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":" beta"},"finish_reason":null}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":6,"total_tokens":15}}\n\n',
  "data: [DONE]\n\n",
].join("");

const OPENAI_TOOL_STREAM = [
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"read_file"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
].join("");

const ERROR_STREAM = [
  'data: {"error":{"type":"unexpected_error","message":"POST https://provider.invalid/v1 failed with Bearer TOP_SECRET_INTEGRATION"}}\n\n',
].join("");

const ANTHROPIC_ERROR_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"POST https://provider.invalid/v1 failed with Bearer TOP_SECRET_INTEGRATION"}}\n\n',
].join("");

function agentText(events: readonly AgentEvent[]): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => (event.type === "text_delta" ? event.text : ""))
    .join("");
}

describe("task 3 integration — Anthropic codec through Agent Core", () => {
  it("preserves text order, usage and a single completion", async () => {
    const scripted = scriptedGateway(anthropic, ANTHROPIC_TEXT_STREAM);
    const request = makeRequest({ model: "claude-offline" });

    const events = await runCore(scripted.gateway, request);

    expect(events[0]).toEqual({
      type: "route_selected",
      requestId: "req-t3",
      routeId: "route-t3",
      model: "claude-offline",
    });
    expect(scripted.bodies[0].model).toBe(request.model);
    expect(scripted.bodies[0].max_tokens).toBe(256);
    expect(scripted.bodies[0].stream).toBe(true);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event.type === "text_delta" ? event.text : "")),
    ).toEqual(["alpha", " beta"]);
    expect(events).toContainEqual({
      type: "usage",
      requestId: "req-t3",
      inputTokens: 9,
      outputTokens: 6,
    });
    expect(events.filter((event) => event.type === "completed")).toEqual([
      { type: "completed", requestId: "req-t3" },
    ]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(scripted.calls()).toBe(1);
  });

  it("preserves tool call identity without executing anything", async () => {
    const scripted = scriptedGateway(anthropic, ANTHROPIC_TOOL_STREAM);
    const request = makeRequest({
      tools: [toolDefinition("read_file", "Read", { type: "object" })],
    });

    const events = await runCore(scripted.gateway, request);

    expect(events).toContainEqual({
      type: "tool_call",
      requestId: "req-t3",
      id: "toolu_9",
      name: "read_file",
      input: { path: "a.txt" },
    });
    expect(scripted.calls()).toBe(1);
    expect(events.filter((event) => event.type === "route_selected")).toHaveLength(1);
  });

  it("maps a provider error to exactly one safe Agent error", async () => {
    const scripted = scriptedGateway(anthropic, ANTHROPIC_ERROR_STREAM);
    const request = makeRequest();

    const events = await runCore(scripted.gateway, request);

    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    expect(errors[0]).toEqual({
      type: "error",
      requestId: "req-t3",
      code: "gateway_error",
      message: "Model gateway request failed.",
      retryable: false,
    });
    expect(JSON.stringify(events)).not.toContain("TOP_SECRET_INTEGRATION");
    expect(JSON.stringify(events)).not.toContain("provider.invalid");
  });
});

describe("task 3 integration — OpenAI Chat Completions codec through Agent Core", () => {
  it("preserves text order, usage and a single completion", async () => {
    const scripted = scriptedGateway(openai, OPENAI_TEXT_STREAM);
    const request = makeRequest({ model: "gpt-offline" });

    const events = await runCore(scripted.gateway, request);

    expect(events[0].type).toBe("route_selected");
    expect(scripted.bodies[0].model).toBe("gpt-offline");
    expect(scripted.bodies[0].n).toBe(1);
    expect(scripted.bodies[0].stream).toBe(true);
    expect(scripted.bodies[0].stream_options).toEqual({ include_usage: true });
    expect(agentText(events)).toBe("alpha beta");
    expect(events).toContainEqual({
      type: "usage",
      requestId: "req-t3",
      inputTokens: 9,
      outputTokens: 6,
    });
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(scripted.calls()).toBe(1);
  });

  it("preserves tool call identity without executing anything", async () => {
    const scripted = scriptedGateway(openai, OPENAI_TOOL_STREAM);
    const request = makeRequest();

    const events = await runCore(scripted.gateway, request);

    expect(events).toContainEqual({
      type: "tool_call",
      requestId: "req-t3",
      id: "call_9",
      name: "read_file",
      input: { path: "a.txt" },
    });
    expect(scripted.calls()).toBe(1);
  });

  it("maps a provider error to exactly one safe Agent error", async () => {
    const scripted = scriptedGateway(openai, ERROR_STREAM);
    const events = await runCore(scripted.gateway, makeRequest());

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.filter((event) => event.type === "completed")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("TOP_SECRET_INTEGRATION");
  });

  it("does not modify Agent Core behaviour for adapters", async () => {
    const scripted = scriptedGateway(openai, OPENAI_TEXT_STREAM);
    const before = createAgentCore(scripted.gateway);

    const events: AgentEvent[] = [];
    for await (const event of before.run(
      makeRequest({ requestId: "", maxTokens: 0, messages: [] }),
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("error");
    expect(scripted.calls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Incremental streaming proof
 * ------------------------------------------------------------------ */

describe("task 3 integration — incremental streaming", () => {
  it("emits the first Anthropic text delta before the stream ends", async () => {
    const source = createGatedSource();
    const iterator = anthropic.decode(source.stream)[Symbol.asyncIterator]();

    source.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    );
    source.push(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    source.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n\n',
    );

    const first = await nextEvent(iterator);
    expect(first.value).toEqual({ type: "text_delta", text: "first" });

    source.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"second"}}\n\n',
    );
    const second = await nextEvent(iterator);
    expect(second.value).toEqual({ type: "text_delta", text: "second" });

    source.push(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    );
    source.push(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    );
    source.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    source.close();

    const rest = await collectEvents({ [Symbol.asyncIterator]: () => iterator });
    expect(rest).toEqual([
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed" },
    ]);
  });

  it("emits the first OpenAI text delta before the stream ends", async () => {
    const source = createGatedSource();
    const iterator = openai.decode(source.stream)[Symbol.asyncIterator]();

    source.push(
      'data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n',
    );
    const first = await nextEvent(iterator);
    expect(first.value).toEqual({ type: "text_delta", text: "first" });

    source.push(
      'data: {"choices":[{"index":0,"delta":{"content":"second"},"finish_reason":null}]}\n\n',
    );
    const second = await nextEvent(iterator);
    expect(second.value).toEqual({ type: "text_delta", text: "second" });

    source.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    source.push("data: [DONE]\n\n");
    source.close();

    const rest = await collectEvents({ [Symbol.asyncIterator]: () => iterator });
    expect(rest).toEqual([{ type: "completed" }]);
  });

  it("does not buffer the whole response before the first event", async () => {
    const source = createGatedSource();
    const iterator = anthropic.decode(source.stream)[Symbol.asyncIterator]();

    source.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    );
    source.push(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    source.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
    );

    // The gate is still open and no terminator has been pushed: a buffering
    // implementation would still be waiting here.
    const first = await nextEvent(iterator, 500);
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text_delta", text: "partial" });

    source.close();
    await collectEvents({ [Symbol.asyncIterator]: () => iterator });
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation and upstream lifecycle
 * ------------------------------------------------------------------ */

describe("task 3 integration — cancellation", () => {
  it("emits a single aborted event before consuming a pre-aborted source", async () => {
    for (const adapter of [anthropic, openai]) {
      const source = createCountingSource([bytes('data: {"type":"ping"}\n\n')]);
      const controller = new AbortController();
      controller.abort();

      const events = await collectEvents(
        adapter.decode(source.stream, { signal: controller.signal }),
      );

      expect(events).toEqual([ABORTED]);
      expect(source.nextCalls).toBe(0);
    }
  });

  it("stops with aborted when the signal fires mid stream", async () => {
    const source = createGatedSource();
    const controller = new AbortController();
    const iterator = anthropic
      .decode(source.stream, { signal: controller.signal })
      [Symbol.asyncIterator]();

    source.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    );
    source.push(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    );
    source.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"one"}}\n\n',
    );

    expect((await nextEvent(iterator)).value).toEqual({ type: "text_delta", text: "one" });

    controller.abort();

    const afterAbort = await nextEvent(iterator);
    expect(afterAbort.value).toEqual(ABORTED);
    expect((await nextEvent(iterator)).done).toBe(true);
    expect(source.returnCalls).toBeGreaterThanOrEqual(1);
  });

  it("resolves a pending next() when the signal aborts", async () => {
    let nextCalled = false;
    const hanging: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next: () => {
            nextCalled = true;
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
          return: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        };
      },
    };

    const controller = new AbortController();
    const iterator = openai
      .decode(hanging, { signal: controller.signal })
      [Symbol.asyncIterator]();

    const pending = iterator.next();
    await tick();
    expect(nextCalled).toBe(true);

    controller.abort();

    const result = await pending;
    expect(result.value).toEqual(ABORTED);
  });

  it("does not produce an unhandled rejection when the source fails after abort", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      let rejectPending: ((error: unknown) => void) | undefined;
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () =>
              new Promise<IteratorResult<Uint8Array>>((_, reject) => {
                rejectPending = reject;
              }),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      };

      const controller = new AbortController();
      const iterator = openai
        .decode(source, { signal: controller.signal })
        [Symbol.asyncIterator]();

      const pending = iterator.next();
      await tick();
      controller.abort();

      expect((await pending).value).toEqual(ABORTED);

      rejectPending?.(new Error("late upstream failure"));
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("cleans up the upstream iterator when the consumer stops early", async () => {
    const source = createGatedSource();
    const iterator = openai.decode(source.stream)[Symbol.asyncIterator]();

    source.push(
      'data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n',
    );
    expect((await nextEvent(iterator)).value).toEqual({ type: "text_delta", text: "first" });

    await iterator.return?.(undefined);
    await tick();

    expect(source.returnCalls).toBeGreaterThanOrEqual(1);
  });

  it("converts an upstream exception into one error event", async () => {
    for (const adapter of [anthropic, openai]) {
      const source = createGatedSource();
      const iterator = adapter.decode(source.stream)[Symbol.asyncIterator]();
      source.fail(new Error("socket exploded"));

      const events = await collectEvents({
        [Symbol.asyncIterator]: () => iterator,
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].code).toBe("gateway_error");
        expect(events[0].message).not.toContain("socket exploded");
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency and boundaries
 * ------------------------------------------------------------------ */

describe("task 3 integration — concurrency and boundaries", () => {
  it("keeps concurrent decodes on one adapter instance isolated", async () => {
    const firstSource = createGatedSource();
    const secondSource = createGatedSource();

    const firstIterator = anthropic.decode(firstSource.stream)[Symbol.asyncIterator]();
    const secondIterator = anthropic.decode(secondSource.stream)[Symbol.asyncIterator]();

    const start =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';

    firstSource.push(start);
    secondSource.push(start);
    firstSource.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}\n\n',
    );
    secondSource.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B"}}\n\n',
    );

    expect((await nextEvent(firstIterator)).value).toEqual({ type: "text_delta", text: "A" });
    expect((await nextEvent(secondIterator)).value).toEqual({ type: "text_delta", text: "B" });

    firstSource.push(
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    );
    firstSource.push(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    );
    firstSource.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    firstSource.close();

    expect((await nextEvent(firstIterator)).value).toEqual({
      type: "usage",
      inputTokens: 1,
      outputTokens: 2,
    });
    expect((await nextEvent(firstIterator)).value).toEqual({ type: "completed" });
    expect((await nextEvent(firstIterator)).done).toBe(true);

    // The second decode is untouched by the first one finishing.
    secondSource.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B2"}}\n\n',
    );
    expect((await nextEvent(secondIterator)).value).toEqual({ type: "text_delta", text: "B2" });

    secondSource.close();
    await collectEvents({ [Symbol.asyncIterator]: () => secondIterator });
  });

  it("rejects invalid decode options synchronously", () => {
    for (const adapter of [anthropic, openai]) {
      for (const options of [{ maxFrameBytes: 0 }, { maxToolInputBytes: -1 }]) {
        expect(() => adapter.decode(fromChunks([]), options)).toThrowError(
          expect.objectContaining({ code: "invalid_adapter_options" }),
        );
      }
    }
  });

  it("never calls fetch while encoding or decoding", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const request = makeRequest({
        tools: [toolDefinition("read_file", "Read", { type: "object" })],
      });
      anthropic.encode(request);
      openai.encode(request);
      await collectEvents(anthropic.decode(fromChunks([bytes(ANTHROPIC_TEXT_STREAM)])));
      await collectEvents(openai.decode(fromChunks([bytes(OPENAI_TEXT_STREAM)])));

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("imports no network module and no credential store", () => {
    const adaptersDir = join(root, "packages/model-gateway/src/adapters");
    const files: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else {
          files.push({
            path: relative(root, full).split(sep).join("/"),
            text: readFileSync(full, "utf8"),
          });
        }
      }
    };
    walk(adaptersDir);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.text, file.path).not.toMatch(
        /from\s+["'](node:)?(http|https|http2|net|tls|dns)["']/,
      );
      expect(file.text, file.path).not.toMatch(/\b(undici|axios|node-fetch)\b/);
      expect(file.text, file.path).not.toMatch(/\bfetch\s*\(/);
      expect(file.text, file.path).not.toMatch(
        /\b(CredentialStore|InMemoryCredentialStore|credentialRef)\b/,
      );
      expect(file.text, file.path).not.toMatch(/provider-registry/);
      expect(file.text, file.path).not.toMatch(/agent-core/);
      expect(file.text, file.path).not.toMatch(/\.\.\/\.\.[^"']*\/src\//);
    }
  });
});
