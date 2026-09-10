import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../packages/agent-contracts/src/index.js";
import type { ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import {
  createFetchHttpClient,
  createRoutedHttpModelGateway,
  encodeAnthropicMessagesRequest,
  encodeOpenAIChatRequest,
} from "../packages/model-gateway/src/index.js";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
  type CredentialStore,
} from "../packages/provider-registry/src/index.js";
import { collectEvents, errorEventCodes } from "./helpers/adapter-fixtures.js";
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
  LEAK_PROBE,
  OPENAI_BASE_URL,
  SECOND_SECRET,
  TEST_SECRET,
  anthropicTextStream,
  bytesBody,
  chunksBody,
  createFakeHttpClient,
  disableProvider,
  headerNames,
  headerValue,
  httpResponse,
  makeRequest,
  makeRouteFixture,
  openaiTextStream,
  toolDefinition,
} from "./helpers/http-fixtures.js";

const NO_BODY = null;

async function collect(
  gateway: ReturnType<typeof createRoutedHttpModelGateway>,
  request: ModelRequest,
  signal?: AbortSignal,
): Promise<ModelStreamEvent[]> {
  return collectEvents(gateway.stream(request, signal));
}

describe("task 4 — route resolution and the credential boundary", () => {
  it("resolves an Anthropic route and issues exactly one HTTP request", async () => {
    const fixture = makeRouteFixture({ protocol: "anthropic_messages" });
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream("hi"))),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(http.calls()).toBe(1);
    expect(http.request(0).url).toBe(`${ANTHROPIC_BASE_URL}/v1/messages`);
    expect(http.request(0).method).toBe("POST");
  });

  it("resolves an OpenAI route and issues exactly one HTTP request", async () => {
    const fixture = makeRouteFixture({ protocol: "openai_compatible" });
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(openaiTextStream("hi"))),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(http.calls()).toBe(1);
    expect(http.request(0).url).toBe(`${OPENAI_BASE_URL}/chat/completions`);
  });

  it("does not touch the network when the route is unknown", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(
      gateway,
      makeRequest({ routeId: "route-does-not-exist" }),
    );

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("does not touch the network when the route is disabled", async () => {
    const fixture = makeRouteFixture({ routeEnabled: false });
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
  });

  it("does not touch the network when the provider is disabled", async () => {
    const fixture = makeRouteFixture();
    disableProvider(fixture);
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
  });

  it("does not touch the network when credentialRef is null", async () => {
    const fixture = makeRouteFixture({ credentialRef: null, secret: null });
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
  });

  it("does not touch the network when the credential value is missing", async () => {
    const fixture = makeRouteFixture({ secret: null });
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
  });

  it("does not touch the network when request.model disagrees with the route", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest({ model: "other-model" }));

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
    expect(JSON.stringify(events)).not.toContain("other-model");
  });

  it("looks the secret up by the exact credentialRef only", async () => {
    const fixture = makeRouteFixture();
    const asked: string[] = [];
    const spyStore: CredentialStore = {
      set: (ref, secret) => fixture.credentials.set(ref, secret),
      get: (ref) => {
        asked.push(ref);
        return fixture.credentials.get(ref);
      },
      has: (ref) => fixture.credentials.has(ref),
      delete: (ref) => fixture.credentials.delete(ref),
    };
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: spyStore,
      httpClient: http.client,
    });

    await collect(gateway, makeRequest());

    expect(asked).toEqual([DEFAULT_CREDENTIAL_REF]);
  });

  it("reads the credential store only after the route resolved", async () => {
    const fixture = makeRouteFixture();
    const asked: string[] = [];
    const spyStore: CredentialStore = {
      set: (ref, secret) => fixture.credentials.set(ref, secret),
      get: (ref) => {
        asked.push(ref);
        return fixture.credentials.get(ref);
      },
      has: (ref) => fixture.credentials.has(ref),
      delete: (ref) => fixture.credentials.delete(ref),
    };
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: spyStore,
      httpClient: http.client,
    });

    await collect(gateway, makeRequest({ routeId: "route-missing" }));

    expect(asked).toEqual([]);
    expect(http.calls()).toBe(0);
  });

  it("emits exactly one terminal event for a route failure", async () => {
    const fixture = makeRouteFixture({ routeEnabled: false });
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });
});

