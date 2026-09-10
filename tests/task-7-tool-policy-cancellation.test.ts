import { describe, expect, it } from "vitest";
import {
  createAgentLoop,
  createGovernedToolExecutor,
  type AgentLoopEvent,
  type ToolApprovalDecision,
  type ToolApprovalHandler,
  type ToolExecutionResult,
  type ToolPolicy,
  type ToolPolicyDecision,
} from "../packages/agent-runtime/src/index.js";
import {
  abortedEvent,
  collect,
  deferred,
  errorEvents,
  hangingExecutor,
  makeRequest,
  recordingExecutor,
  resultFor,
  scriptedGateway,
  toolDefinition,
  until,
} from "./helpers/runtime-fixtures.js";

const READ = toolDefinition("read_file");

function callEvent(id: string) {
  return { type: "tool_call" as const, id, name: "read_file", input: { path: "a" } };
}

function toolGateway() {
  return scriptedGateway([
    [callEvent("call-1"), { type: "completed" }],
    [{ type: "text_delta", text: "second turn" }, { type: "completed" }],
  ]);
}

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

/** Runs a loop that performs one tool call, in the background. */
function startToolLoop(
  executor: Parameters<typeof createGovernedToolExecutor>[0]["executor"],
  options: Omit<Parameters<typeof createGovernedToolExecutor>[0], "executor">,
) {
  const gateway = toolGateway();
  const governed = createGovernedToolExecutor({ executor, ...options });
  const loop = createAgentLoop({ gateway, toolExecutor: governed });
  return { gateway, governed, loop };
}

/** Every event emitted after the single aborted error. */
function afterAbort(events: readonly AgentLoopEvent[]): AgentLoopEvent[] {
  const index = events.findIndex((event) => event.type === "error");
  return index < 0 ? [] : events.slice(index + 1);
}

