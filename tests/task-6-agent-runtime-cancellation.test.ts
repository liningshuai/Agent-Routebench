import { describe, expect, it } from "vitest";
import { createAgentLoop } from "../packages/agent-runtime/src/index.js";
import type {
  AgentLoopEvent,
  ModelGateway,
  ModelStreamEvent,
  ToolExecutionResult,
} from "../packages/agent-runtime/src/index.js";
import {
  abortedEvent,
  collect,
  deferred,
  errorEvents,
  gatedGateway,
  hangingExecutor,
  makeRequest,
  recordingExecutor,
  resultFor,
  scriptedGateway,
  textOf,
  tick,
  toolDefinition,
  until,
} from "./helpers/runtime-fixtures.js";

const READ = toolDefinition("read_file");
const PROBE = "TASK6_SYNTHETIC_PROBE_VALUE";

function callEvent(id: string, name: string, input: unknown = { path: "a.txt" }) {
  return { type: "tool_call" as const, id, name, input: input as never };
}

/** Drives an iterator in the background, collecting every event. */
function drain(iterable: AsyncIterable<AgentLoopEvent>): {
  readonly events: AgentLoopEvent[];
  readonly done: Promise<void>;
} {
  const events: AgentLoopEvent[] = [];
  const done = (async () => {
    for await (const event of iterable) {
      events.push(event);
    }
  })();
  return { events, done };
}

describe("task 6 cancellation — pre-cancelled", () => {
  it("emits exactly one aborted error and never touches the gateway", async () => {
    const gateway = scriptedGateway([
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("never"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    expect(gateway.calls).toHaveLength(0);
    expect(tools.requests).toHaveLength(0);
    expect(events).toEqual([abortedEvent("req-6", 0)]);
  });

  it("starts no turn and emits no completed or loop_completed", async () => {
    const gateway = scriptedGateway([]);
    const loop = createAgentLoop({ gateway });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(loop.run(makeRequest(), controller.signal));

    expect(events.filter((event) => event.type === "turn_started")).toHaveLength(0);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
  });
});

describe("task 6 cancellation — during the model stream", () => {
  it("stops at the first abort and emits only one aborted error", async () => {
    const gate = deferred<readonly ModelStreamEvent[]>();
    const gateway: ModelGateway = {
      stream(): AsyncIterable<ModelStreamEvent> {
        return (async function* paused(): AsyncIterable<ModelStreamEvent> {
          yield { type: "text_delta", text: "first" };
          const rest = await gate.promise;
          for (const event of rest) {
            yield event;
          }
        })();
      },
    };
    const loop = createAgentLoop({ gateway });
    const controller = new AbortController();
    const iterator = loop.run(makeRequest(), controller.signal)[Symbol.asyncIterator]();

    const events: AgentLoopEvent[] = [];
    for (let index = 0; index < 3; index += 1) {
      const step = await iterator.next();
      if (step.done !== true) {
        events.push(step.value);
      }
    }
    expect(textOf(events)).toBe("first");

    controller.abort();
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) {
        break;
      }
      events.push(step.value);
    }

    expect(events.filter((event) => event.type === "error")).toEqual([
      abortedEvent("req-6", 0),
    ]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(textOf(events)).toBe("first");

    gate.resolve([]);
    await tick();
  });

  it("ends promptly even when the upstream never resolves the next event", async () => {
    let nextCalls = 0;
    const gateway: ModelGateway = {
      stream(): AsyncIterable<ModelStreamEvent> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
            return {
              next(): Promise<IteratorResult<ModelStreamEvent>> {
                nextCalls += 1;
                return new Promise<IteratorResult<ModelStreamEvent>>(() => undefined);
              },
              return(): Promise<IteratorResult<ModelStreamEvent>> {
                return new Promise<IteratorResult<ModelStreamEvent>>(() => undefined);
              },
            };
          },
        };
      },
    };
    const loop = createAgentLoop({ gateway });
    const controller = new AbortController();
    const iterator = loop.run(makeRequest(), controller.signal)[Symbol.asyncIterator]();

    const events: AgentLoopEvent[] = [];
    const drainAll = (async () => {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) {
          return;
        }
        events.push(step.value);
      }
    })();

    await until(() => nextCalls === 1);
    controller.abort();
    await drainAll;

    expect(events.at(-1)).toEqual(abortedEvent("req-6", 0));
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
  });

  it("does not start a second turn after an abort", async () => {
    const gateway = gatedGateway();
    const tools = hangingExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await gateway.waitForPending();
    gateway.release([callEvent("call-1", "read_file"), { type: "completed" }]);
    await until(() => tools.calls.length === 1);

    controller.abort();
    await done;

    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual(abortedEvent("req-6", 0));
  });
});

