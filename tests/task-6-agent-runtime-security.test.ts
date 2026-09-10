import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAgentLoop } from "../packages/agent-runtime/src/index.js";
import {
  collect,
  errorEvents,
  hangingExecutor,
  makeRequest,
  recordingExecutor,
  resultFor,
  scriptedGateway,
  textOf,
  toolDefinition,
  until,
} from "./helpers/runtime-fixtures.js";

const READ = toolDefinition("read_file");
const PROBE = "TASK6_SYNTHETIC_PROBE_VALUE";

const PACKAGE_ROOT = fileURLToPath(new URL("../packages/agent-runtime", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function runtimeSourceFiles(): string[] {
  return listFiles(PACKAGE_ROOT).filter((file) => file.endsWith(".ts"));
}

function callEvent(id: string, name: string, input: unknown = { path: "a.txt" }) {
  return { type: "tool_call" as const, id, name, input: input as never };
}

describe("task 6 runtime security — tool availability", () => {
  it("refuses to run a tool when no executor was injected", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_execution_started")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "tool_execution_unavailable",
      message: "Tool execution is unavailable.",
      retryable: false,
    });
  });

  it("refuses a tool that the request never declared", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "shell_exec"), { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("should never run"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "unknown_tool",
      message: "The requested tool is not available.",
      retryable: false,
    });
  });

  it("does not leak the unknown tool name into the error message", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "exfiltrate_secrets"), { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("nope"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));
    const error = errorEvents(events)[0];

    expect(error).toBeDefined();
    expect(JSON.stringify(error)).not.toContain("exfiltrate_secrets");
  });

  it("declares every tool of the request as available", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "other_tool"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("ok"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(
      loop.run(makeRequest({ tools: [READ, toolDefinition("other_tool")] })),
    );

    expect(tools.requests).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("loop_completed");
  });
});

describe("task 6 runtime security — invalid tool calls", () => {
  it("rejects an empty tool call id", async () => {
    const gateway = scriptedGateway([[callEvent("", "read_file"), { type: "completed" }]]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "invalid_tool_call",
      message: "The model returned an invalid tool call.",
      retryable: false,
    });
  });

  it("rejects an empty tool name", async () => {
    const gateway = scriptedGateway([[callEvent("call-1", ""), { type: "completed" }]]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ code: "invalid_tool_call" });
  });

  it("rejects a non JSON tool input instead of replacing it", async () => {
    for (const input of [
      () => undefined,
      { nested: undefined },
      [Number.NaN],
      { value: Number.POSITIVE_INFINITY },
      new Date(),
    ]) {
      const gateway = scriptedGateway([
        [callEvent("call-1", "read_file", input), { type: "completed" }],
      ]);
      const tools = recordingExecutor(() => resultFor("body"));
      const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

      const events = await collect(loop.run(makeRequest({ tools: [READ] })));

      expect(tools.requests, `input ${String(input)} was accepted`).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ code: "invalid_tool_call" });
      expect(events.at(-1)?.type).toBe("error");
    }
  });

  it("rejects a non finite number inside the tool input", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file", { limit: Number.NaN }), { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ code: "invalid_tool_call" });
  });

  it("rejects a duplicated tool call id inside one turn", async () => {
    const gateway = scriptedGateway([
      [
        callEvent("call-1", "read_file", { path: "a" }),
        callEvent("call-1", "read_file", { path: "b" }),
        { type: "completed" },
      ],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      code: "duplicate_tool_call_id",
      retryable: false,
    });
  });

  it("rejects a tool call id reused by a later turn", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file", { path: "a" }), { type: "completed" }],
      [callEvent("call-1", "read_file", { path: "b" }), { type: "completed" }],
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events.at(-1)).toMatchObject({ code: "duplicate_tool_call_id" });
    expect(gateway.calls).toHaveLength(2);
    expect(tools.requests).toHaveLength(1);
  });

  it("executes nothing at all when the batch holds an invalid call", async () => {
    const gateway = scriptedGateway([
      [
        callEvent("call-1", "read_file", { path: "a" }),
        callEvent("call-2", "read_file", { limit: Number.NaN }),
        callEvent("call-3", "read_file", { path: "c" }),
        { type: "completed" },
      ],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(events.filter((event) => event.type === "tool_execution_started")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ code: "invalid_tool_call" });
  });
});