describe("task 7 cancellation — pre-cancelled", () => {
  it("emits one aborted error without consulting policy, approval or executor", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    let policyCalls = 0;
    let approvalCalls = 0;
    const { loop } = startToolLoop(tools.executor, {
      policy: {
        decide: () => {
          policyCalls += 1;
          return "allow";
        },
      },
      approvalHandler: {
        requestApproval: () => {
          approvalCalls += 1;
          return "approved";
        },
      },
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    expect(events).toEqual([abortedEvent("req-6", 0)]);
    expect(policyCalls).toBe(0);
    expect(approvalCalls).toBe(0);
    expect(tools.requests).toHaveLength(0);
  });

  it("does not even call the gateway", async () => {
    const { gateway, loop } = startToolLoop(
      recordingExecutor(() => resultFor("never")).executor,
      { policy: { decide: () => "allow" } },
    );
    const controller = new AbortController();
    controller.abort();

    await collect(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    expect(gateway.calls).toHaveLength(0);
  });
});

describe("task 7 cancellation — while the policy is pending", () => {
  it("receives the abort signal and never runs the tool", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    let seen: AbortSignal | undefined;
    const gate = deferred<ToolPolicyDecision>();
    const policy: ToolPolicy = {
      decide: (_request, signal) => {
        seen = signal;
        return gate.promise;
      },
    };
    const { loop } = startToolLoop(tools.executor, { policy });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => seen !== undefined);
    expect(seen).toBe(controller.signal);

    controller.abort();
    await done;

    expect(tools.requests).toHaveLength(0);
    expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    // Turn 0 may already have completed its model stream; what matters is that
    // no completion is emitted after the abort.
    expect(afterAbort(events).filter((event) => event.type === "completed")).toHaveLength(0);
  });

  it("does not produce an unhandled rejection when the policy settles late", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tools = recordingExecutor(() => resultFor("never"));
      const gate = deferred<ToolPolicyDecision>();
      const { loop } = startToolLoop(tools.executor, {
        policy: { decide: () => gate.promise },
      });
      const controller = new AbortController();

      const { events, done } = drain(
        loop.run(makeRequest({ tools: [READ] }), controller.signal),
      );

      await until(() => events.some((event) => event.type === "tool_execution_started"));
      controller.abort();
      await done;
      expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);

      gate.reject(new Error("late policy failure"));
      await until(() => unhandled.length > 0, 40).catch(() => undefined);

      expect(unhandled).toEqual([]);
      expect(tools.requests).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("task 7 cancellation — while the approval is pending", () => {
  it("receives the abort signal and never runs the tool", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    let seen: AbortSignal | undefined;
    const gate = deferred<ToolApprovalDecision>();
    const approvalHandler: ToolApprovalHandler = {
      requestApproval: (_request, signal) => {
        seen = signal;
        return gate.promise;
      },
    };
    const { loop } = startToolLoop(tools.executor, {
      policy: { decide: () => "ask" },
      approvalHandler,
    });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => seen !== undefined);
    expect(seen).toBe(controller.signal);

    controller.abort();
    await done;

    expect(tools.requests).toHaveLength(0);
    expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
  });

  it("does not produce an unhandled rejection when the approval settles late", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tools = recordingExecutor(() => resultFor("never"));
      const gate = deferred<ToolApprovalDecision>();
      const { loop } = startToolLoop(tools.executor, {
        policy: { decide: () => "ask" },
        approvalHandler: { requestApproval: () => gate.promise },
      });
      const controller = new AbortController();

      const { events, done } = drain(
        loop.run(makeRequest({ tools: [READ] }), controller.signal),
      );

      await until(() =>
        events.some((event) => event.type === "tool_execution_started"),
      );
      controller.abort();
      await done;
      expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);

      gate.resolve("approved");
      await until(() => unhandled.length > 0, 40).catch(() => undefined);

      expect(unhandled).toEqual([]);
      expect(tools.requests).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not run the executor when the abort lands after approval", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    let release: ((value: ToolApprovalDecision) => void) | undefined;
    const approvalHandler: ToolApprovalHandler = {
      requestApproval: () =>
        new Promise<ToolApprovalDecision>((resolve) => {
          // Resolve exactly when the test asks for it, so the abort can land
          // between the approval and the executor call.
          release = resolve;
        }),
    };
    const { gateway, loop } = startToolLoop(tools.executor, {
      policy: { decide: () => "ask" },
      approvalHandler,
    });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => release !== undefined);
    controller.abort();
    await until(() => events.some((event) => event.type === "error"));
    release?.("approved");
    await done;

    expect(tools.requests).toHaveLength(0);
    expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("task 7 cancellation — while the executor is running", () => {
  it("forwards the abort signal to the underlying executor", async () => {
    const tools = hangingExecutor();
    const { loop } = startToolLoop(tools.executor, {
      policy: { decide: () => "allow" },
    });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => tools.calls.length === 1);
    expect(tools.signals[0]).toBe(controller.signal);

    controller.abort();
    await done;

    expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
  });

  it("ends even when the governed executor never settles", async () => {
    const tools = hangingExecutor();
    const { gateway, loop } = startToolLoop(tools.executor, {
      policy: { decide: () => "ask" },
      approvalHandler: { requestApproval: () => "approved" },
    });
    const controller = new AbortController();

    const { events, done } = drain(loop.run(makeRequest({ tools: [READ] }), controller.signal));

    await until(() => tools.calls.length === 1);
    controller.abort();
    await done;

    expect(afterAbort(events).filter((event) => event.type === "completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual(abortedEvent("req-6", 0));
    expect(gateway.calls).toHaveLength(1);
  });

  it("does not produce an unhandled rejection when the executor rejects late", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tools = hangingExecutor();
      const { loop } = startToolLoop(tools.executor, {
        policy: { decide: () => "allow" },
      });
      const controller = new AbortController();

      const { events, done } = drain(
        loop.run(makeRequest({ tools: [READ] }), controller.signal),
      );

      await until(() => tools.calls.length === 1);
      controller.abort();
      await done;
      expect(errorEvents(events)).toEqual([abortedEvent("req-6", 0)]);

      tools.rejectLate(new Error("late executor failure"));
      await until(() => unhandled.length > 0, 40).catch(() => undefined);

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("task 7 cancellation — concurrency", () => {
  it("keeps two governed loops independent", async () => {
    const first = hangingExecutor();
    const second = recordingExecutor(() => resultFor("second-body"));
    const firstController = new AbortController();
    const secondController = new AbortController();

    const firstLoop = createAgentLoop({
      gateway: toolGateway(),
      toolExecutor: createGovernedToolExecutor({
        executor: first.executor,
        policy: { decide: () => "allow" },
      }),
    });
    const secondLoop = createAgentLoop({
      gateway: toolGateway(),
      toolExecutor: createGovernedToolExecutor({
        executor: second.executor,
        policy: { decide: () => "allow" },
      }),
    });

    const firstRun = drain(
      firstLoop.run(makeRequest({ tools: [READ] }), firstController.signal),
    );
    const secondRun = drain(
      secondLoop.run(makeRequest({ tools: [READ] }), secondController.signal),
    );

    await until(() => first.calls.length === 1 && second.requests.length === 1);

    firstController.abort();
    await firstRun.done;

    expect(errorEvents(firstRun.events)).toEqual([abortedEvent("req-6", 0)]);
    expect(second.signals[0]).toBe(secondController.signal);

    // Cancelling the first loop did not disturb the second one.
    expect(secondController.signal.aborted).toBe(false);
    await secondRun.done;
    expect(secondRun.events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(secondRun.events.at(-1)).toMatchObject({ type: "loop_completed", turns: 2 });
  });

  it("evaluates the policy separately for each concurrent loop", async () => {
    const seen: string[] = [];
    const policy: ToolPolicy = {
      decide: (request) => {
        seen.push(request.id);
        return "allow";
      },
    };
    const first = createAgentLoop({
      gateway: toolGateway(),
      toolExecutor: createGovernedToolExecutor({
        executor: recordingExecutor(() => resultFor("a")).executor,
        policy,
      }),
    });
    const second = createAgentLoop({
      gateway: toolGateway(),
      toolExecutor: createGovernedToolExecutor({
        executor: recordingExecutor(() => resultFor("b")).executor,
        policy,
      }),
    });

    await Promise.all([
      collect(first.run(makeRequest({ tools: [READ] }))),
      collect(second.run(makeRequest({ tools: [READ] }))),
    ]);

    expect(seen).toEqual(["call-1", "call-1"]);
  });
});

const _typeCheck: ToolExecutionResult = resultFor("x");
void _typeCheck;
