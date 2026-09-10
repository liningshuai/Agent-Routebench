import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_LOOP_LIMITS,
  createAgentLoop,
  type AgentLoopEvent,
  type ModelGateway,
  type ModelRequest,
  type ModelStreamEvent,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutor,
} from "../packages/agent-runtime/src/index.js";
import {
  DeterministicFakeModelGateway,
  ResilientRoutedHttpModelGateway,
  RoutedHttpModelGateway,
} from "../packages/model-gateway/src/index.js";
import {
  anthropicTextStream,
  bytesBody,
  createFakeHttpClient,
  httpResponse,
  makeRouteFixture,
} from "./helpers/http-fixtures.js";
import {
  collect,
  deepFreeze,
  makeRequest,
  recordingExecutor,
  resultFor,
  scriptedGateway,
  textOf,
  toolDefinition,
  typesOf,
  USER_TEXT,
} from "./helpers/runtime-fixtures.js";

const READ = toolDefinition("read_file");

function codeOf(run: () => unknown): string {
  try {
    run();
    return "<no throw>";
  } catch (error) {
    return (error as { code?: string }).code ?? "<no code>";
  }
}

function callEvent(id: string, name: string, input: unknown = { path: "a.txt" }) {
  return { type: "tool_call" as const, id, name, input: input as never };
}

describe("task 6 runtime — exports, defaults and options", () => {
  it("exposes the public factory", () => {
    expect(typeof createAgentLoop).toBe("function");
  });

  it("exposes the documented default limits", () => {
    expect(DEFAULT_AGENT_LOOP_LIMITS).toEqual({
      maxTurns: 8,
      maxToolCallsPerTurn: 16,
      maxToolResultBytes: 65536,
    });
  });

  it("accepts an explicit limit set", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({
      gateway,
      maxTurns: 1,
      maxToolCallsPerTurn: 1,
      maxToolResultBytes: 1024,
    });

    const events = await collect(loop.run(makeRequest()));

    expect(events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-6",
      turns: 1,
    });
  });

  it("rejects a non object options bag", () => {
    for (const value of [null, undefined, 7, "x", [], true]) {
      expect(codeOf(() => createAgentLoop(value as never)), String(value)).toBe(
        "invalid_loop_options",
      );
    }
  });

  it("rejects an options bag without a usable gateway", () => {
    for (const value of [{}, { gateway: null }, { gateway: {} }, { gateway: { stream: 1 } }]) {
      expect(codeOf(() => createAgentLoop(value as never)), JSON.stringify(value)).toBe(
        "invalid_loop_options",
      );
    }
  });

  it("rejects an options bag with an unusable tool executor", () => {
    const gateway = scriptedGateway([]);
    for (const value of [{}, { execute: 1 }, null, "tools"]) {
      expect(
        codeOf(() => createAgentLoop({ gateway, toolExecutor: value } as never)),
        String(value),
      ).toBe("invalid_loop_options");
    }
  });

  it("wraps every invalid numeric limit synchronously", () => {
    const gateway = scriptedGateway([]);
    const bad = [0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "8", null, [], true];

    for (const field of ["maxTurns", "maxToolCallsPerTurn", "maxToolResultBytes"] as const) {
      for (const value of bad) {
        expect(
          codeOf(() => createAgentLoop({ gateway, [field]: value } as never)),
          `${field} accepted ${String(value)}`,
        ).toBe("invalid_loop_options");
      }
    }
  });

  it("does not echo a rejected configuration value in the error message", () => {
    const gateway = scriptedGateway([]);
    try {
      createAgentLoop({ gateway, maxTurns: -4242 } as never);
      throw new Error("expected a synchronous throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("4242");
      expect(message).not.toContain("maxTurns");
    }
  });
});

describe("task 6 runtime — first turn", () => {
  it("emits turn_started before anything else", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "hi" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(events[0]).toEqual({
      type: "turn_started",
      requestId: "req-6",
      turnIndex: 0,
    });
    expect(typesOf(events)).toEqual([
      "turn_started",
      "route_selected",
      "text_delta",
      "completed",
      "loop_completed",
    ]);
  });

  it("reports the selected route and model with the turn index", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "hi" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(events[1]).toEqual({
      type: "route_selected",
      requestId: "req-6",
      turnIndex: 0,
      routeId: "route-6",
      model: "offline-model",
    });
  });

  it("forwards text deltas incrementally and in order", async () => {
    const gateway = scriptedGateway([
      [
        { type: "text_delta", text: "one" },
        { type: "text_delta", text: " two" },
        { type: "text_delta", text: " three" },
        { type: "completed" },
      ],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(textOf(events)).toBe("one two three");
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.turnIndex),
    ).toEqual([0, 0, 0]);
  });

  it("forwards usage with the turn index", async () => {
    const gateway = scriptedGateway([
      [
        { type: "text_delta", text: "hi" },
        { type: "usage", inputTokens: 11, outputTokens: 4 },
        { type: "completed" },
      ],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(events).toContainEqual({
      type: "usage",
      requestId: "req-6",
      turnIndex: 0,
      inputTokens: 11,
      outputTokens: 4,
    });
  });

  it("emits exactly one completed and one loop_completed", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "hi" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-6",
      turns: 1,
    });
  });

  it("does not call the gateway when pre-cancelled", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(loop.run(makeRequest(), controller.signal));

    expect(gateway.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "aborted",
      message: "Request aborted.",
      retryable: false,
    });
  });
});

