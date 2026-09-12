import { describe, expect, test } from "vitest";
import {
  AgentBackendError,
  createAgentBackend,
  createAgentBackendRunner,
  toModelRequest,
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
  transportFailureResponse,
  DEFAULT_CREDENTIAL_REF,
} from "./helpers/http-fixtures.js";
import { anthropicToolUseStream, httpOk } from "./helpers/agent-backend-fixtures.js";
import type { CredentialStore, ProviderRegistry } from "../packages/provider-registry/src/index.js";

class RegistryClass implements ProviderRegistry {
  private readonly inner: ProviderRegistry;
  constructor(inner: ProviderRegistry) {
    this.inner = inner;
  }
  registerProvider(provider: Parameters<ProviderRegistry["registerProvider"]>[0]): void {
    this.inner.registerProvider(provider);
  }
  updateProvider(provider: Parameters<ProviderRegistry["updateProvider"]>[0]): void {
    this.inner.updateProvider(provider);
  }
  removeProvider(providerId: string): void {
    this.inner.removeProvider(providerId);
  }
  getProvider(providerId: string) {
    return this.inner.getProvider(providerId);
  }
  listProviders() {
    return this.inner.listProviders();
  }
  registerRoute(route: Parameters<ProviderRegistry["registerRoute"]>[0]): void {
    this.inner.registerRoute(route);
  }
  updateRoute(route: Parameters<ProviderRegistry["updateRoute"]>[0]): void {
    this.inner.updateRoute(route);
  }
  removeRoute(routeId: string): void {
    this.inner.removeRoute(routeId);
  }
  getRoute(routeId: string) {
    return this.inner.getRoute(routeId);
  }
  listRoutes() {
    return this.inner.listRoutes();
  }
  resolveRoute(routeId: string) {
    return this.inner.resolveRoute(routeId);
  }
  resolveRouteCandidates(routeId: string) {
    return this.inner.resolveRouteCandidates(routeId);
  }
}

class CredentialsClass implements CredentialStore {
  private readonly inner: CredentialStore;
  constructor(inner: CredentialStore) {
    this.inner = inner;
  }
  set(ref: string, secret: string): Promise<void> {
    return this.inner.set(ref, secret);
  }
  get(ref: string): Promise<string | undefined> {
    return this.inner.get(ref);
  }
  has(ref: string): Promise<boolean> {
    return this.inner.has(ref);
  }
  delete(ref: string): Promise<void> {
    return this.inner.delete(ref);
  }
}

function backendErrorOf(run: () => unknown): AgentBackendError {
  try {
    run();
  } catch (error) {
    return error as AgentBackendError;
  }
  throw new Error("expected a synchronous throw");
}

describe("Task 21: backend assembly", () => {
  test("createAgentBackend builds a runner from a valid registry and store", () => {
    const fixture = makeBackendRegistry();
    const backend = createAgentBackend({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("ok")]).client,
    });
    expect(typeof backend.runner.run).toBe("function");
  });

  test("createAgentBackendRunner returns a callable runner directly", () => {
    const fixture = makeBackendRegistry();
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("ok")]).client,
    });
    expect(typeof runner.run).toBe("function");
  });

  test("class-based registry, credential store and http client are accepted", () => {
    const fixture = makeBackendRegistry();
    const backend = createAgentBackend({
      registry: new RegistryClass(fixture.registry),
      credentials: new CredentialsClass(fixture.credentials),
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("ok")]).client,
    });
    expect(typeof backend.runner.run).toBe("function");
  });

  test("null-prototype options objects are accepted", () => {
    const fixture = makeBackendRegistry();
    const options = Object.create(null) as Record<string, unknown>;
    options.registry = fixture.registry;
    options.credentials = fixture.credentials;
    expect(() => createAgentBackend(options as never)).not.toThrow();
  });

  test("invalid options are rejected synchronously with a fixed error", () => {
    const fixture = makeBackendRegistry();
    const cases: readonly unknown[] = [
      null,
      undefined,
      42,
      "backend",
      [],
      {},
      { registry: fixture.registry },
      { credentials: fixture.credentials },
      { registry: {}, credentials: fixture.credentials },
      { registry: fixture.registry, credentials: {} },
      { registry: fixture.registry, credentials: fixture.credentials, defaultMaxTokens: 0 },
      { registry: fixture.registry, credentials: fixture.credentials, defaultMaxTokens: 1.5 },
      { registry: fixture.registry, credentials: fixture.credentials, maxTurns: -1 },
      { registry: fixture.registry, credentials: fixture.credentials, maxToolCallsPerTurn: 0 },
      { registry: fixture.registry, credentials: fixture.credentials, maxToolResultBytes: 0 },
    ];
    for (const options of cases) {
      const error = backendErrorOf(() => createAgentBackend(options as never));
      expect(error).toBeInstanceOf(AgentBackendError);
      expect(error.code).toBe("invalid_options");
      expect(error.message).toBe("Agent backend options are invalid.");
    }
  });

  test("construction never reads credentials and never touches HTTP", () => {
    const fixture = makeBackendRegistry();
    let getCalls = 0;
    const countingStore: CredentialStore = {
      get: async (ref) => {
        getCalls += 1;
        return fixture.credentials.get(ref);
      },
      set: async (ref, value) => fixture.credentials.set(ref, value),
      has: async () => true,
      delete: async () => undefined,
    };
    let httpCalls = 0;
    createAgentBackend({
      registry: fixture.registry,
      credentials: countingStore,
      httpClient: () => {
        httpCalls += 1;
        return Promise.resolve(anthropicSuccessResponse("ok"));
      },
    });
    expect(getCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });
});

