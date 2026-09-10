import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TOOL_APPROVAL_FAILED_CONTENT,
  TOOL_APPROVAL_UNAVAILABLE_CONTENT,
  TOOL_FAILURE_CONTENT,
  TOOL_POLICY_DENIED_CONTENT,
  TOOL_POLICY_FAILED_CONTENT,
  createAgentLoop,
  createGovernedToolExecutor,
  type ToolApprovalHandler,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutor,
  type ToolPolicy,
} from "../packages/agent-runtime/src/index.js";
import {
  collect,
  makeRequest,
  recordingExecutor,
  resultFor,
  scriptedGateway,
  toolDefinition,
} from "./helpers/runtime-fixtures.js";

const READ = toolDefinition("read_file");

/**
 * Synthetic markers only. They exist purely so a leak would be observable:
 * they are not credentials, and they never leave the test process.
 */
const SECRET = "TASK7_SYNTHETIC_SECRET";
const URL_MARKER = "https://provider.invalid/v1";
const PATH_MARKER = "/home/user/.ssh/id_rsa";
const AUTH_MARKER = "Authorization: Bearer TASK7_SYNTHETIC_SECRET";
const STACK_MARKER = "Error: stack trace at Object.<anonymous>";

const LEAK_MARKERS = [SECRET, URL_MARKER, PATH_MARKER, AUTH_MARKER];

const MALICIOUS_INPUT = {
  path: PATH_MARKER,
  endpoint: URL_MARKER,
  authorization: AUTH_MARKER,
  token: SECRET,
};

const REQUEST: ToolExecutionRequest = {
  id: "call-1",
  name: "read_file",
  input: MALICIOUS_INPUT,
};

function expectNoLeak(serialized: string, label: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(serialized, `${label} leaked ${marker}`).not.toContain(marker);
  }
  expect(serialized, label).not.toContain("stack trace");
  expect(serialized, label).not.toContain("Authorization");
  expect(serialized, label).not.toContain("Bearer");
  expect(serialized, label).not.toContain("id_rsa");
}

function hostileError(): Error {
  const error = new Error(
    `boom ${SECRET} ${URL_MARKER} ${AUTH_MARKER} ${PATH_MARKER}`,
  );
  error.stack = `${STACK_MARKER} ${SECRET} ${PATH_MARKER}`;
  return error;
}

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