describe("task 6 runtime — input immutability", () => {
  it("never mutates the caller request, messages or tools", async () => {
    const request = deepFreeze(
      makeRequest({ tools: [READ] }),
    ) as ModelRequest;
    const gateway = scriptedGateway([
      [
        callEvent("call-1", "read_file"),
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const snapshot = JSON.stringify(request);
    const messagesRef = request.messages;
    const toolsRef = request.tools;

    const events = await collect(loop.run(request));

    expect(JSON.stringify(request)).toBe(snapshot);
    expect(request.messages).toBe(messagesRef);
    expect(request.tools).toBe(toolsRef);
    expect(request.messages).toHaveLength(1);
    expect(textOf(events)).toBe("done");
    expect(events.at(-1)?.type).toBe("loop_completed");
  });

  it("builds a fresh immutable message array for every turn", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    await collect(loop.run(makeRequest({ tools: [READ] })));

    const first = gateway.calls[0];
    const second = gateway.calls[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.messages).not.toBe(first?.messages);
    expect(second?.messages).toHaveLength(3);
    expect(first?.messages).toHaveLength(1);
    expect(second?.requestId).toBe(first?.requestId);
    expect(second?.routeId).toBe(first?.routeId);
    expect(second?.model).toBe(first?.model);
    expect(second?.maxTokens).toBe(first?.maxTokens);
    expect(second?.tools).toEqual(first?.tools);
  });
});

describe("task 6 runtime — multi turn tool calls", () => {
  it("runs a tool call, then asks the model again", async () => {
    const gateway = scriptedGateway([
      [
        { type: "text_delta", text: "looking" },
        callEvent("call-1", "read_file"),
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("file body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls).toHaveLength(2);
    expect(typesOf(events)).toEqual([
      "turn_started",
      "route_selected",
      "text_delta",
      "tool_call",
      "completed",
      "tool_execution_started",
      "tool_execution_completed",
      "turn_started",
      "route_selected",
      "text_delta",
      "completed",
      "loop_completed",
    ]);
    expect(events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-6",
      turns: 2,
    });
  });

  it("appends the assistant tool call and the tool result in order", async () => {
    const gateway = scriptedGateway([
      [
        { type: "text_delta", text: "looking" },
        callEvent("call-1", "read_file", { path: "a.txt" }),
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("file body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: USER_TEXT }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            input: { path: "a.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            content: "file body",
          },
        ],
      },
    ]);
  });

  it("preserves the tool call id and never rewrites it", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-abc-123", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    const toolCall = events.find((event) => event.type === "tool_call");
    expect(toolCall).toMatchObject({ id: "call-abc-123", name: "read_file" });
    expect(tools.requests[0]?.id).toBe("call-abc-123");

    const assistant = gateway.calls[1]?.messages[1];
    expect(assistant?.content[0]).toMatchObject({ type: "tool_call", id: "call-abc-123" });
    const toolMessage = gateway.calls[1]?.messages[2];
    expect(toolMessage?.content[0]).toMatchObject({ toolCallId: "call-abc-123" });
  });

  it("executes several tool calls strictly serially and in order", async () => {
    const gateway = scriptedGateway([
      [
        callEvent("call-a", "read_file", { path: "a" }),
        callEvent("call-b", "read_file", { path: "b" }),
        callEvent("call-c", "read_file", { path: "c" }),
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor((request) => resultFor(`body:${request.id}`));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.order).toEqual(["call-a", "call-b", "call-c"]);
    expect(tools.maxConcurrent()).toBe(1);
    expect(
      events
        .filter((event) => event.type === "tool_execution_completed")
        .map((event) => event.toolCallId),
    ).toEqual(["call-a", "call-b", "call-c"]);
  });

  it("keeps each tool result with its own call", async () => {
    const gateway = scriptedGateway([
      [
        callEvent("call-a", "read_file", { path: "a" }),
        callEvent("call-b", "read_file", { path: "b" }),
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor((request) => resultFor(`body-${request.id}`));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls[1]?.messages[2]).toEqual({
      role: "tool",
      content: [
        { type: "tool_result", toolCallId: "call-a", content: "body-call-a" },
        { type: "tool_result", toolCallId: "call-b", content: "body-call-b" },
      ],
    });
  });

  it("handles several consecutive tool turns", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [callEvent("call-2", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "finally" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls).toHaveLength(3);
    expect(tools.order).toEqual(["call-1", "call-2"]);
    expect(events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-6",
      turns: 3,
    });
  });

  it("never emits loop_completed on an intermediate turn", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [callEvent("call-2", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "finally" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(3);
    expect(
      events.filter((event) => event.type === "turn_started").map((event) => event.turnIndex),
    ).toEqual([0, 1, 2]);
  });

  it("tags every event of a turn with that turn index", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    const secondTurn = events.filter(
      (event) => event.type !== "loop_completed" && event.turnIndex === 1,
    );
    expect(secondTurn.length).toBeGreaterThan(0);
    expect(
      events
        .filter((event) => event.type === "tool_execution_started")
        .map((event) => event.turnIndex),
    ).toEqual([0]);
  });

  it("continues after a tool failure so the model can recover", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "recovered" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => {
      throw new Error("ENOENT /home/user/secret.txt TOP_SECRET_VALUE");
    });
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("loop_completed");
    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: true,
    });
    expect(gateway.calls[1]?.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-1",
          content: "Tool execution failed.",
          isError: true,
        },
      ],
    });
  });

  it("marks a tool result reported as an error without failing the loop", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "noted" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("could not read", true));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: true,
    });
    expect(gateway.calls[1]?.messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      content: "could not read",
      isError: true,
    });
  });
});

