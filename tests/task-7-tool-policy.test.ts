import { describe, expect, it } from "vitest";
import {
  TOOL_APPROVAL_DENIED_CONTENT,
  TOOL_APPROVAL_FAILED_CONTENT,
  TOOL_APPROVAL_UNAVAILABLE_CONTENT,
  TOOL_FAILURE_CONTENT,
  TOOL_POLICY_DENIED_CONTENT,
  TOOL_POLICY_ERROR_CODES,
  TOOL_POLICY_FAILED_CONTENT,
  ToolPolicyError,
  createAgentLoop,
  createGovernedToolExecutor,
  type ToolApprovalDecision,
  type ToolApprovalHandler,
  type ToolApprovalRequest,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutor,
  type ToolPolicy,
  type ToolPolicyDecision,
} from "../packages/agent-runtime/src/index.js";
import {
  collect,
  makeRequest,
  recordingExecutor,
  resultFor,
  scriptedGateway,
  textOf,
  toolDefinition,
  until,
} from "./helpers/runtime-fixtures.js";

const READ = toolDefinition("read_file");

const REQUEST: ToolExecutionRequest = {
  id: "call-1",
  name: "read_file",
  input: { path: "a.txt" },
};

function governedRequest(id: string): ToolExecutionRequest {
  return { id, name: "read_file", input: { path: `${id}.txt` } };
}

/** A policy whose next decision is scripted; invalid values are intentional. */
class ScriptedPolicy implements ToolPolicy {
  readonly requests: ToolExecutionRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #decisions: unknown[];

  constructor(decisions: readonly unknown[]) {
    this.#decisions = [...decisions];
  }

  decide(
    request: ToolExecutionRequest,
    signal?: AbortSignal,
  ): ToolPolicyDecision {
    this.requests.push(request);
    this.signals.push(signal);
    const next =
      this.#decisions.length > 1 ? this.#decisions.shift() : this.#decisions[0];
    return next as ToolPolicyDecision;
  }
}

class ScriptedApprovalHandler implements ToolApprovalHandler {
  readonly requests: ToolApprovalRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #decision: unknown;

  constructor(decision: unknown) {
    this.#decision = decision;
  }

  requestApproval(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): ToolApprovalDecision {
    this.requests.push(request);
    this.signals.push(signal);
    return this.#decision as ToolApprovalDecision;
  }
}

class ClassToolExecutor implements ToolExecutor {
  readonly requests: ToolExecutionRequest[] = [];

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    this.requests.push(request);
    return { content: `class-result:${request.name}` };
  }
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return "<no throw>";
  } catch (error) {
    return (error as { code?: string }).code ?? "<no code>";
  }
}

describe("task 7 tool policy — public surface", () => {
  it("exposes the factory and the fixed result constants", () => {
    expect(typeof createGovernedToolExecutor).toBe("function");
    expect(TOOL_POLICY_DENIED_CONTENT).toBe("Tool execution was denied.");
    expect(TOOL_APPROVAL_UNAVAILABLE_CONTENT).toBe("Tool approval is unavailable.");
    expect(TOOL_APPROVAL_DENIED_CONTENT).toBe("Tool execution was denied.");
    expect(TOOL_APPROVAL_FAILED_CONTENT).toBe("Tool approval failed.");
    expect(TOOL_POLICY_FAILED_CONTENT).toBe("Tool policy evaluation failed.");
  });

  it("returns a ToolExecutor that the agent loop accepts", () => {
    const governed = createGovernedToolExecutor({
      executor: recordingExecutor(() => resultFor("ok")).executor,
    });

    expect(typeof governed.execute).toBe("function");
    expect(() =>
      createAgentLoop({ gateway: scriptedGateway([]), toolExecutor: governed }),
    ).not.toThrow();
  });
});

