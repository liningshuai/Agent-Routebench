import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import { createAgentCore } from "../packages/agent-core/src/index.js";
import type { HttpClient } from "../packages/model-gateway/src/index.js";
import { createRoutedHttpModelGateway } from "../packages/model-gateway/src/index.js";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
} from "../packages/provider-registry/src/index.js";
import {
  collectEvents,
  createGatedSource,
  nextEvent,
  tick,
} from "./helpers/adapter-fixtures.js";
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_CLOSE,
  ANTHROPIC_OPEN,
  DEFAULT_CREDENTIAL_REF,
  LEAK_PROBE,
  OPENAI_BASE_URL,
  OPENAI_CLOSE,
  SECOND_SECRET,
  TEST_SECRET,
  anthropicDeltaFrame,
  anthropicTextStream,
  bytesBody,
  createFakeHttpClient,
  headerValue,
  httpResponse,
  makeRequest,
  makeRouteFixture,
  openaiDeltaFrame,
  openaiTextStream,
} from "./helpers/http-fixtures.js";

const ABORTED: ModelStreamEvent = {
  type: "error",
  code: "aborted",
  message: "Request aborted.",
  retryable: false,
};

function build(fixture: ReturnType<typeof makeRouteFixture>, client: HttpClient) {
  return createRoutedHttpModelGateway({
    registry: fixture.registry,
    credentials: fixture.credentials,
    httpClient: client,
  });
}