describe("task 6 runtime — turn budget", () => {
  it("refuses to execute tools when the budget is exhausted", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxTurns: 1,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_started")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "max_turns_exceeded",
      message: "The agent loop reached its maximum number of turns.",
      retryable: false,
    });
  });

  it("never calls the gateway more often than maxTurns", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [callEvent("call-2", "read_file"), { type: "completed" }],
      [callEvent("call-3", "read_file"), { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxTurns: 2,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)).toMatchObject({ code: "max_turns_exceeded" });
  });

  it("completes normally when the last turn has no tool call", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway, maxTurns: 1 });

    const events = await collect(loop.run(makeRequest()));

    expect(gateway.calls).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-6",
      turns: 1,
    });
  });
});

describe("task 6 runtime — tool result size limit", () => {
  it("treats an oversized tool result as a fixed tool failure", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("0123456789"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxToolResultBytes: 5,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: true,
    });
    expect(gateway.calls[1]?.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: "Tool execution failed.",
      isError: true,
    });
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    // Five CJK characters are fifteen UTF-8 bytes.
    const tools = recordingExecutor(() => resultFor("\u4f60\u597d\u4e16\u754c\u554a"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxToolResultBytes: 12,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: true,
    });
  });

  it("accepts a tool result exactly at the byte limit", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("abcde"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxToolResultBytes: 5,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: false,
    });
    expect(gateway.calls[1]?.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: "abcde",
    });
  });

  it("does not put tool result content into the completion event", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("TOP_SECRET_TOOL_OUTPUT"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));
    const completion = events.find((event) => event.type === "tool_execution_completed");

    expect(completion).toBeDefined();
    expect(JSON.stringify(completion)).not.toContain("TOP_SECRET_TOOL_OUTPUT");
  });
});

describe("task 6 runtime — incomplete model stream", () => {
  it("does not report success when the model stream never completed", async () => {
    const gateway = scriptedGateway([[{ type: "text_delta", text: "half" }]]);
    const loop = createAgentLoop({ gateway });

    const events: AgentLoopEvent[] = await collect(loop.run(makeRequest()));

    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("error");
  });
});

/* ------------------------------------------------------------------ *
 * Structural interfaces: the gateway and the executor are contracts, so a
 * class instance with a prototype method must be accepted exactly like a
 * plain object literal. The project's own gateways are all classes.
 * ------------------------------------------------------------------ */

class ClassGateway implements ModelGateway {
  readonly calls: ModelRequest[] = [];
  readonly #script: readonly (readonly ModelStreamEvent[])[];

  constructor(script: readonly (readonly ModelStreamEvent[])[]) {
    this.#script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const index = this.calls.length;
    this.calls.push(request);
    const events = this.#script[index];
    if (events === undefined) {
      throw new Error("the class gateway received an unexpected extra call");
    }
    for (const event of events) {
      yield event;
    }
  }
}

class ClassToolExecutor implements ToolExecutor {
  readonly requests: ToolExecutionRequest[] = [];

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    this.requests.push(request);
    return { content: `class-result:${request.name}` };
  }
}