describe("task 7 security — hostile policy and approval failures", () => {
  it("never surfaces a throwing policy message or stack", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: {
        decide: () => {
          throw hostileError();
        },
      },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({ content: TOOL_POLICY_FAILED_CONTENT, isError: true });
    expectNoLeak(JSON.stringify(result), "policy throw result");
    expect(tools.requests).toHaveLength(0);
  });

  it("never surfaces a rejecting policy", async () => {
    const governed = createGovernedToolExecutor({
      executor: recordingExecutor(() => resultFor("never")).executor,
      policy: { decide: () => Promise.reject(hostileError()) },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({ content: TOOL_POLICY_FAILED_CONTENT, isError: true });
    expectNoLeak(JSON.stringify(result), "policy rejection result");
  });

  it("never surfaces a throwing approval handler", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: { decide: () => "ask" },
      approvalHandler: {
        requestApproval: () => {
          throw hostileError();
        },
      },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_APPROVAL_FAILED_CONTENT,
      isError: true,
    });
    expectNoLeak(JSON.stringify(result), "approval throw result");
    expect(tools.requests).toHaveLength(0);
  });

  it("never surfaces a rejecting approval handler", async () => {
    const governed = createGovernedToolExecutor({
      executor: recordingExecutor(() => resultFor("never")).executor,
      policy: { decide: () => "ask" },
      approvalHandler: {
        requestApproval: () => Promise.reject(hostileError()),
      } as ToolApprovalHandler,
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({
      content: TOOL_APPROVAL_FAILED_CONTENT,
      isError: true,
    });
    expectNoLeak(JSON.stringify(result), "approval rejection result");
  });

  it("never surfaces a hostile executor exception", async () => {
    const governed = createGovernedToolExecutor({
      executor: {
        execute: () => {
          throw hostileError();
        },
      },
      policy: { decide: () => "allow" },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({ content: TOOL_FAILURE_CONTENT, isError: true });
    expectNoLeak(JSON.stringify(result), "executor throw result");
  });

  it("keeps the fixed content constants free of any marker", () => {
    const constants = [
      TOOL_POLICY_DENIED_CONTENT,
      TOOL_APPROVAL_UNAVAILABLE_CONTENT,
      TOOL_POLICY_FAILED_CONTENT,
      TOOL_APPROVAL_FAILED_CONTENT,
      TOOL_FAILURE_CONTENT,
    ];
    for (const value of constants) {
      expectNoLeak(value, "constant");
    }
  });
});

describe("task 7 security — the approval request stays inside the boundary", () => {
  it("hands the input to the handler without ever emitting it", async () => {
    const seen: unknown[] = [];
    const governed = createGovernedToolExecutor({
      executor: recordingExecutor(() => resultFor("ok")).executor,
      policy: { decide: () => "ask" },
      approvalHandler: {
        requestApproval: (request: ToolExecutionRequest) => {
          seen.push(request);
          return "approved";
        },
      },
    });

    const result = await governed.execute(REQUEST);

    expect(result).toEqual({ content: "ok" });
    expect(seen).toEqual([REQUEST]);
    // The input is available to the injected handler but is never echoed back.
    expectNoLeak(JSON.stringify(result), "approved result");
  });

  it("keeps the tool payload out of every agent loop event", async () => {
    const gateway = scriptedGateway([
      // The tool call itself is benign: the event stream legitimately carries
      // the call, so the markers are placed only in the tool result.
      [
        { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a" } },
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "done" }, { type: "completed" }],
    ]);
    const governed = createGovernedToolExecutor({
      executor: { async execute() { return { content: `body ${SECRET} ${PATH_MARKER}` }; } },
      policy: { decide: () => "allow" },
    });
    const loop = createAgentLoop({ gateway, toolExecutor: governed });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    // The tool result reaches the next request (that is the protocol) but never
    // an event, an error or a completion marker.
    expectNoLeak(JSON.stringify(events), "agent loop events");
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  });

  it("reports a loop level failure with a fixed safe message", async () => {
    const gateway = scriptedGateway([
      [
        { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a" } },
        { type: "completed" },
      ],
      [{ type: "text_delta", text: "never" }, { type: "completed" }],
    ]);
    const governed = createGovernedToolExecutor({
      executor: {
        execute: () => {
          throw hostileError();
        },
      },
      policy: { decide: () => "allow" },
    });
    const loop = createAgentLoop({ gateway, toolExecutor: governed });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expectNoLeak(JSON.stringify(events), "loop with a hostile tool");
  });
});

describe("task 7 security — runtime source boundary", () => {
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
        expect(text, `${relative(APP_ROOT, file)} contains ${token}`).not.toContain(
          token,
        );
      }
    }
  });

  it("contains no logging, persistence or approval memory", () => {
    const forbidden = [
      "console.log",
      "console.error",
      "console.warn",
      "console.info",
      "localStorage",
      "writeFile",
      "appendFile",
      "createWriteStream",
      "remember",
      "alwaysAllow",
      "indexedDB",
      "openDatabase",
    ];

    for (const file of runtimeSourceFiles()) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const token of forbidden) {
        expect(text, `${relative(APP_ROOT, file)} contains ${token}`).not.toContain(
          token.toLowerCase(),
        );
      }
    }
  });

  it("governs tools without importing a concrete gateway or registry", () => {
    for (const file of runtimeSourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const token of ["model-gateway", "provider-registry"]) {
        expect(text, `${relative(APP_ROOT, file)} imports ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

describe("task 7 security — no default tools", () => {
  it("still refuses a tool call when no executor is configured at all", async () => {
    const gateway = scriptedGateway([
      [
        { type: "tool_call", id: "call-1", name: "read_file", input: {} },
        { type: "completed" },
      ],
    ]);
    const loop = createAgentLoop({ gateway });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ code: "tool_execution_unavailable" });
  });

  it("does not execute anything for an undeclared tool", async () => {
    const tools = recordingExecutor(() => resultFor("never"));
    const governed = createGovernedToolExecutor({
      executor: tools.executor,
      policy: { decide: () => "allow" },
    });
    const gateway = scriptedGateway([
      [
        { type: "tool_call", id: "call-1", name: "shell_exec", input: {} },
        { type: "completed" },
      ],
    ]);
    const loop = createAgentLoop({ gateway, toolExecutor: governed });

    const events = await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(tools.requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ code: "unknown_tool" });
  });

  it("never invokes the policy for a tool the request never declared", async () => {
    let policyCalls = 0;
    const policy: ToolPolicy = {
      decide: () => {
        policyCalls += 1;
        return "allow";
      },
    };
    const executor: ToolExecutor = {
      execute: (): Promise<ToolExecutionResult> => Promise.resolve(resultFor("never")),
    };
    const governed = createGovernedToolExecutor({ executor, policy });
    const gateway = scriptedGateway([
      [
        { type: "tool_call", id: "call-1", name: "network_fetch", input: {} },
        { type: "completed" },
      ],
    ]);
    const loop = createAgentLoop({ gateway, toolExecutor: governed });

    await collect(loop.run(makeRequest({ tools: [READ] })));

    expect(policyCalls).toBe(0);
  });
});