describe("task 6 cancellation — during tool execution", () => {
  it("forwards the abort signal to the tool executor", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
    ]);
    const tools = hangingExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => tools.calls.length === 1);
    expect(tools.signals[0]).toBe(controller.signal);

    // The turn's own `completed` event was already emitted before the abort;
    // what matters is that nothing but the single aborted error follows it.
    const beforeAbort = events.length;
    controller.abort();
    await done;

    expect(events.slice(beforeAbort)).toEqual([abortedEvent("req-6", 0)]);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool_execution_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual(abortedEvent("req-6", 0));
  });

  it("ends the loop even when the tool executor never settles", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const tools = hangingExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => tools.calls.length === 1);
    controller.abort();
    await done;

    expect(events.at(-1)).toEqual(abortedEvent("req-6", 0));
    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_completed")).toHaveLength(0);
  });

  it("never starts the next model request after an abort during a tool run", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const tools = hangingExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();

    const { done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));
    await until(() => tools.calls.length === 1);
    controller.abort();
    await done;

    expect(gateway.calls).toHaveLength(1);
  });

  it("does not leak a late tool result into the event stream", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
    ]);
    const tools = hangingExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));
    await until(() => tools.calls.length === 1);
    controller.abort();
    await done;

    tools.resolveLate(resultFor(PROBE));
    await tick();
    await tick();

    expect(JSON.stringify(events)).not.toContain(PROBE);
    expect(events.filter((event) => event.type === "tool_execution_completed")).toHaveLength(0);
  });

  it("produces no unhandled rejection when the tool resolves after the abort", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const gateway = scriptedGateway([
        [callEvent("call-1", "read_file"), { type: "completed" }],
      ]);
      const tools = hangingExecutor();
      const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
      const controller = new AbortController();

      const { done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));
      await until(() => tools.calls.length === 1);
      controller.abort();
      await done;

      tools.resolveLate(resultFor("late value"));
      await tick();
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("produces no unhandled rejection when the tool rejects after the abort", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const gateway = scriptedGateway([
        [callEvent("call-1", "read_file"), { type: "completed" }],
      ]);
      const tools = hangingExecutor();
      const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
      const controller = new AbortController();

      const { done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));
      await until(() => tools.calls.length === 1);
      controller.abort();
      await done;

      tools.rejectLate(new Error(`${PROBE} late tool failure`));
      await tick();
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still emits exactly one aborted error when the executor settles on abort", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const gate = deferred<ToolExecutionResult>();
    const tools = recordingExecutor(() => gate.promise);
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));
    await until(() => tools.requests.length === 1);

    controller.abort();
    // The tool settles only after the abort, like a slow but cooperative tool:
    // the late result must not produce a second error or a completed event.
    gate.resolve(resultFor("partial"));
    await done;

    expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);
    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_completed")).toHaveLength(0);
  });
});