describe("Task 21: resilience passthrough", () => {
  test("a retryable transport failure is retried by the resilient gateway", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("recovered"),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest())) {
      events.push(event);
    }
    expect(http.calls()).toBe(2);
    expect(events[events.length - 1]?.type).toBe("completed");
  });

  test("without a policy the governed executor denies tool execution", async () => {
    const fixture = makeBackendRegistry();
    let executed = false;
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
          executed = true;
          return { content: "should-not-run" };
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
    expect(executed).toBe(false);
    expect(events[events.length - 1]?.type).toBe("completed");
    expect(http.calls()).toBe(2);
  });
});

describe("Task 21: request conversion", () => {
  test("turnId becomes requestId and route/model pass through", () => {
    const model = toModelRequest(makeRunnerRequest(), 2048);
    expect(model.requestId).toBe(BACKEND_TURN_ID);
    expect(model.routeId).toBe(BACKEND_ROUTE_ID);
    expect(model.model).toBe(BACKEND_MODEL);
    expect(model.maxTokens).toBe(2048);
    expect(model.tools).toEqual([]);
  });

  test("messages and tools are defensively copied", () => {
    const request = makeRunnerRequest({
      tools: [{ name: "grep", description: "search", inputSchema: { type: "object" } }],
    });
    const model = toModelRequest(request, 2048);
    expect(model.messages).not.toBe(request.messages);
    expect(model.tools).not.toBe(request.tools);
    expect(model.messages).toEqual(request.messages);
  });

  test("missing or empty routeId and model are rejected", () => {
    for (const overrides of [
      { routeId: undefined },
      { routeId: "" },
      { model: undefined },
      { model: "" },
    ]) {
      expect(() => toModelRequest(makeRunnerRequest(overrides), 2048)).toThrow(
        AgentBackendError,
      );
    }
  });

  test("invalid maxTokens values are rejected", () => {
    for (const maxTokens of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toModelRequest(makeRunnerRequest({ maxTokens }), 2048)).toThrow(
        AgentBackendError,
      );
    }
    expect(() => toModelRequest(makeRunnerRequest(), 0)).toThrow(AgentBackendError);
  });

  test("the runner maps request failures to one fixed invalid_request event", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest({ routeId: "" }))) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      requestId: BACKEND_TURN_ID,
      code: "invalid_request",
      message: "Agent backend request is invalid.",
      retryable: false,
    });
    expect(http.calls()).toBe(0);
  });

  test("a route that does not exist never reaches HTTP", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest({ routeId: "route-missing" }))) {
      events.push(event);
    }
    expect(http.calls()).toBe(0);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  test("disabled provider, disabled route, missing credentialRef and missing secret never reach HTTP", async () => {
    const variants = [
      makeBackendRegistry({ providerEnabled: false }),
      makeBackendRegistry({ routeEnabled: false }),
      makeBackendRegistry({ credentialRef: null }),
      makeBackendRegistry({ credentialRef: DEFAULT_CREDENTIAL_REF, withSecret: false }),
    ];
    for (const fixture of variants) {
      const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
      const runner = createAgentBackendRunner({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
      });
      const events = [];
      for await (const event of await runner.run(makeRunnerRequest())) {
        events.push(event);
      }
      expect(http.calls()).toBe(0);
      expect(events.some((event) => event.type === "error")).toBe(true);
    }
  });

  test("maxTokens falls back to the configured default in the encoded request", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      defaultMaxTokens: 3333,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest())) {
      events.push(event);
    }
    expect(http.calls()).toBe(1);
    const body = http.request(0)?.body ?? "";
    expect(body).toContain("3333");
    expect(events.some((event) => event.type === "completed")).toBe(true);
  });
});