describe("task 7 tool policy — decisions and execution", () => {
  it("denies by default when no policy is injected", async () => {
    const tools = recordingExecutor(() => resultFor("ok"));
    const governed = createGovernedToolExecutor({ executor: tools.executor });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_POLICY_DENIED_CONTENT,
      isError: true,
    });
    expect(tools.requests).toHaveLength(0);
  });

  it("does not fall back to allowing when the policy is missing", async () => {
    const tools = recordingExecutor(() => resultFor("ok"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: undefined,
    });

    const result = await governed.execute(REQUEST);

    expect(result.isError).toBe(true);
    expect(tools.requests).toHaveLength(0);
  });

  it("runs the executor once when the policy allows", async () => {
    const tools = recordingExecutor(() => resultFor("payload"));
    const policy = new ScriptedPolicy(["allow"]);
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy,
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({ content: "payload" });
    expect(tools.requests).toHaveLength(1);
    expect(tools.requests[0]).toEqual(REQUEST);
    expect(policy.requests).toHaveLength(1);
  });

  it("never runs the executor when the policy denies", async () => {
    const tools = recordingExecutor(() => resultFor("payload"));
    const handler = new ScriptedApprovalHandler("approved");
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["deny"]),
      approvalHandler: handler,
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_POLICY_DENIED_CONTENT,
      isError: true,
    });
    expect(tools.requests).toHaveLength(0);
    expect(handler.requests).toHaveLength(0);
  });

  it("passes the abort signal to the policy and to the executor", async () => {
    const tools = recordingExecutor(() => resultFor("ok"));
    const policy = new ScriptedPolicy(["allow"]);
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy,
    });
    const controller = new AbortController();

    await governed.execute(REQUEST, controller.signal);

    expect(policy.signals[0]).toBe(controller.signal);
    expect(tools.signals[0]).toBe(controller.signal);
  });

  it("re-evaluates the policy on every call instead of caching it", async () => {
    const tools = recordingExecutor(() => resultFor("second"));
    let calls = 0;
    const policy: ToolPolicy = {
      decide: () => {
        calls += 1;
        return calls === 1 ? "deny" : "allow";
      },
    };
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy,
    });

    const first = await governed.execute(REQUEST);
    const second = await governed.execute(REQUEST);

    expect(first).toEqual({
      content: TOOL_POLICY_DENIED_CONTENT,
      isError: true,
    });
    expect(second).toEqual({ content: "second" });
    expect(tools.requests).toHaveLength(1);
  });

  it("keeps concurrent executions independent", async () => {
    const tools = recordingExecutor(() => resultFor("done"));
    const policy: ToolPolicy = {
      decide: (request) => (request.id === "call-a" ? "allow" : "deny"),
    };
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy,
    });

    const [first, second] = await Promise.all([
      governed.execute(governedRequest("call-a")),
      governed.execute(governedRequest("call-b")),
    ]);

    expect(first).toEqual({ content: "done" });
    expect(second.isError).toBe(true);
    expect(tools.requests).toHaveLength(1);
    expect(tools.requests[0]?.id).toBe("call-a");
  });
});

describe("task 7 tool policy — approval gate", () => {
  it("asks the handler when the policy says ask", async () => {
    const tools = recordingExecutor(() => resultFor("approved-run"));
    const handler = new ScriptedApprovalHandler("approved");
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["ask"]),
      approvalHandler: handler,
    });
    const controller = new AbortController();

    const result = await governed.execute(REQUEST, controller.signal);

    expect(result).toEqual({ content: "approved-run" });
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toEqual(REQUEST);
    expect(handler.signals[0]).toBe(controller.signal);
    expect(tools.requests).toHaveLength(1);
  });

  it("never runs the executor when the approval is denied", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["ask"]),
      approvalHandler: new ScriptedApprovalHandler("denied"),
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_APPROVAL_DENIED_CONTENT,
      isError: true,
    });
    expect(tools.requests).toHaveLength(0);
  });

  it("reports an unavailable approval when there is no handler", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["ask"]),
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_APPROVAL_UNAVAILABLE_CONTENT,
      isError: true,
    });
    expect(tools.requests).toHaveLength(0);
  });

  it("treats every value other than the exact string as a failure", async () => {
    for (const value of [
      true,
      1,
      "yes",
      "allow",
      "APPROVED",
      "approved ",
      null,
      undefined,
      "denied",
    ]) {
      const tools = recordingExecutor(() => resultFor("never"));
      const governed = createGovernedToolExecutor({
        executor: tools.executor,
        policy: new ScriptedPolicy(["ask"]),
        approvalHandler: new ScriptedApprovalHandler(value),
      });

      const result = await governed.execute(REQUEST);
      const expected =
        value === "denied"
          ? TOOL_APPROVAL_DENIED_CONTENT
          : TOOL_APPROVAL_FAILED_CONTENT;

      expect(result, `approval ${String(value)}`).toEqual({
        content: expected,
        isError: true,
      });
      expect(tools.requests, `approval ${String(value)}`).toHaveLength(0);
    }
  });

  it("does not consult the approval handler when the policy already decided", async () => {
    for (const decision of ["allow", "deny"]) {
      const tools = recordingExecutor(() => resultFor("ok"));
      const handler = new ScriptedApprovalHandler("approved");
      const governed = createGovernedToolExecutor({
        executor: tools.executor,
        policy: new ScriptedPolicy([decision]),
        approvalHandler: handler,
      });

      await governed.execute(REQUEST);

      expect(handler.requests, decision).toHaveLength(0);
    }
  });
});