async function runCore(
  gateway: ReturnType<typeof createRoutedHttpModelGateway>,
  request = makeRequest(),
  signal?: AbortSignal,
): Promise<AgentEvent[]> {
  const core = createAgentCore(gateway);
  const events: AgentEvent[] = [];
  for await (const event of core.run(request, signal)) {
    events.push(event);
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * Incremental streaming
 * ------------------------------------------------------------------ */

describe("task 4 — incremental streaming through the HTTP transport", () => {
  it("emits the first Anthropic delta before the stream is complete", async () => {
    const fixture = makeRouteFixture();
    const body = createGatedSource();
    const http = createFakeHttpClient(() => httpResponse(200, body.stream));
    const gateway = build(fixture, http.client);

    const iterator = gateway.stream(makeRequest())[Symbol.asyncIterator]();

    body.push(ANTHROPIC_OPEN);
    body.push(anthropicDeltaFrame("first"));

    const first = await nextEvent(iterator, 500);
    expect(first.value).toEqual({ type: "text_delta", text: "first" });

    body.push(anthropicDeltaFrame("second"));
    expect((await nextEvent(iterator, 500)).value).toEqual({
      type: "text_delta",
      text: "second",
    });

    body.push(ANTHROPIC_CLOSE);
    body.close();

    const rest = await collectEvents({ [Symbol.asyncIterator]: () => iterator });
    expect(rest).toEqual([
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed" },
    ]);
  });

  it("emits the first OpenAI delta before the stream is complete", async () => {
    const fixture = makeRouteFixture({ protocol: "openai_compatible" });
    const body = createGatedSource();
    const http = createFakeHttpClient(() => httpResponse(200, body.stream));
    const gateway = build(fixture, http.client);

    const iterator = gateway.stream(makeRequest())[Symbol.asyncIterator]();

    body.push(openaiDeltaFrame("first"));
    expect((await nextEvent(iterator, 500)).value).toEqual({
      type: "text_delta",
      text: "first",
    });

    body.push(openaiDeltaFrame("second"));
    expect((await nextEvent(iterator, 500)).value).toEqual({
      type: "text_delta",
      text: "second",
    });

    body.push(OPENAI_CLOSE);
    body.close();

    const rest = await collectEvents({ [Symbol.asyncIterator]: () => iterator });
    expect(rest).toEqual([{ type: "completed" }]);
  });

  it("does not wait for the whole response before the first event", async () => {
    const fixture = makeRouteFixture();
    const body = createGatedSource();
    const http = createFakeHttpClient(() => httpResponse(200, body.stream));
    const gateway = build(fixture, http.client);

    const iterator = gateway.stream(makeRequest())[Symbol.asyncIterator]();
    body.push(ANTHROPIC_OPEN);
    body.push(anthropicDeltaFrame("partial"));

    // The gate is still open and no terminator has been pushed.
    const first = await nextEvent(iterator, 500);
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text_delta", text: "partial" });

    body.push(ANTHROPIC_CLOSE);
    body.close();
    await collectEvents({ [Symbol.asyncIterator]: () => iterator });
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation and resource release
 * ------------------------------------------------------------------ */

describe("task 4 — cancellation and upstream release", () => {
  it("emits one aborted event without any HTTP call when pre-cancelled", async () => {
    const fixture = makeRouteFixture();
    const asked: string[] = [];
    const credentials = {
      set: (ref: string, secret: string) => fixture.credentials.set(ref, secret),
      get: (ref: string) => {
        asked.push(ref);
        return fixture.credentials.get(ref);
      },
      has: (ref: string) => fixture.credentials.has(ref),
      delete: (ref: string) => fixture.credentials.delete(ref),
    };
    const http = createFakeHttpClient(() => httpResponse(200, bytesBody(anthropicTextStream())));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials,
      httpClient: http.client,
    });

    const controller = new AbortController();
    controller.abort();

    const events = await collectEvents(
      gateway.stream(makeRequest(), controller.signal),
    );

    expect(events).toEqual([ABORTED]);
    expect(http.calls()).toBe(0);
    expect(asked).toEqual([]);
  });

  it("propagates the caller AbortSignal to the HTTP client", async () => {
    const fixture = makeRouteFixture();
    const body = createGatedSource();
    const http = createFakeHttpClient(() => httpResponse(200, body.stream));
    const gateway = build(fixture, http.client);
    const controller = new AbortController();

    const iterator = gateway
      .stream(makeRequest(), controller.signal)
      [Symbol.asyncIterator]();

    body.push(ANTHROPIC_OPEN);
    body.push(anthropicDeltaFrame("first"));
    expect((await nextEvent(iterator)).value).toEqual({
      type: "text_delta",
      text: "first",
    });

    expect(http.request(0).signal).toBe(controller.signal);

    controller.abort();

    expect((await nextEvent(iterator)).value).toEqual(ABORTED);
    expect((await nextEvent(iterator)).done).toBe(true);
    expect(body.returnCalls).toBeGreaterThanOrEqual(1);
  });

  it("suppresses later events and never completes after a mid stream abort", async () => {
    const fixture = makeRouteFixture();
    const body = createGatedSource();
    const http = createFakeHttpClient(() => httpResponse(200, body.stream));
    const gateway = build(fixture, http.client);
    const controller = new AbortController();

    const iterator = gateway
      .stream(makeRequest(), controller.signal)
      [Symbol.asyncIterator]();

    body.push(ANTHROPIC_OPEN);
    body.push(anthropicDeltaFrame("first"));
    expect((await nextEvent(iterator)).value).toEqual({
      type: "text_delta",
      text: "first",
    });

    controller.abort();

    const rest: ModelStreamEvent[] = [];
    for (;;) {
      const step = await nextEvent(iterator);
      if (step.done === true) {
        break;
      }
      rest.push(step.value);
    }

    expect(rest).toEqual([ABORTED]);
    expect(rest.some((event) => event.type === "completed")).toBe(false);
    expect(rest.some((event) => event.type === "text_delta")).toBe(false);
  });

  it("ends with aborted while the HTTP client promise is still pending", async () => {
    const fixture = makeRouteFixture();
    let alreadyPending = false;
    const hangingClient: HttpClient = () => {
      alreadyPending = true;
      return new Promise(() => {
        /* deliberately never settles */
      });
    };
    const gateway = build(fixture, hangingClient);

    const controller = new AbortController();
    const iterator = gateway
      .stream(makeRequest(), controller.signal)
      [Symbol.asyncIterator]();

    const first = iterator.next();
    await tick();
    expect(alreadyPending).toBe(true);

    controller.abort();

    // The call that was already waiting is the one that resolves, with aborted.
    expect((await first).value).toEqual(ABORTED);
    expect((await nextEvent(iterator)).done).toBe(true);
  });

  it("does not leak an unhandled rejection when the client rejects after abort", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const fixture = makeRouteFixture();
      let rejectLate: ((error: unknown) => void) | undefined;
      const client: HttpClient = () =>
        new Promise((_, reject) => {
          rejectLate = reject;
        });
      const gateway = build(fixture, client);

      const controller = new AbortController();
      const iterator = gateway
        .stream(makeRequest(), controller.signal)
        [Symbol.asyncIterator]();

      const first = iterator.next();
      await tick();
      controller.abort();

      expect((await first).value).toEqual(ABORTED);

      rejectLate?.(new Error("late transport failure"));
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not let a hanging body cleanup block cancellation", async () => {
    const fixture = makeRouteFixture();
    let returnCalled = false;
    const hangingBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: () => {
            returnCalled = true;
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
        };
      },
    };
    const http = createFakeHttpClient(() => httpResponse(200, hangingBody));
    const gateway = build(fixture, http.client);

    const controller = new AbortController();
    const iterator = gateway
      .stream(makeRequest(), controller.signal)
      [Symbol.asyncIterator]();

    const first = iterator.next();
    await tick();
    controller.abort();

    expect((await first).value).toEqual(ABORTED);
    expect((await nextEvent(iterator)).done).toBe(true);
    expect(returnCalled).toBe(true);
  });

  it("does not produce an unhandled rejection when the body fails after abort", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const fixture = makeRouteFixture();
      const body = createGatedSource();
      const http = createFakeHttpClient(() => httpResponse(200, body.stream));
      const gateway = build(fixture, http.client);
      const controller = new AbortController();

      const iterator = gateway
        .stream(makeRequest(), controller.signal)
        [Symbol.asyncIterator]();

      body.push(ANTHROPIC_OPEN);
      body.push(anthropicDeltaFrame("first"));
      await nextEvent(iterator);

      controller.abort();
      expect((await nextEvent(iterator)).value).toEqual(ABORTED);
      await nextEvent(iterator);

      body.fail(new Error("late upstream failure"));
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("releases the response body when the consumer stops early", async () => {
    const fixture = makeRouteFixture();
    const body = createGatedSource();
    const http = createFakeHttpClient(() => httpResponse(200, body.stream));
    const gateway = build(fixture, http.client);

    const iterator = gateway.stream(makeRequest())[Symbol.asyncIterator]();
    body.push(ANTHROPIC_OPEN);
    body.push(anthropicDeltaFrame("first"));
    await nextEvent(iterator);

    await iterator.return?.(undefined);
    await tick();

    expect(body.returnCalls).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency isolation
 * ------------------------------------------------------------------ */

describe("task 4 — concurrent isolation", () => {
  it("keeps two concurrent requests on one gateway instance separate", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider({
      id: "provider-a",
      name: "Provider A",
      protocol: "anthropic_messages",
      baseUrl: ANTHROPIC_BASE_URL,
      credentialRef: "credential:a",
      models: ["model-a"],
      enabled: true,
    });
    registry.registerProvider({
      id: "provider-b",
      name: "Provider B",
      protocol: "openai_compatible",
      baseUrl: OPENAI_BASE_URL,
      credentialRef: "credential:b",
      models: ["model-b"],
      enabled: true,
    });
    registry.registerRoute({
      id: "route-a",
      name: "Route A",
      providerId: "provider-a",
      model: "model-a",
      enabled: true,
    });
    registry.registerRoute({
      id: "route-b",
      name: "Route B",
      providerId: "provider-b",
      model: "model-b",
      enabled: true,
    });

    const credentials = new InMemoryCredentialStore();
    await credentials.set("credential:a", TEST_SECRET);
    await credentials.set("credential:b", SECOND_SECRET);

    const bodies = [createGatedSource(), createGatedSource()];
    const http = createFakeHttpClient((_request, index) =>
      httpResponse(200, bodies[index].stream),
    );
    const gateway = createRoutedHttpModelGateway({
      registry,
      credentials,
      httpClient: http.client,
    });

    const firstIterator = gateway
      .stream(makeRequest({ routeId: "route-a", model: "model-a" }))
      [Symbol.asyncIterator]();
    const secondIterator = gateway
      .stream(makeRequest({ routeId: "route-b", model: "model-b" }))
      [Symbol.asyncIterator]();

    bodies[0].push(ANTHROPIC_OPEN);
    bodies[0].push(anthropicDeltaFrame("A"));
    bodies[1].push(openaiDeltaFrame("B"));

    expect((await nextEvent(firstIterator)).value).toEqual({
      type: "text_delta",
      text: "A",
    });
    expect((await nextEvent(secondIterator)).value).toEqual({
      type: "text_delta",
      text: "B",
    });

    // Each request carried its own credential to its own provider.
    expect(http.request(0).url).toBe(`${ANTHROPIC_BASE_URL}/v1/messages`);
    expect(http.request(1).url).toBe(`${OPENAI_BASE_URL}/chat/completions`);
    expect(headerValue(http.request(0).headers, "x-api-key")).toBe(TEST_SECRET);
    expect(headerValue(http.request(1).headers, "authorization")).toBe(
      `Bearer ${SECOND_SECRET}`,
    );
    expect(http.request(0).body).not.toContain(SECOND_SECRET);
    expect(http.request(1).body).not.toContain(TEST_SECRET);

    bodies[0].push(ANTHROPIC_CLOSE);
    bodies[0].close();
    bodies[1].push(OPENAI_CLOSE);
    bodies[1].close();

    await collectEvents({ [Symbol.asyncIterator]: () => firstIterator });
    await collectEvents({ [Symbol.asyncIterator]: () => secondIterator });

    expect(headerValue(http.request(0).headers, "authorization")).toBeUndefined();
    expect(headerValue(http.request(1).headers, "x-api-key")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Agent Core integration
 * ------------------------------------------------------------------ */

describe("task 4 — Agent Core integration over the routed HTTP gateway", () => {
  it("produces route_selected, text, usage and completed", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream("alpha"))),
    );
    const gateway = build(fixture, http.client);

    const events = await runCore(gateway);

    expect(events[0]).toEqual({
      type: "route_selected",
      requestId: "req-t4",
      routeId: "route-t4",
      model: "offline-model",
    });
    expect(events).toContainEqual({
      type: "text_delta",
      requestId: "req-t4",
      text: "alpha",
    });
    expect(events).toContainEqual({
      type: "usage",
      requestId: "req-t4",
      inputTokens: 7,
      outputTokens: 5,
    });
    expect(events[events.length - 1]).toEqual({
      type: "completed",
      requestId: "req-t4",
    });
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(http.calls()).toBe(1);
  });

  it("works the same way through the OpenAI Chat Completions route", async () => {
    const fixture = makeRouteFixture({ protocol: "openai_compatible" });
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(openaiTextStream("alpha"))),
    );
    const gateway = build(fixture, http.client);

    const events = await runCore(gateway);

    expect(events[0]?.type).toBe("route_selected");
    expect(events).toContainEqual({
      type: "text_delta",
      requestId: "req-t4",
      text: "alpha",
    });
    expect(events[events.length - 1]).toEqual({
      type: "completed",
      requestId: "req-t4",
    });
    expect(http.calls()).toBe(1);
  });

  it("never puts a URL, credential reference, header or secret into Agent Events", async () => {
    for (const protocol of ["anthropic_messages", "openai_compatible"] as const) {
      const fixture = makeRouteFixture({ protocol });
      const http = createFakeHttpClient(() =>
        httpResponse(
          200,
          bytesBody(
            protocol === "anthropic_messages"
              ? anthropicTextStream()
              : openaiTextStream(),
          ),
        ),
      );
      const gateway = build(fixture, http.client);

      const events = await runCore(gateway);
      const serialized = JSON.stringify(events);

      expect(serialized, protocol).not.toContain(ANTHROPIC_BASE_URL);
      expect(serialized, protocol).not.toContain(OPENAI_BASE_URL);
      expect(serialized, protocol).not.toContain(TEST_SECRET);
      expect(serialized, protocol).not.toContain(DEFAULT_CREDENTIAL_REF);
      expect(serialized, protocol).not.toContain("credential:");
      expect(serialized, protocol).not.toContain("x-api-key");
      expect(serialized, protocol).not.toContain("authorization");
      expect(serialized, protocol).not.toContain("content-type");
      expect(events.every((event) => "requestId" in event)).toBe(true);
    }
  });

  it("turns an HTTP failure into one fixed safe Agent error", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(
        429,
        bytesBody(`{"error":"${LEAK_PROBE}","url":"${ANTHROPIC_BASE_URL}"}`),
      ),
    );
    const gateway = build(fixture, http.client);

    const events = await runCore(gateway);

    const errors = events.filter((event) => event.type === "error");
    expect(errors).toEqual([
      {
        type: "error",
        requestId: "req-t4",
        code: "rate_limited",
        message: "Model gateway request failed.",
        retryable: true,
      },
    ]);
    expect(events.some((event) => event.type === "completed")).toBe(false);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(LEAK_PROBE);
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
  });

  it("turns a transport failure into one fixed safe Agent error", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => {
      throw new Error(`ECONNREFUSED ${ANTHROPIC_BASE_URL} ${LEAK_PROBE}`);
    });
    const gateway = build(fixture, http.client);

    const events = await runCore(gateway);

    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "upstream_unavailable",
      message: "Model gateway request failed.",
      retryable: true,
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
    expect(serialized).not.toContain(LEAK_PROBE);
  });

  it("never issues a second HTTP request for one Agent Core run", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(503, null));
    const gateway = build(fixture, http.client);

    await runCore(gateway);

    expect(http.calls()).toBe(1);
  });

  it("does not call the gateway at all when Agent Core rejects the request", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(200, null));
    const gateway = build(fixture, http.client);

    const events = await runCore(
      gateway,
      makeRequest({ requestId: "", messages: [] }),
    );

    expect(events[0]?.type).toBe("error");
    expect(http.calls()).toBe(0);
  });
});
