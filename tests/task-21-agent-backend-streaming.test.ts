import { describe, expect, test } from "vitest";
import { mapAgentLoopEvents, createAgentBackendRunner } from "../packages/agent-backend/src/index.js";
import type { AgentLoopEvent } from "../packages/agent-runtime/src/index.js";
import {
  BACKEND_MODEL,
  BACKEND_ROUTE_ID,
  BACKEND_TURN_ID,
  completed,
  createCountingLoopEvents,
  loopCompleted,
  loopError,
  makeBackendRegistry,
  makeRunnerRequest,
  routeSelected,
  textDelta,
  toolCallEvent,
  toolExecutionCompleted,
  toolExecutionStarted,
  turnStarted,
  usageEvent,
} from "./helpers/agent-backend-fixtures.js";
import { anthropicSuccessResponse, createScriptedHttpClient } from "./helpers/http-fixtures.js";
import { anthropicToolUseStream, httpOk } from "./helpers/agent-backend-fixtures.js";

async function collect(
  events: AsyncIterable<AgentLoopEvent>,
): Promise<ReturnType<typeof mapAgentLoopEvents> extends AsyncIterable<infer T> ? T[] : never> {
  const out = [];
  for await (const event of mapAgentLoopEvents(events, BACKEND_TURN_ID)) {
    out.push(event);
  }
  return out;
}

describe("Task 21: AgentLoopEvent → AgentEvent mapping", () => {
  test("route_selected keeps routeId and model and rewrites requestId to the turnId", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield loopCompleted(1);
      })(),
    );
    expect(events).toEqual([
      { type: "route_selected", requestId: BACKEND_TURN_ID, routeId: BACKEND_ROUTE_ID, model: BACKEND_MODEL },
      { type: "completed", requestId: BACKEND_TURN_ID },
    ]);
  });

  test("text deltas stay incremental and in order", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield textDelta(0, "a");
        yield textDelta(0, "b");
        yield textDelta(0, "c");
        yield loopCompleted(1);
      })(),
    );
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => (event.type === "text_delta" ? event.text : "")),
    ).toEqual(["a", "b", "c"]);
  });

  test("tool_call and usage events map through", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield toolCallEvent(0, "call-1", "grep");
        yield usageEvent(0);
        yield completed(0);
        yield loopCompleted(1);
      })(),
    );
    expect(events).toEqual([
      { type: "route_selected", requestId: BACKEND_TURN_ID, routeId: BACKEND_ROUTE_ID, model: BACKEND_MODEL },
      { type: "tool_call", requestId: BACKEND_TURN_ID, id: "call-1", name: "grep", input: { path: "a.txt" } },
      { type: "usage", requestId: BACKEND_TURN_ID, inputTokens: 7, outputTokens: 5 },
      { type: "completed", requestId: BACKEND_TURN_ID },
    ]);
  });

  test("runtime turn_started and tool execution events never leak", async () => {
    const events = await collect(
      (async function* () {
        yield turnStarted(0);
        yield routeSelected(0);
        yield toolExecutionStarted(0, "call-1");
        yield toolExecutionCompleted(0, "call-1");
        yield loopCompleted(1);
      })(),
    );
    expect(events.map((event) => event.type)).toEqual(["route_selected", "completed"]);
  });

  test("a middle-turn completed is deferred, not forwarded early", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield textDelta(0, "thinking");
        yield completed(0);
        yield toolExecutionStarted(0, "call-1");
        yield toolExecutionCompleted(0, "call-1");
        yield turnStarted(1);
        yield routeSelected(1);
        yield textDelta(1, "final");
        yield completed(1);
        yield loopCompleted(2);
      })(),
    );
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "route_selected",
      "text_delta",
      "route_selected",
      "text_delta",
      "completed",
    ]);
    expect(events[events.length - 1]).toEqual({ type: "completed", requestId: BACKEND_TURN_ID });
  });

  test("exactly one completed is emitted even after several middle turns", async () => {
    const events = await collect(
      (async function* () {
        yield turnStarted(0);
        yield routeSelected(0);
        yield completed(0);
        yield toolExecutionStarted(0, "call-1");
        yield toolExecutionCompleted(0, "call-1");
        yield turnStarted(1);
        yield routeSelected(1);
        yield completed(1);
        yield toolExecutionStarted(1, "call-2");
        yield toolExecutionCompleted(1, "call-2");
        yield turnStarted(2);
        yield routeSelected(2);
        yield completed(2);
        yield loopCompleted(3);
      })(),
    );
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  test("an error suppresses the pending completed", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield textDelta(0, "partial");
        yield completed(0);
        yield loopError("gateway_error", "Model gateway request failed.");
      })(),
    );
    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
  });

  test("an aborted error code passes through as a structured safe error", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield loopError("aborted", "Turn aborted.");
      })(),
    );
    const last = events[events.length - 1];
    expect(last).toEqual({
      type: "error",
      requestId: BACKEND_TURN_ID,
      code: "aborted",
      message: "Turn aborted.",
      retryable: false,
    });
  });

  test("malformed upstream error fields are normalized to safe values", async () => {
    const events = await collect(
      (async function* () {
        yield {
          type: "error",
          requestId: BACKEND_TURN_ID,
          turnIndex: 0,
          code: "",
          message: "",
          retryable: true,
        } as unknown as AgentLoopEvent;
      })(),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.code).toBe("gateway_error");
      expect(typeof last.message).toBe("string");
      expect(last.message.length).toBeGreaterThan(0);
    }
  });

  test("exiting the mapped stream early releases the upstream iterator", async () => {
    const counting = createCountingLoopEvents([
      routeSelected(0),
      textDelta(0, "a"),
      textDelta(0, "b"),
      loopCompleted(1),
    ]);
    for await (const _event of mapAgentLoopEvents(counting.iterable, BACKEND_TURN_ID)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counting.returned()).toBe(1);
  });

  test("a loop that ends without loop_completed emits no completed", async () => {
    const events = await collect(
      (async function* () {
        yield routeSelected(0);
        yield completed(0);
      })(),
    );
    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
  });
});

describe("Task 21: end-to-end streaming through the resilient gateway", () => {
  test("a single text turn streams route, text, usage and exactly one completed", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([anthropicSuccessResponse("hello")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest())) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("route_selected");
    expect(types).toContain("text_delta");
    expect(types).toContain("usage");
    expect(types.filter((type) => type === "completed")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("completed");
    expect(http.calls()).toBe(1);
  });

  test("a tool turn produces tool_call then a second HTTP round and one final completed", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([
      httpOk(anthropicToolUseStream("call-1", "grep", '{"path":"a.txt"}')),
      anthropicSuccessResponse("done"),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      toolExecutor: {
        async execute() {
          return { content: "tool output" };
        },
      },
    });
    const events = [];
    for await (const event of await runner.run(
      makeRunnerRequest({
        tools: [{ name: "grep", description: "search", inputSchema: { type: "object" } }],
      }),
    )) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    expect(types).toContain("tool_call");
    expect(types.filter((type) => type === "completed")).toHaveLength(1);
    expect(types[types.length - 1]).toBe("completed");
    expect(http.calls()).toBe(2);
  });
});