describe("task 4 — HTTP request construction", () => {
  it("builds the exact Anthropic request", async () => {
    const fixture = makeRouteFixture({ protocol: "anthropic_messages" });
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const request = makeRequest();
    await collect(gateway, request);

    const recorded = http.request(0);
    expect(recorded.method).toBe("POST");
    expect(recorded.url).toBe("https://api.anthropic.test/v1/messages");
    expect(headerValue(recorded.headers, "content-type")).toBe("application/json");
    expect(headerValue(recorded.headers, "accept")).toBe("text/event-stream");
    expect(headerValue(recorded.headers, "anthropic-version")).toBe("2023-06-01");
    expect(headerValue(recorded.headers, "x-api-key")).toBe(TEST_SECRET);
    expect(headerValue(recorded.headers, "authorization")).toBeUndefined();
    expect(headerNames(recorded.headers)).toEqual([
      "accept",
      "anthropic-version",
      "content-type",
      "x-api-key",
    ]);
    expect(JSON.parse(recorded.body)).toEqual(
      encodeAnthropicMessagesRequest(request).body,
    );
  });

  it("builds the exact OpenAI Chat Completions request", async () => {
    const fixture = makeRouteFixture({ protocol: "openai_compatible" });
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(openaiTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const request = makeRequest();
    await collect(gateway, request);

    const recorded = http.request(0);
    expect(recorded.method).toBe("POST");
    expect(recorded.url).toBe("https://api.openai.test/v1/chat/completions");
    expect(headerValue(recorded.headers, "content-type")).toBe("application/json");
    expect(headerValue(recorded.headers, "accept")).toBe("text/event-stream");
    expect(headerValue(recorded.headers, "authorization")).toBe(
      `Bearer ${TEST_SECRET}`,
    );
    expect(headerValue(recorded.headers, "x-api-key")).toBeUndefined();
    expect(headerValue(recorded.headers, "anthropic-version")).toBeUndefined();
    expect(headerNames(recorded.headers)).toEqual([
      "accept",
      "authorization",
      "content-type",
    ]);
    expect(JSON.parse(recorded.body)).toEqual(
      encodeOpenAIChatRequest(request, "max_tokens").body,
    );
  });

  it("never produces a double slash when the base URL ends with a slash", async () => {
    for (const [protocol, baseUrl, expected] of [
      ["anthropic_messages", "https://api.anthropic.test/", "https://api.anthropic.test/v1/messages"],
      ["anthropic_messages", "https://api.anthropic.test///", "https://api.anthropic.test/v1/messages"],
      ["openai_compatible", "https://api.openai.test/v1/", "https://api.openai.test/v1/chat/completions"],
    ] as const) {
      const fixture = makeRouteFixture({ protocol, baseUrl });
      const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
      const gateway = createRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
      });

      await collect(gateway, makeRequest());

      expect(http.request(0).url, baseUrl).toBe(expected);
      expect(http.request(0).url).not.toContain("//v1");
      expect(http.request(0).url.slice("https://".length)).not.toContain("//");
    }
  });

  it("keeps the protocol body free of transport and identity fields", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    await collect(gateway, makeRequest());

    const body = http.request(0).body;
    expect(body).not.toContain("req-t4");
    expect(body).not.toContain("route-t4");
    expect(body).not.toContain("credential:");
    expect(body).not.toContain("http://");
    expect(body).not.toContain("https://");
    expect(body).not.toContain(TEST_SECRET);
    expect(body).not.toContain("authorization");
    expect(body).not.toContain("x-api-key");
    expect(body).not.toContain("headers");
  });

  it("refuses a request that tries to inject transport fields", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    for (const injected of [
      { headers: { authorization: `Bearer ${LEAK_PROBE}` } },
      { endpoint: "https://evil.test/steal" },
      { baseUrl: "https://evil.test" },
      { authorization: "Bearer " + LEAK_PROBE },
    ]) {
      const hostile = { ...makeRequest(), ...injected } as unknown as ModelRequest;
      const events = await collect(gateway, hostile);

      expect(http.calls(), JSON.stringify(injected)).toBe(0);
      expect(errorEventCodes(events), JSON.stringify(injected)).toEqual([
        "gateway_error",
      ]);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("evil.test");
      expect(serialized).not.toContain(LEAK_PROBE);
      expect(serialized).not.toContain("authorization");
    }
  });

  it("drops unknown extra request fields instead of putting them on the wire", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const extended = {
      ...makeRequest(),
      note: "not-a-protocol-field",
      stream: false,
    } as unknown as ModelRequest;

    await collect(gateway, extended);

    const recorded = http.request(0);
    expect(recorded.url).toBe(`${ANTHROPIC_BASE_URL}/v1/messages`);
    expect(headerNames(recorded.headers)).toEqual([
      "accept",
      "anthropic-version",
      "content-type",
      "x-api-key",
    ]);
    expect(recorded.body).not.toContain("not-a-protocol-field");
    expect(recorded.body).not.toContain("note");
    // The adapter always streams, whatever the caller tried to imply.
    expect((JSON.parse(recorded.body) as { stream?: boolean }).stream).toBe(true);
  });

  it("still encodes tool definitions into the protocol body", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const request = makeRequest({
      tools: [
        toolDefinition("read_file", "Read a file", { type: "object", properties: {} }),
      ],
    });

    await collect(gateway, request);

    const parsed = JSON.parse(http.request(0).body) as {
      tools?: { name?: string }[];
      stream?: boolean;
    };
    expect(parsed.stream).toBe(true);
    expect(parsed.tools?.[0]?.name).toBe("read_file");
  });

  it("passes the caller AbortSignal through to the HTTP client", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const controller = new AbortController();

    await collect(gateway, makeRequest(), controller.signal);

    expect(http.request(0).signal).toBe(controller.signal);
  });
});