describe("task 7 tool policy — failure handling", () => {
  it("fails closed on an unknown policy decision", async () => {
    for (const decision of ["maybe", "ALLOW", 1, true, null, undefined, {}]) {
      const tools = recordingExecutor(() => resultFor("never"));
      const handler = new ScriptedApprovalHandler("approved");
      const governed = createGovernedToolExecutor({
        executor: tools.executor,
        policy: new ScriptedPolicy([decision]),
        approvalHandler: handler,
      });

      const result = await governed.execute(REQUEST);

      expect(result, `decision ${String(decision)}`).toEqual({
        content: TOOL_POLICY_FAILED_CONTENT,
        isError: true,
      });
      expect(tools.requests, `decision ${String(decision)}`).toHaveLength(0);
      expect(handler.requests, `decision ${String(decision)}`).toHaveLength(0);
    }
  });

  it("fails closed when the policy throws", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: {
        decide: () => {
          throw new Error("policy exploded");
        },
      },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_POLICY_FAILED_CONTENT,
      isError: true,
    });
    expect(tools.requests).toHaveLength(0);
  });

  it("fails closed when the policy rejects", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: { decide: () => Promise.reject(new Error("policy rejected")) },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_POLICY_FAILED_CONTENT,
      isError: true,
    });
    expect(tools.requests).toHaveLength(0);
  });

  it("fails closed when the approval handler throws or rejects", async () => {
    for (const handler of [
      {
        requestApproval: () => {
          throw new Error("approval exploded");
        },
      },
      { requestApproval: () => Promise.reject(new Error("approval rejected")) },
    ] as ToolApprovalHandler[]) {
      const tools = recordingExecutor(() => resultFor("never"));
      const governed = createGovernedToolExecutor({
        executor: tools.executor,
        policy: new ScriptedPolicy(["ask"]),
        approvalHandler: handler,
      });

      const result = await governed.execute(REQUEST);

      expect(result).toEqual({
        content: TOOL_APPROVAL_FAILED_CONTENT,
        isError: true,
      });
      expect(tools.requests).toHaveLength(0);
    }
  });

  it("fails safely when the executor throws or rejects", async () => {
    for (const executor of [
      {
        execute: () => {
          throw new Error("executor exploded");
        },
      },
      { execute: () => Promise.reject(new Error("executor rejected")) },
    ] as ToolExecutor[]) {
      const governed = createGovernedToolExecutor({
        executor,
        policy: new ScriptedPolicy(["allow"]),
      });

      const result = await governed.execute(REQUEST);

      expect(result).toEqual({
        content: TOOL_FAILURE_CONTENT,
        isError: true,
      });
    }
  });

  it("passes a malformed executor result through for Task 6 to classify", async () => {
    const malformed = { content: 42 } as unknown as ToolExecutionResult;
    const governed = createGovernedToolExecutor({
      executor: { execute: () => Promise.resolve(malformed) },
      policy: new ScriptedPolicy(["allow"]),
    });

    const result = await governed.execute(REQUEST);

    expect(result).toBe(malformed);
  });
});