describe("task 6 runtime — class instances and structural interfaces", () => {
  it("accepts a class based ModelGateway", () => {
    const gateway = new ClassGateway([]);

    expect(() => createAgentLoop({ gateway })).not.toThrow();
  });

  it("keeps the class gateway method on the prototype", () => {
    const gateway = new ClassGateway([]);

    expect(Object.hasOwn(gateway, "stream")).toBe(false);
    expect(typeof ClassGateway.prototype.stream).toBe("function");
  });

  it("runs a text turn through a class based gateway", async () => {
    const gateway = new ClassGateway([
      [{ type: "text_delta", text: "from-a-class" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(textOf(events)).toBe("from-a-class");
    expect(gateway.calls).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-6",
      turns: 1,
    });
  });

  it("accepts a ToolExecutor whose method lives on the prototype", () => {
    const gateway = new ClassGateway([]);
    const toolExecutor = new ClassToolExecutor();

    expect(Object.hasOwn(toolExecutor, "execute")).toBe(false);
    expect(typeof ClassToolExecutor.prototype.execute).toBe("function");
    expect(() => createAgentLoop({ gateway, toolExecutor })).not.toThrow();
  });

  it("runs a tool call through a class based executor", async () => {
    const gateway = new ClassGateway([
      [
        { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a" } },
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const toolExecutor = new ClassToolExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(toolExecutor.requests).toHaveLength(1);
    expect(toolExecutor.requests[0]?.id).toBe("call-1");
    expect(textOf(events)).toBe("done");
    expect(events.at(-1)).toMatchObject({ type: "loop_completed", turns: 2 });
  });

  it("appends the class executor result to the next request", async () => {
    const gateway = new ClassGateway([
      [{ type: "tool_call", id: "call-9", name: "read_file", input: {} }, { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const toolExecutor = new ClassToolExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor });

    await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls[1]?.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-9",
          content: "class-result:read_file",
        },
      ],
    });
  });

  it("accepts the project's own DeterministicFakeModelGateway class", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        { type: "text_delta", text: "class-from-the-project" },
        { type: "completed" },
      ],
    });
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(textOf(events)).toBe("class-from-the-project");
    expect(events.at(-1)).toMatchObject({ type: "loop_completed", turns: 1 });
  });

  it("accepts the project's own RoutedHttpModelGateway class offline", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream("routed-class"))),
    );
    const gateway = new RoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const loop = createAgentLoop({ gateway });

    const events = await collect(
      loop.run(makeRequest({ routeId: fixture.routeId, model: fixture.model })),
    );

    expect(textOf(events)).toBe("routed-class");
    expect(http.calls()).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "loop_completed", turns: 1 });
  });

  it("accepts the project's own ResilientRoutedHttpModelGateway class offline", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream("resilient-class"))),
    );
    const gateway = new ResilientRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      retryPolicy: { initialBackoffMs: 1, maxBackoffMs: 1 },
      wait: async () => undefined,
    });
    const loop = createAgentLoop({ gateway });

    const events = await collect(
      loop.run(makeRequest({ routeId: fixture.routeId, model: fixture.model })),
    );

    expect(textOf(events)).toBe("resilient-class");
    expect(http.calls()).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "loop_completed", turns: 1 });
  });

  it("still rejects null, arrays and primitives as the gateway", () => {
    for (const value of [null, undefined, [], "gateway", 7, true]) {
      expect(codeOf(() => createAgentLoop({ gateway: value } as never)), String(value)).toBe(
        "invalid_loop_options",
      );
    }
  });

  it("still rejects a gateway without a callable stream", () => {
    const cases = [
      {},
      { stream: 1 },
      { stream: "stream" },
      { stream: null },
      // A class instance without the method is just as invalid.
      new (class NotAGateway {})(),
    ];

    for (const value of cases) {
      expect(
        codeOf(() => createAgentLoop({ gateway: value } as never)),
        JSON.stringify(value),
      ).toBe("invalid_loop_options");
    }
  });

  it("still rejects a non object tool executor", () => {
    const gateway = new ClassGateway([]);

    for (const value of [null, [], "executor", 3, true]) {
      expect(
        codeOf(() => createAgentLoop({ gateway, toolExecutor: value } as never)),
        String(value),
      ).toBe("invalid_loop_options");
    }
  });

  it("still rejects a tool executor without a callable execute", () => {
    const gateway = new ClassGateway([]);
    const cases = [{}, { execute: 1 }, { execute: {} }, new (class NotAnExecutor {})()];

    for (const value of cases) {
      expect(
        codeOf(() => createAgentLoop({ gateway, toolExecutor: value } as never)),
        JSON.stringify(value),
      ).toBe("invalid_loop_options");
    }
  });
});