describe("task 6 runtime security — tool call budget", () => {
  it("rejects a turn with too many tool calls without running any of them", async () => {
    const gateway = scriptedGateway([
      [
        callEvent("call-1", "read_file"),
        callEvent("call-2", "read_file"),
        callEvent("call-3", "read_file"),
        { type: "completed" },
      ],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxToolCallsPerTurn: 2,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "too_many_tool_calls",
      message: "The model returned too many tool calls.",
      retryable: false,
    });
  });

  it("accepts a turn exactly at the tool call limit", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), callEvent("call-2", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({
      gateway,
      toolExecutor: tools.executor,
      maxToolCallsPerTurn: 2,
    });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("loop_completed");
  });
});

describe("task 6 runtime security — malformed tool results", () => {
  it("turns a non string content into a fixed tool failure", async () => {
    for (const bad of [null, 42, {}, { content: 42 }, [], true]) {
      const gateway = scriptedGateway([
        [callEvent("call-1", "read_file"), { type: "completed" }],
        [{ type: "text_delta", text: "ok" }, { type: "completed" }],
      ]);
      const tools = recordingExecutor(() => bad as never);
      const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

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
    }
  });

  it("turns a non boolean isError into a fixed tool failure", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(
      () => ({ content: "body", isError: "yes" }) as never,
    );
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events).toContainEqual({
      type: "tool_execution_completed",
      requestId: "req-6",
      turnIndex: 0,
      toolCallId: "call-1",
      isError: true,
    });
  });

  it("never exposes a raw tool exception, path or secret to any event", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => {
      const error = new Error(
        `${PROBE} at /home/user/.ssh/id_rsa via https://provider.invalid/v1`,
      );
      error.name = "ToolExplosion";
      throw error;
    });
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain(PROBE);
    expect(serialized).not.toContain("id_rsa");
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("ToolExplosion");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("at ");
  });

  it("never exposes a raw tool rejection reason to any event", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file"), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = recordingExecutor(() => Promise.reject(new Error(PROBE)));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(JSON.stringify(events)).not.toContain(PROBE);
    expect(events.at(-1)?.type).toBe("loop_completed");
  });
});

describe("task 6 runtime security — gateway error handling", () => {
  it("forwards a sanitized Agent Core error and stops the loop", async () => {
    const gateway = scriptedGateway([
      [
        {
          type: "error",
          code: "provider_internal_error",
          message: `${PROBE} connect ECONNREFUSED https://provider.invalid/v1`,
          retryable: true,
        },
      ],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));
    const serialized = JSON.stringify(events);
    const error = errorEvents(events)[0];

    expect(error).toBeDefined();
    expect(error).toMatchObject({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "gateway_error",
      message: "Model gateway request failed.",
    });
    expect(serialized).not.toContain(PROBE);
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
  });

  it("keeps the Agent Core aborted wording and emits no completed", async () => {
    const gateway = scriptedGateway([
      [
        { type: "text_delta", text: "partial" },
        { type: "error", code: "aborted", message: PROBE, retryable: false },
      ],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest()));

    expect(textOf(events)).toBe("partial");
    expect(events.filter((event) => event.type === "completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-6",
      turnIndex: 0,
      code: "aborted",
      message: "Request aborted.",
      retryable: false,
    });
  });

  it("turns an upstream throw into a fixed gateway error", async () => {
    const throwing = {
      stream(): AsyncIterable<never> {
        return (async function* explode(): AsyncIterable<never> {
          throw new Error(`${PROBE} raw upstream explosion`);
        })();
      },
    };
    const loop = createAgentLoop({ gateway: throwing });

    const events = await collect(loop.run(makeRequest()));

    expect(JSON.stringify(events)).not.toContain(PROBE);
    expect(events.filter((event) => event.type === "loop_completed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      code: "gateway_error",
      message: "Model gateway request failed.",
      retryable: false,
    });
  });

  it("never runs a tool after a gateway error", async () => {
    const gateway = scriptedGateway([
      [
        callEvent("call-1", "read_file"),
        { type: "error", code: "rate_limited", message: "slow down", retryable: true },
      ],
    ]);
    const tools = recordingExecutor(() => resultFor("body"));
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(gateway.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ code: "rate_limited", retryable: true });
  });
});

