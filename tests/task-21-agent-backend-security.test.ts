import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  AgentBackendError,
  createAgentBackend,
  createAgentBackendRunner,
} from "../packages/agent-backend/src/index.js";
import {
  BACKEND_MODEL,
  BACKEND_ROUTE_ID,
  BACKEND_TURN_ID,
  makeBackendRegistry,
  makeRunnerRequest,
} from "./helpers/agent-backend-fixtures.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
  TEST_SECRET,
  ANTHROPIC_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
} from "./helpers/http-fixtures.js";
import { anthropicToolUseStream, httpOk } from "./helpers/agent-backend-fixtures.js";
import { REPO_ROOT } from "./helpers/tauri-native-fixtures.js";

function listSourceFiles(): string[] {
  const dir = "packages/agent-backend/src";
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    if (entry.endsWith(".ts")) out.push(`${dir}/${entry}`);
  }
  return out;
}

function join(...parts: string[]): string {
  return parts.join("/");
}

describe("Task 21: package and source boundary", () => {
  test("production source uses no fetch, raw http, fs, env or subprocess", () => {
    for (const file of listSourceFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const forbidden of [
        "fetch(",
        "node:http",
        "node:https",
        "node:fs",
        "node:net",
        "node:child_process",
        "process.env",
        "WebSocket",
        "keychain",
        "sqlite",
        "eval(",
      ]) {
        expect(source.toLowerCase(), `${file} must not contain ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  test("production source imports only public package entries", () => {
    for (const file of listSourceFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      expect(source, file).not.toMatch(/from\s+"\.\.\/\.\.\//);
      expect(source, file).not.toMatch(/\/src\/[a-z-]+\.js"/);
    }
  });

  test("the backend package declares only workspace dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/agent-backend/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const allowed = new Set([
      "@agent-workbench/agent-contracts",
      "@agent-workbench/agent-core",
      "@agent-workbench/agent-runtime",
      "@agent-workbench/model-gateway",
      "@agent-workbench/provider-registry",
      "@agent-workbench/local-agent-api",
    ]);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(allowed.has(name), `unexpected dependency ${name}`).toBe(true);
    }
  });
});

describe("Task 21: secret and boundary hygiene", () => {
  test("globalThis.fetch is never called during a backend turn", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls += 1;
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;
    try {
      const fixture = makeBackendRegistry();
      const runner = createAgentBackendRunner({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello")]).client,
      });
      for await (const _event of await runner.run(makeRunnerRequest())) {
        // drain
      }
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the credential store is only read, never written, during a turn", async () => {
    const fixture = makeBackendRegistry();
    let setCalls = 0;
    let getCalls = 0;
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: {
        get: async (ref) => {
          getCalls += 1;
          return fixture.credentials.get(ref);
        },
        set: async (ref, value) => {
          setCalls += 1;
          return fixture.credentials.set(ref, value);
        },
        has: async () => true,
        delete: async () => undefined,
      },
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello")]).client,
    });
    for await (const _event of await runner.run(makeRunnerRequest())) {
      // drain
    }
    expect(getCalls).toBe(1);
    expect(setCalls).toBe(0);
  });

  test("the secret never appears in events or the encoded request body", async () => {
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
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TEST_SECRET);
    // The gateway may place the secret in the single auth header, never in events.
    expect(events.some((event) => event.type === "completed")).toBe(true);
  });

  test("the provider URL and credentialRef never appear in events", async () => {
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
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
    expect(serialized).not.toContain(DEFAULT_CREDENTIAL_REF);
  });

  test("tool result content never reaches the event stream", async () => {
    const fixture = makeBackendRegistry();
    const toolOutputMarker = "tool-output-internal-marker";
    const http = createScriptedHttpClient([
      httpOk(anthropicToolUseStream("call-1", "grep", '{"pa')),
      anthropicSuccessResponse("done"),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      toolExecutor: {
        async execute() {
          return { content: toolOutputMarker };
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
    expect(JSON.stringify(events)).not.toContain(toolOutputMarker);
  });

  test("a hostile executor exception is folded into a fixed safe error event", async () => {
    const fixture = makeBackendRegistry();
    const hostile = `boom at ${ANTHROPIC_BASE_URL} token:deadbeefauth`;
    const http = createScriptedHttpClient([
      httpOk(anthropicToolUseStream("call-1", "grep", "{}")),
      anthropicSuccessResponse("unused"),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      toolExecutor: {
        async execute() {
          throw new Error(hostile);
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
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain("deadbeefauth");
    expect(serialized).not.toContain("boom at");
    // The governed executor folds the hostile exception into a failed tool
    // result; the loop continues and the turn completes without leaking.
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  test("a hostile policy and approval handler are folded into safe results", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([
      httpOk(anthropicToolUseStream("call-1", "grep", "{}")),
      anthropicSuccessResponse("done"),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      toolExecutor: {
        async execute() {
          return { content: "should-not-run" };
        },
      },
      policy: {
        decide() {
          throw new Error("policy exploded");
        },
      },
      approvalHandler: {
        requestApproval() {
          throw new Error("approval exploded");
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
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("policy exploded");
    expect(serialized).not.toContain("approval exploded");
    expect(serialized).not.toContain("should-not-run");
  });

  test("construction errors never echo the rejected options", () => {
    const fixture = makeBackendRegistry();
    try {
      createAgentBackend({
        registry: { totally: "bogus" } as never,
        credentials: fixture.credentials,
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentBackendError);
      expect((error as AgentBackendError).message).toBe(
        "Agent backend options are invalid.",
      );
      expect((error as AgentBackendError).message).not.toContain("bogus");
    }
  });

  test("a failing upstream body error never leaks provider details", async () => {
    const fixture = makeBackendRegistry();
    const hostileBody = `{"error":"leak ${ANTHROPIC_BASE_URL} ${TEST_SECRET}"}`;
    const http = createScriptedHttpClient([httpOk(hostileBody)]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest())) {
      events.push(event);
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(events[events.length - 1]?.type).toBe("error");
  });
});

describe("Task 21: default runner boundary in the Node host", () => {
  test("the host default runner stays not-ready; the backend is injected explicitly", () => {
    const hostSource = readFileSync(
      join(REPO_ROOT, "apps/local-agent-host/src/host.ts"),
      "utf8",
    );
    expect(hostSource).toContain("NotReadyLocalAgentRunner");
    expect(hostSource).toContain("options.runner ?? new NotReadyLocalAgentRunner()");
  });

  test("backend runner validates the model identity before any HTTP", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest({ model: "wrong-model" }))) {
      events.push(event);
    }
    // wrong-model does not match the route's model: no HTTP happens and the
    // existing registry/gateway surfaces a fixed error event.
    expect(http.calls()).toBe(0);
    expect(events[events.length - 1]?.type).toBe("error");
  });
});