describe("task 7 tool policy — structural options", () => {
  it("accepts class instances for policy, approval handler and executor", async () => {
    const tools = new ClassToolExecutor();
    const governed = createGovernedToolExecutor({
      executor: tools,
      policy: new ScriptedPolicy(["allow"]),
    });

    expect(Object.hasOwn(tools, "execute")).toBe(false);
    expect(Object.hasOwn(ScriptedPolicy.prototype, "decide")).toBe(true);

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({ content: "class-result:read_file" });
    expect(tools.requests).toHaveLength(1);
  });

  it("accepts an approval handler whose method lives on the prototype", async () => {
    const tools = new ClassToolExecutor();
    const handler = new ScriptedApprovalHandler("approved");
    const governed = createGovernedToolExecutor({
      executor: tools,
      policy: new ScriptedPolicy(["ask"]),
      approvalHandler: handler,
    });

    expect(Object.hasOwn(handler, "requestApproval")).toBe(false);

    await governed.execute(REQUEST);

    expect(tools.requests).toHaveLength(1);
  });

  it("accepts plain objects and null prototype objects", async () => {
    const decisions: ToolPolicy[] = [
      { decide: () => "allow" },
      Object.assign(Object.create(null) as object, {
        decide: () => "allow",
      }) as ToolPolicy,
    ];

    for (const policy of decisions) {
      const tools = recordingExecutor(() => resultFor("ok"));
      const governed = createGovernedToolExecutor({
        executor: tools.executor,
        policy,
      });

      await governed.execute(REQUEST);

      expect(tools.requests).toHaveLength(1);
    }
  });

  it("rejects an invalid executor", () => {
    for (const value of [null, undefined, [], "executor", 1, true, {}, { execute: 1 }]) {
      expect(
        codeOf(() =>
          createGovernedToolExecutor({ executor: value } as never),
        ),
        `executor ${String(value)}`,
      ).toBe(TOOL_POLICY_ERROR_CODES.invalidToolPolicyOptions);
    }
  });

  it("rejects an invalid policy", () => {
    const executor = recordingExecutor(() => resultFor("ok")).executor;

    for (const value of [null, [], "allow", 1, true, {}, { decide: 1 }]) {
      expect(
        codeOf(() => createGovernedToolExecutor({ executor, policy: value } as never)),
        `policy ${String(value)}`,
      ).toBe(TOOL_POLICY_ERROR_CODES.invalidToolPolicyOptions);
    }
  });

  it("rejects an invalid approval handler", () => {
    const executor = recordingExecutor(() => resultFor("ok")).executor;

    for (const value of [null, [], "approved", 1, true, {}, { requestApproval: 1 }]) {
      expect(
        codeOf(() =>
          createGovernedToolExecutor({
            executor,
            approvalHandler: value,
          } as never),
        ),
        `handler ${String(value)}`,
      ).toBe(TOOL_POLICY_ERROR_CODES.invalidToolPolicyOptions);
    }
  });

  it("does not echo a rejected configuration value", () => {
    try {
      createGovernedToolExecutor({ executor: "TOP_SECRET_CONFIG_VALUE" } as never);
      throw new Error("expected a synchronous throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolPolicyError);
      const message = (error as Error).message;
      expect(message).not.toContain("TOP_SECRET_CONFIG_VALUE");
      expect(message).not.toContain("executor");
    }
  });

  it("accepts an options bag without the optional members", async () => {
    const governed = createGovernedToolExecutor({
      executor: recordingExecutor(() => resultFor("ok")).executor,
    });

    const result = await governed.execute(REQUEST);

    expect(result.isError).toBe(true);
  });
});

describe("task 7 tool policy — agent loop integration", () => {
  function scriptedToolLoop(toolExecutor: ToolExecutor) {
    const gateway = scriptedGateway([
      [
        { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a" } },
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway, toolExecutor });
    return { gateway, loop };
  }

  it("runs the tool through the loop when the policy allows", async () => {
    const tools = recordingExecutor(() => resultFor("file body"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["allow"]),
    });
    const { gateway, loop } = scriptedToolLoop(governed);

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(1);
    expect(textOf(events)).toBe("done");
    expect(gateway.calls[1]?.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: "file body",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_completed", turns: 2 });
  });

  it("feeds the denial back to the model without running the tool", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["deny"]),
    });
    const { gateway, loop } = scriptedToolLoop(governed);

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(gateway.calls[1]?.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: TOOL_POLICY_DENIED_CONTENT,
      isError: true,
    });
    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: true,
    });
    expect(events.at(-1)?.type).toBe("loop_completed");
  });

  it("runs the tool through the loop once the approval is granted", async () => {
    const tools = recordingExecutor(() => resultFor("approved body"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["ask"]),
      approvalHandler: new ScriptedApprovalHandler("approved"),
    });
    const { gateway, loop } = scriptedToolLoop(governed);

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(1);
    expect(gateway.calls[1]?.messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      content: "approved body",
    });
    expect(events.at(-1)?.type).toBe("loop_completed");
  });

  it("keeps a malformed executor result out of the model context", async () => {
    const governed = createGovernedToolExecutor({
      executor: { execute: () => ({ content: 42 }) as never },
      policy: new ScriptedPolicy(["allow"]),
    });
    const { gateway, loop } = scriptedToolLoop(governed);

    await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls[1]?.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      content: TOOL_FAILURE_CONTENT,
      isError: true,
    });
  });

  it("does not put the tool result into any event", async () => {
    const governed = createGovernedToolExecutor({
      executor: { async execute() { return { content: "TASK7_TOOL_PAYLOAD" }; } },
      policy: new ScriptedPolicy(["allow"]),
    });
    const { loop } = scriptedToolLoop(governed);

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(JSON.stringify(events)).not.toContain("TASK7_TOOL_PAYLOAD");
  });

  it("keeps calling the policy for every tool call of a loop", async () => {
    const tools = recordingExecutor(() => resultFor("ok"));
    const policy = new ScriptedPolicy(["allow"]);
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy,
    });
    const gateway = scriptedGateway([
      [
        { type: "tool_call", id: "call-1", name: "read_file", input: {} },
        { type: "tool_call", id: "call-2", name: "read_file", input: {} },
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway, toolExecutor: governed });

    await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(policy.requests.map((request) => request.id)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(tools.requests).toHaveLength(2);
  });

  it("reports the governed executor as available to the loop", async () => {
    const tools = recordingExecutor(() => resultFor("ok"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: new ScriptedPolicy(["allow"]),
    });
    const gateway = scriptedGateway([
      [{ type: "tool_call", id: "call-1", name: "read_file", input: {} }, { type: "completed" }],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway, toolExecutor: governed });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  });
});