describe("task 4 — HTTP status and transport error mapping", () => {
  const cases: readonly [number, string, boolean][] = [
    [429, "rate_limited", true],
    [408, "upstream_unavailable", true],
    [425, "upstream_unavailable", true],
    [500, "upstream_unavailable", true],
    [502, "upstream_unavailable", true],
    [503, "upstream_unavailable", true],
    [504, "upstream_unavailable", true],
    [400, "gateway_error", false],
    [401, "gateway_error", false],
    [403, "gateway_error", false],
    [404, "gateway_error", false],
    [409, "gateway_error", false],
    [422, "gateway_error", false],
    [301, "gateway_error", false],
    [505, "gateway_error", false],
  ];

  for (const [status, code, retryable] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const fixture = makeRouteFixture();
      const http = createFakeHttpClient(() =>
        // A hostile body that must never reach the event stream.
        httpResponse(status, bytesBody(`error ${LEAK_PROBE} https://api.anthropic.test`)),
      );
      const gateway = createRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
      });

      const events = await collect(gateway, makeRequest());

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "error",
        code,
        message: expect.any(String),
        retryable,
      });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(LEAK_PROBE);
      expect(serialized).not.toContain("api.anthropic.test");
      expect(serialized).not.toContain(String(status));
    });
  }

  it("maps a thrown transport failure to upstream_unavailable", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => {
      throw new Error(
        `connect ECONNREFUSED ${ANTHROPIC_BASE_URL}/v1/messages authorization: Bearer ${LEAK_PROBE}`,
      );
    });
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(errorEventCodes(events)).toEqual(["upstream_unavailable"]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
    expect(serialized).not.toContain(LEAK_PROBE);
    expect(serialized).not.toContain("Bearer");
  });

  it("maps a rejected transport promise to upstream_unavailable", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => Promise.reject(new Error("socket hang up")));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(errorEventCodes(events)).toEqual(["upstream_unavailable"]);
    expect(JSON.stringify(events)).not.toContain("socket hang up");
  });

  it("maps a 2xx response with no body to provider_protocol_error", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(200, null));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(errorEventCodes(events)).toEqual(["provider_protocol_error"]);
  });

  it("never reads the body of a non-2xx response", async () => {
    const fixture = makeRouteFixture();
    let bodyNextCalls = 0;
    let bodyReturnCalls = 0;
    const hostileBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            bodyNextCalls += 1;
            return { done: false, value: new Uint8Array([1]) };
          },
          async return() {
            bodyReturnCalls += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const http = createFakeHttpClient(() => httpResponse(401, hostileBody));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
    // The body is released without ever being read.
    expect(bodyNextCalls).toBe(0);
    expect(bodyReturnCalls).toBe(1);
  });

  it("keeps adapter decode failures as provider_protocol_error", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, chunksBody([new Uint8Array([0xff, 0x0a, 0x0a])])),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest());

    expect(errorEventCodes(events)).toEqual(["provider_protocol_error"]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("maps an internal encoding failure to gateway_error", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    // The shared validator tolerates this shape but the Anthropic subset does not.
    const request = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "late system" }] },
      ],
    });

    const events = await collect(gateway, request);

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
    expect(JSON.stringify(events)).not.toContain("late system");
  });

  it("issues exactly one HTTP request per stream call", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(503, null));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    await collect(gateway, makeRequest());

    // No retry and no failover in this stage.
    expect(http.calls()).toBe(1);
  });

  it("does not retry or fail over to another registered provider", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider({
      id: "provider-a",
      name: "Provider A",
      protocol: "anthropic_messages",
      baseUrl: ANTHROPIC_BASE_URL,
      credentialRef: "credential:a",
      models: ["offline-model"],
      enabled: true,
    });
    registry.registerProvider({
      id: "provider-b",
      name: "Provider B",
      protocol: "openai_compatible",
      baseUrl: OPENAI_BASE_URL,
      credentialRef: "credential:b",
      models: ["offline-model"],
      enabled: true,
    });
    registry.registerRoute({
      id: "route-a",
      name: "Route A",
      providerId: "provider-a",
      model: "offline-model",
      enabled: false,
    });
    registry.registerRoute({
      id: "route-b",
      name: "Route B",
      providerId: "provider-b",
      model: "offline-model",
      enabled: true,
    });

    const credentials = new InMemoryCredentialStore();
    await credentials.set("credential:a", TEST_SECRET);
    await credentials.set("credential:b", SECOND_SECRET);

    const http = createFakeHttpClient(() => httpResponse(200, NO_BODY));
    const gateway = createRoutedHttpModelGateway({
      registry,
      credentials,
      httpClient: http.client,
    });

    const events = await collect(gateway, makeRequest({ routeId: "route-a" }));

    expect(http.calls()).toBe(0);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
  });
});