describe("task 6 cancellation — concurrency isolation", () => {
  it("runs two loops at the same time without sharing state", async () => {
    const first = gatedGateway();
    const second = gatedGateway();
    const toolsA = recordingExecutor(() => resultFor("A"));
    const toolsB = recordingExecutor(() => resultFor("B"));

    const loopA = createAgentLoop({ gateway: first, toolExecutor: toolsA.executor });
    const loopB = createAgentLoop({ gateway: second, toolExecutor: toolsB.executor });

    const runA = drain(loopA.run(makeRequest({ requestId: "req-a", routeId: "route-a", tools: [READ] })));
    const runB = drain(loopB.run(makeRequest({ requestId: "req-b", routeId: "route-b", tools: [READ] })));

    // Both model requests are in flight simultaneously.
    await first.waitForPending();
    await second.waitForPending();

    first.release([callEvent("shared-id", "read_file", { who: "A" }), { type: "completed" }]);
    second.release([callEvent("shared-id", "read_file", { who: "B" }), { type: "completed" }]);

    await until(() => toolsA.requests.length === 1 && toolsB.requests.length === 1);

    // Both loops have now started their second model request.
    await first.waitForPending();
    await second.waitForPending();
    first.release([{ type: "text_delta", text: "done-A" }, { type: "completed" }]);
    second.release([{ type: "text_delta", text: "done-B" }, { type: "completed" }]);

    await Promise.all([runA.done, runB.done]);

    expect(textOf(runA.events)).toBe("done-A");
    expect(textOf(runB.events)).toBe("done-B");
    expect(runA.events.every((event) => event.requestId === "req-a")).toBe(true);
    expect(runB.events.every((event) => event.requestId === "req-b")).toBe(true);
    expect(
      runA.events.filter((event) => event.type === "route_selected").map((event) => event.routeId),
    ).toEqual(["route-a", "route-a"]);
    expect(
      runB.events.filter((event) => event.type === "route_selected").map((event) => event.routeId),
    ).toEqual(["route-b", "route-b"]);
    expect(toolsA.requests.map((request) => request.input)).toEqual([{ who: "A" }]);
    expect(toolsB.requests.map((request) => request.input)).toEqual([{ who: "B" }]);
    expect(runA.events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-a",
      turns: 2,
    });
    expect(runB.events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-b",
      turns: 2,
    });
  });

  it("counts turns per loop rather than globally", async () => {
    const first = gatedGateway();
    const second = gatedGateway();
    const loopA = createAgentLoop({ gateway: first });
    const loopB = createAgentLoop({ gateway: second });

    const runA = drain(loopA.run(makeRequest({ requestId: "req-a" })));
    const runB = drain(loopB.run(makeRequest({ requestId: "req-b" })));

    await first.waitForPending();
    await second.waitForPending();
    first.release([{ type: "text_delta", text: "a" }, { type: "completed" }]);
    second.release([{ type: "text_delta", text: "b" }, { type: "completed" }]);
    await Promise.all([runA.done, runB.done]);

    expect(
      runA.events.filter((event) => event.type === "turn_started").map((event) => event.turnIndex),
    ).toEqual([0]);
    expect(
      runB.events.filter((event) => event.type === "turn_started").map((event) => event.turnIndex),
    ).toEqual([0]);
  });

  it("aborting one loop leaves the other loop running", async () => {
    const first = gatedGateway();
    const second = scriptedGateway([
      [{ type: "text_delta", text: "b" }, { type: "completed" }],
    ]);
    const loopA = createAgentLoop({ gateway: first });
    const loopB = createAgentLoop({ gateway: second });
    const controller = new AbortController();

    const runA = drain(loopA.run(makeRequest({ requestId: "req-a" }), controller.signal));
    const runB = drain(loopB.run(makeRequest({ requestId: "req-b" })));

    await first.waitForPending();
    controller.abort();
    await runA.done;
    await runB.done;

    expect(runA.events.at(-1)).toEqual(abortedEvent("req-a", 0));
    expect(textOf(runB.events)).toBe("b");
    expect(runB.events.at(-1)).toEqual({
      type: "loop_completed",
      requestId: "req-b",
      turns: 1,
    });
  });
});