describe("task 6 runtime security — source and package boundaries", () => {
  it("keeps a runtime dependency set limited to agent-core and agent-contracts", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const dependencies = Object.keys(manifest.dependencies ?? {});
    expect(dependencies.sort()).toEqual([
      "@agent-workbench/agent-contracts",
      "@agent-workbench/agent-core",
    ]);
    for (const key of Object.keys(manifest.devDependencies ?? {})) {
      expect(key, "agent-runtime must not declare devDependencies").toBe("");
    }
  });

  it("never depends on the gateway or the provider registry", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    );
    const declared = Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    });

    expect(declared).not.toContain("@agent-workbench/model-gateway");
    expect(declared).not.toContain("@agent-workbench/provider-registry");
  });

  it("never reaches into another package through a relative src path", () => {
    for (const file of runtimeSourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text, relative(APP_ROOT, file)).not.toMatch(/from\s+"\.\.\/\.\.\//);
      expect(text, relative(APP_ROOT, file)).not.toMatch(/from\s+"\.\.[\\/]agent-/);
    }
  });

  it("is not referenced by agent-core or the model gateway", () => {
    for (const pkg of ["agent-core", "model-gateway"]) {
      const manifest = readFileSync(
        join(APP_ROOT, "packages", pkg, "package.json"),
        "utf8",
      );
      expect(manifest, `${pkg} must not depend on agent-runtime`).not.toContain(
        "agent-runtime",
      );
    }
  });

  it("contains no shell, filesystem or network capability", () => {
    const forbidden = [
      "fetch(",
      "node:http",
      "node:https",
      "node:fs",
      "node:child_process",
      "WebSocket",
      "process.env",
      "keytar",
      "sqlite",
      "require(",
    ];

    for (const file of runtimeSourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const token of forbidden) {
        expect(text, `${relative(APP_ROOT, file)} contains ${token}`).not.toContain(token);
      }
    }
  });

  it("does not import the provider registry or the gateway by package name", () => {
    for (const file of runtimeSourceFiles()) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("@agent-workbench/provider-registry");
      expect(text).not.toContain("@agent-workbench/model-gateway");
    }
  });

  it("declares no credential, authorization or transport field on its options", () => {
    const text = readFileSync(join(PACKAGE_ROOT, "src", "types.ts"), "utf8");
    for (const token of ["apiKey", "api_key", "authorization", "headers", "baseUrl", "endpoint"]) {
      expect(text, `types.ts mentions ${token}`).not.toContain(token);
    }
  });
});

describe("task 6 runtime security — a hanging tool executor is still bounded", () => {
  it("does not leak tool input through the completion event", async () => {
    const gateway = scriptedGateway([
      [callEvent("call-1", "read_file", { token: PROBE }), { type: "completed" }],
      [{ type: "text_delta", text: "ok" }, { type: "completed" }],
    ]);
    const tools = hangingExecutor();
    const loop = createAgentLoop({ gateway, toolExecutor: tools.executor });

    const events: unknown[] = [];
    const drain = (async () => {
      for await (const event of loop.run(makeRequest({ tools: [READ] }))) {
        events.push(event);
      }
    })();

    await until(() => tools.calls.length === 1);
    tools.resolveLate(resultFor("body"));
    await drain;

    const completion = events.find(
      (event) => (event as { type: string }).type === "tool_execution_completed",
    );
    expect(completion).toBeDefined();
    expect(JSON.stringify(completion)).not.toContain(PROBE);
    // The tool result body never travels through the event stream either.
    expect(JSON.stringify(events)).not.toContain("body");
    expect((events.at(-1) as { type: string }).type).toBe("loop_completed");
  });
});