describe("task 4 — default fetch based HTTP client", () => {
  it("is exported for production use", async () => {
    const module = await import("../packages/model-gateway/src/index.js");
    expect(typeof module.createFetchHttpClient).toBe("function");
    expect(typeof module.RoutedHttpModelGateway).toBe("function");
    expect(typeof module.createRoutedHttpModelGateway).toBe("function");
  });

  it("drives an injected fetch with a real Response and no network access", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = async (
      url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url, init });
      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const client = createFetchHttpClient(
      fakeFetch as unknown as typeof globalThis.fetch,
    );
    const response = await client({
      method: "POST",
      url: "https://api.anthropic.test/v1/messages",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.test/v1/messages");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe("{}");
    expect(response.status).toBe(200);

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body ?? []) {
      chunks.push(chunk);
    }
    const text = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const out = new Uint8Array(acc.length + chunk.length);
        out.set(acc, 0);
        out.set(chunk, acc.length);
        return out;
      }, new Uint8Array(0)),
    );
    expect(text).toContain("data: ok");
  });

  it("reports a null body when the response carries none", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(null, { status: 204 });

    const client = createFetchHttpClient(
      fakeFetch as unknown as typeof globalThis.fetch,
    );
    const response = await client({
      method: "POST",
      url: "https://api.anthropic.test/v1/messages",
      headers: {},
      body: "{}",
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
