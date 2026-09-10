import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import type {
  ModelGateway,
  RetryPolicy,
  RetryWait,
} from "../packages/model-gateway/src/index.js";
import {
  RETRYABLE_STREAM_ERROR_CODES,
  createResilientRoutedHttpModelGateway,
  createRoutedHttpModelGateway,
  isRetryableStreamError,
  isVisibleStreamEvent,
} from "../packages/model-gateway/src/index.js";
import {
  ANTHROPIC_CLOSE,
  ANTHROPIC_OPEN,
  SCRIPT_OVERRUN_TEXT,
  TASK5_FALLBACK_BASE_URL,
  TASK5_PRIMARY_BASE_URL,
  anthropicDeltaFrame,
  anthropicSuccessResponse,
  bytesBody,
  candidateFixture,
  createFakeHttpClient,
  createScriptedHttpClient,
  makeRequest,
  openaiSuccessResponse,
  transportFailureResponse,
  twoProviderFixture,
  type CandidateRegistryFixture,
  type FakeHttpClient,
} from "./helpers/http-fixtures.js";
import { createGatedSource, textOf } from "./helpers/adapter-fixtures.js";

/* ------------------------------------------------------------------ *
 * Fixtures and helpers
 * ------------------------------------------------------------------ */

const ABORTED: ModelStreamEvent = {
  type: "error",
  code: "aborted",
  message: "Request aborted.",
  retryable: false,
};

const OPENAI_TEXT_FRAME =
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n';

const OPENAI_TOOL_CALL_LEAD =
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"alpha"}}]},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';

const OPENAI_USAGE_LEAD =
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n';

const OPENAI_RATE_LIMITED_FRAME = 'data: {"error":{"type":"rate_limit_error"}}\n\n';

const ANTHROPIC_OVERLOADED_FRAME =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';

const FAST_POLICY: Partial<RetryPolicy> = {
  initialBackoffMs: 10,
  maxBackoffMs: 100,
};

interface WaitRecorder {
  readonly wait: RetryWait;
  readonly delays: number[];
  readonly signals: (AbortSignal | undefined)[];
}

/** Records delays and resolves on the next microtask: never a real sleep. */
function recordingWait(): WaitRecorder {
  const delays: number[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const wait: RetryWait = async (delayMs, signal) => {
    delays.push(delayMs);
    signals.push(signal);
    if (signal?.aborted === true) {
      return;
    }
    await Promise.resolve();
  };
  return { wait, delays, signals };
}

function buildResilient(
  fixture: CandidateRegistryFixture,
  http: FakeHttpClient,
  options: {
    readonly retryPolicy?: Partial<RetryPolicy>;
    readonly wait?: RetryWait;
    readonly registry?: CandidateRegistryFixture["registry"];
  } = {},
): ModelGateway {
  return createResilientRoutedHttpModelGateway({
    registry: options.registry ?? fixture.registry,
    credentials: fixture.credentials,
    httpClient: http.client,
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  });
}

function requestFor(fixture: CandidateRegistryFixture): ModelRequest {
  return makeRequest({
    requestId: "req-t5",
    routeId: fixture.routeId,
    model: fixture.model,
  });
}

async function run(
  gateway: ModelGateway,
  request: ModelRequest,
  signal?: AbortSignal,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of gateway.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

function urls(http: FakeHttpClient): string[] {
  return http.requests.map((entry) => entry.url);
}

/* ------------------------------------------------------------------ *
 * Retryability classification
 * ------------------------------------------------------------------ */

describe("task 5 resilience — retryable classification", () => {
  it("treats only whitelisted retryable error codes as retryable", () => {
    expect([...RETRYABLE_STREAM_ERROR_CODES].sort()).toEqual([
      "rate_limited",
      "upstream_unavailable",
    ]);

    for (const code of ["rate_limited", "upstream_unavailable"]) {
      expect(
        isRetryableStreamError({
          type: "error",
          code,
          message: "x",
          retryable: true,
        }),
        code,
      ).toBe(true);
    }
  });

  it("never retries aborted, protocol or gateway errors", () => {
    for (const [code, retryable] of [
      ["aborted", false],
      ["provider_protocol_error", false],
      ["gateway_error", false],
      ["aborted", true],
      ["provider_protocol_error", true],
    ] as const) {
      expect(
        isRetryableStreamError({ type: "error", code, message: "x", retryable }),
        code,
      ).toBe(false);
    }
  });

  it("never retries an error that is not marked retryable", () => {
    for (const code of ["rate_limited", "upstream_unavailable"]) {
      expect(
        isRetryableStreamError({
          type: "error",
          code,
          message: "x",
          retryable: false,
        }),
        code,
      ).toBe(false);
    }
  });

  it("classifies every non error event as already visible", () => {
    expect(isVisibleStreamEvent({ type: "text_delta", text: "a" })).toBe(true);
    expect(
      isVisibleStreamEvent({ type: "tool_call", id: "c", name: "n", input: {} }),
    ).toBe(true);
    expect(
      isVisibleStreamEvent({ type: "usage", inputTokens: 1, outputTokens: 1 }),
    ).toBe(true);
    expect(isVisibleStreamEvent({ type: "completed" })).toBe(true);
    expect(
      isVisibleStreamEvent({
        type: "error",
        code: "rate_limited",
        message: "x",
        retryable: true,
      }),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Retry within one provider
 * ------------------------------------------------------------------ */

describe("task 5 resilience — bounded retry on one provider", () => {
  it("retries a 503 on the same provider and succeeds on the second attempt", async () => {
    const fixture = twoProviderFixture();
    const wait = recordingWait();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("recovered"),
    ]);

    const events = await run(
      buildResilient(fixture, http, { wait: wait.wait, retryPolicy: FAST_POLICY }),
      requestFor(fixture),
    );

    expect(http.calls()).toBe(2);
    expect(urls(http)).toEqual([
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
    ]);
    expect(textOf(events)).toBe("recovered");
    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(wait.delays).toEqual([10]);
  });

  it("retries a 429 on the same provider", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(429),
      anthropicSuccessResponse("second"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(2);
    expect(textOf(events)).toBe("second");
    expect(urls(http)[0]).toBe(urls(http)[1]);
  });

  it("does not wait before the first attempt", async () => {
    const fixture = twoProviderFixture();
    const wait = recordingWait();
    const http = createScriptedHttpClient([anthropicSuccessResponse()]);

    await run(
      buildResilient(fixture, http, { wait: wait.wait, retryPolicy: FAST_POLICY }),
      requestFor(fixture),
    );

    expect(wait.delays).toEqual([]);
  });

  it("never exceeds maxAttemptsPerProvider", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 2, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    // Two attempts on the primary, then two on the fallback: never three.
    expect(http.calls()).toBe(4);
    expect(urls(http)).toEqual([
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_FALLBACK_BASE_URL}/v1/messages`,
      `${TASK5_FALLBACK_BASE_URL}/v1/messages`,
    ]);
    expect(events).toEqual([
      {
        type: "error",
        code: "upstream_unavailable",
        message: "The upstream provider is currently unavailable.",
        retryable: true,
      },
    ]);
    expect(textOf(events)).not.toContain(SCRIPT_OVERRUN_TEXT);
  });

  it("never exceeds maxTotalAttempts", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 5, maxTotalAttempts: 3, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    // The total budget stops the run before the fallback is ever reached.
    expect(http.calls()).toBe(3);
    expect(urls(http)).toEqual([
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
    ]);
    expect(events).toEqual([
      {
        type: "error",
        code: "upstream_unavailable",
        message: "The upstream provider is currently unavailable.",
        retryable: true,
      },
    ]);
    expect(textOf(events)).not.toContain(SCRIPT_OVERRUN_TEXT);
  });

  it("computes the backoff sequence deterministically and caps it", async () => {
    const fixture = candidateFixture({ primary: { id: "primary-main" } });
    const wait = recordingWait();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
    ]);

    await run(
      buildResilient(fixture, http, {
        wait: wait.wait,
        retryPolicy: {
          maxAttemptsPerProvider: 4,
          maxTotalAttempts: 4,
          initialBackoffMs: 100,
          maxBackoffMs: 300,
        },
      }),
      requestFor(fixture),
    );

    expect(wait.delays).toEqual([100, 200, 300]);
    expect(http.calls()).toBe(4);
  });

  it("passes the caller AbortSignal to the injected wait", async () => {
    const fixture = twoProviderFixture();
    const wait = recordingWait();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse(),
    ]);
    const controller = new AbortController();

    await run(
      buildResilient(fixture, http, { wait: wait.wait, retryPolicy: FAST_POLICY }),
      requestFor(fixture),
      controller.signal,
    );

    expect(wait.signals).toEqual([controller.signal]);
  });

  it("rejects an invalid retry policy synchronously with a fixed code", () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([]);

    for (const policy of [
      { maxAttemptsPerProvider: 0 },
      { maxAttemptsPerProvider: -1 },
      { maxAttemptsPerProvider: 1.5 },
      { maxAttemptsPerProvider: Number.NaN },
      { maxTotalAttempts: 0 },
      { maxTotalAttempts: 1.25 },
      { initialBackoffMs: -1 },
      { initialBackoffMs: 1.5 },
      { maxBackoffMs: -3 },
      { initialBackoffMs: 100, maxBackoffMs: 50 },
      { maxAttemptsPerProvider: "2" },
    ]) {
      let caught: unknown;
      try {
        buildResilient(fixture, http, {
          retryPolicy: policy as unknown as Partial<RetryPolicy>,
        });
      } catch (error) {
        caught = error;
      }
      const label = JSON.stringify(policy);
      expect(caught, label).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code, label).toBe(
        "invalid_resilience_options",
      );
      expect((caught as Error).message).not.toContain("maxAttemptsPerProvider");
    }

    // A valid partial policy is accepted and merged with the defaults.
    expect(() =>
      buildResilient(fixture, http, { retryPolicy: { maxTotalAttempts: 3 } }),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Failover across providers
 * ------------------------------------------------------------------ */

describe("task 5 resilience — ordered provider failover", () => {
  it("switches to the fallback once the primary retries are exhausted", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      anthropicSuccessResponse("fallback"),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 2, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(http.calls()).toBe(3);
    expect(urls(http)).toEqual([
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_FALLBACK_BASE_URL}/v1/messages`,
    ]);
    expect(textOf(events)).toBe("fallback");
    expect(events[events.length - 1]).toEqual({ type: "completed" });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  it("fails over after a 429 without retrying first when the policy allows one attempt", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(429),
      anthropicSuccessResponse("fallback"),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(http.calls()).toBe(2);
    expect(urls(http)[1]).toBe(`${TASK5_FALLBACK_BASE_URL}/v1/messages`);
    expect(textOf(events)).toBe("fallback");
  });

  it("follows the configured fallback order", async () => {
    const fixture = candidateFixture({
      primary: { id: "primary-main", baseUrl: "https://p.task5.test/v1" },
      fallbacks: [
        { id: "b-one", baseUrl: "https://one.task5.test/v1" },
        { id: "b-two", baseUrl: "https://two.task5.test/v1" },
      ],
    });
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      anthropicSuccessResponse("last"),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(urls(http)).toEqual([
      "https://p.task5.test/v1/v1/messages",
      "https://one.task5.test/v1/v1/messages",
      "https://two.task5.test/v1/v1/messages",
    ]);
    expect(textOf(events)).toBe("last");
  });

  it("does not touch later providers once one succeeds", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("ok"),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(http.calls()).toBe(2);
    expect(textOf(events)).toBe("ok");
    expect(urls(http)).toEqual([
      `${TASK5_PRIMARY_BASE_URL}/v1/messages`,
      `${TASK5_FALLBACK_BASE_URL}/v1/messages`,
    ]);
  });

  it("never issues overlapping requests", async () => {
    const fixture = twoProviderFixture();
    let inFlight = 0;
    let maxInFlight = 0;
    const http = createScriptedHttpClient([
      () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        inFlight -= 1;
        return transportFailureResponse(503);
      },
      () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        inFlight -= 1;
        return anthropicSuccessResponse("ok");
      },
    ]);

    await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  it("suppresses every intermediate error when a later candidate succeeds", async () => {
    const fixture = candidateFixture({
      primary: { id: "primary-main", baseUrl: "https://p.task5.test/v1" },
      fallbacks: [
        { id: "b-one", baseUrl: "https://one.task5.test/v1" },
        { id: "b-two", baseUrl: "https://two.task5.test/v1" },
      ],
    });
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(429),
      anthropicSuccessResponse("finally"),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(http.calls()).toBe(3);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(textOf(events)).toBe("finally");
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  it("emits exactly one final error with the last retryable code", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(429),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(events).toEqual([
      {
        type: "error",
        code: "rate_limited",
        message: "The upstream provider rate limited this request.",
        retryable: true,
      },
    ]);
  });

  it("stops with the single final error when every candidate is exhausted", async () => {
    const fixture = candidateFixture({
      primary: { id: "primary-main" },
      fallbacks: [{ id: "b-one" }],
    });
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
      transportFailureResponse(503),
    ]);

    const events = await run(
      buildResilient(fixture, http, {
        retryPolicy: { maxAttemptsPerProvider: 2, maxTotalAttempts: 8, ...FAST_POLICY },
      }),
      requestFor(fixture),
    );

    expect(http.calls()).toBe(4);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "upstream_unavailable" });
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("fails over when the primary provider is disabled", async () => {
    const fixture = twoProviderFixture({ primaryEnabled: false });
    const http = createScriptedHttpClient([anthropicSuccessResponse("fallback-only")]);

    const events = await run(buildResilient(fixture, http), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(urls(http)[0]).toBe(`${TASK5_FALLBACK_BASE_URL}/v1/messages`);
    expect(textOf(events)).toBe("fallback-only");
  });
});

/* ------------------------------------------------------------------ *
 * Errors that must never be retried
 * ------------------------------------------------------------------ */

describe("task 5 resilience — non retryable outcomes", () => {
  it("never retries a provider protocol error", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      {
        status: 200,
        body: bytesBody("data: not-a-frame\n\n"),
      },
      anthropicSuccessResponse("should-not-be-used"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events).toEqual([
      {
        type: "error",
        code: "provider_protocol_error",
        message: "The provider stream is outside the supported protocol subset.",
        retryable: false,
      },
    ]);
  });

  it("never retries a client error status", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([transportFailureResponse(401)]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "gateway_error" });
  });

  it("never retries when the credential is missing", async () => {
    const fixture = twoProviderFixture({ primarySecret: null });
    const http = createScriptedHttpClient([anthropicSuccessResponse()]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(0);
    expect(events).toEqual([
      {
        type: "error",
        code: "gateway_error",
        message: "Model gateway request failed.",
        retryable: false,
      },
    ]);
  });

  it("does not fail over on a credential failure", async () => {
    const fixture = twoProviderFixture({ primarySecret: null });
    const http = createScriptedHttpClient([anthropicSuccessResponse()]);

    await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(0);
  });

  it("reports a registry failure once without any HTTP call", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([anthropicSuccessResponse()]);

    const events = await run(
      buildResilient(fixture, http),
      makeRequest({ routeId: "route-nowhere", model: fixture.model }),
    );

    expect(http.calls()).toBe(0);
    expect(events).toEqual([
      {
        type: "error",
        code: "gateway_error",
        message: "Model gateway request failed.",
        retryable: false,
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Once output is visible, no retry and no failover
 * ------------------------------------------------------------------ */

describe("task 5 resilience — visible output blocks retry and failover", () => {
  it("stops retrying after an Anthropic text delta and surfaces that error", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      {
        status: 200,
        body: bytesBody(
          ANTHROPIC_OPEN + anthropicDeltaFrame("first") + ANTHROPIC_OVERLOADED_FRAME,
        ),
      },
      anthropicSuccessResponse("must-not-be-used"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events).toEqual([
      { type: "text_delta", text: "first" },
      {
        type: "error",
        code: "upstream_unavailable",
        message: "The upstream provider is currently unavailable.",
        retryable: true,
      },
    ]);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
  });

  it("stops retrying after an OpenAI text delta", async () => {
    const fixture = twoProviderFixture({ primaryProtocol: "openai_compatible" });
    const http = createScriptedHttpClient([
      {
        status: 200,
        body: bytesBody(OPENAI_TEXT_FRAME + OPENAI_RATE_LIMITED_FRAME),
      },
      openaiSuccessResponse("must-not-be-used"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events[0]).toEqual({ type: "text_delta", text: "first" });
    expect(events[1]).toMatchObject({ type: "error", code: "rate_limited" });
    expect(events).toHaveLength(2);
  });

  it("stops failover after a tool_call has been emitted", async () => {
    const fixture = twoProviderFixture({ primaryProtocol: "openai_compatible" });
    const http = createScriptedHttpClient([
      {
        status: 200,
        body: bytesBody(OPENAI_TOOL_CALL_LEAD + OPENAI_RATE_LIMITED_FRAME),
      },
      openaiSuccessResponse("must-not-be-used"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events[0]).toMatchObject({ type: "tool_call", id: "call_1", name: "alpha" });
    expect(events[1]).toMatchObject({ type: "error", code: "rate_limited" });
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
  });

  it("stops failover after a usage event has been emitted", async () => {
    const fixture = twoProviderFixture({ primaryProtocol: "openai_compatible" });
    const http = createScriptedHttpClient([
      {
        status: 200,
        body: bytesBody(OPENAI_USAGE_LEAD + OPENAI_RATE_LIMITED_FRAME),
      },
      openaiSuccessResponse("must-not-be-used"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events[0]).toEqual({ type: "usage", inputTokens: 3, outputTokens: 4 });
    expect(events[1]).toMatchObject({ type: "error", code: "rate_limited" });
  });

  it("does not re-emit earlier text after a failover", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("second-provider"),
    ]);

    const events = await run(buildResilient(fixture, http, { retryPolicy: FAST_POLICY }), requestFor(fixture));

    expect(textOf(events)).toBe("second-provider");
    expect(textOf(events)).not.toContain("script-overrun");
  });

  it("streams the fallback first delta before the fallback stream ends", async () => {
    const fixture = twoProviderFixture();
    const body = createGatedSource();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      { status: 200, body: body.stream },
    ]);
    const gateway = buildResilient(fixture, http, { retryPolicy: FAST_POLICY });

    const iterator = gateway.stream(requestFor(fixture))[Symbol.asyncIterator]();

    body.push(ANTHROPIC_OPEN);
    body.push(anthropicDeltaFrame("first"));

    const first = await nextEventWithTimeout(iterator);
    expect(first.value).toEqual({ type: "text_delta", text: "first" });
    expect(http.calls()).toBe(2);

    body.push(ANTHROPIC_CLOSE);
    body.close();
    const rest: ModelStreamEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) {
        break;
      }
      rest.push(step.value);
    }
    expect(rest).toEqual([
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed" },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

describe("task 5 resilience — cancellation", () => {
  it("does not resolve candidates, read credentials or call HTTP when pre-cancelled", async () => {
    const fixture = twoProviderFixture();
    let candidateCalls = 0;
    const spiedRegistry = {
      registerProvider: () => undefined,
      updateProvider: () => undefined,
      removeProvider: () => undefined,
      getProvider: () => undefined,
      listProviders: () => [],
      registerRoute: () => undefined,
      updateRoute: () => undefined,
      removeRoute: () => undefined,
      getRoute: () => undefined,
      listRoutes: () => [],
      resolveRoute: () => {
        throw new Error("resolveRoute must not be called");
      },
      resolveRouteCandidates: () => {
        candidateCalls += 1;
        return fixture.registry.resolveRouteCandidates(fixture.routeId);
      },
    };
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
    const http = createScriptedHttpClient([anthropicSuccessResponse()]);
    const gateway = createResilientRoutedHttpModelGateway({
      registry: spiedRegistry,
      credentials,
      httpClient: http.client,
    });

    const controller = new AbortController();
    controller.abort();

    const events = await run(gateway, requestFor(fixture), controller.signal);

    expect(events).toEqual([ABORTED]);
    expect(candidateCalls).toBe(0);
    expect(asked).toEqual([]);
    expect(http.calls()).toBe(0);
  });

  it("ends immediately when cancelled during the backoff wait", async () => {
    const fixture = twoProviderFixture();
    let waitCalls = 0;
    let sawSignal = false;
    const wait: RetryWait = (delayMs, signal) =>
      new Promise<void>((resolve) => {
        waitCalls += 1;
        sawSignal = signal !== undefined;
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });

    const http = createScriptedHttpClient([transportFailureResponse(503)]);
    const gateway = buildResilient(fixture, http, { wait, retryPolicy: FAST_POLICY });
    const controller = new AbortController();

    const events: ModelStreamEvent[] = [];
    const iterator = gateway.stream(requestFor(fixture), controller.signal)[Symbol.asyncIterator]();

    const pending = (async () => {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) {
          break;
        }
        events.push(step.value);
      }
    })();

    await until(() => waitCalls === 1);
    expect(sawSignal).toBe(true);

    controller.abort();
    await pending;

    expect(events).toEqual([ABORTED]);
    expect(http.calls()).toBe(1);
  });

  it("ends with one aborted while the HTTP client is still pending", async () => {
    const fixture = twoProviderFixture();
    let started = false;
    const gateway = createResilientRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: () => {
        started = true;
        return new Promise(() => {
          /* never settles */
        });
      },
    });
    const controller = new AbortController();
    const iterator = gateway.stream(requestFor(fixture), controller.signal)[Symbol.asyncIterator]();

    const first = iterator.next();
    await tickOnce();
    expect(started).toBe(true);

    controller.abort();

    expect((await first).value).toEqual(ABORTED);
    expect((await iterator.next()).done).toBe(true);
  });

  it("ends with one aborted while the response body is still pending", async () => {
    const fixture = twoProviderFixture();
    const body = createGatedSource();
    const http = createScriptedHttpClient([{ status: 200, body: body.stream }]);
    const gateway = buildResilient(fixture, http);
    const controller = new AbortController();
    const iterator = gateway.stream(requestFor(fixture), controller.signal)[Symbol.asyncIterator]();

    const first = iterator.next();
    await tickOnce();
    controller.abort();

    expect((await first).value).toEqual(ABORTED);
    expect((await iterator.next()).done).toBe(true);
    expect(http.calls()).toBe(1);
  });

  it("starts no further provider after cancellation during backoff", async () => {
    const fixture = twoProviderFixture();
    const controller = new AbortController();
    let waitCalls = 0;
    const wait: RetryWait = (_delayMs, signal) =>
      new Promise<void>((resolve) => {
        waitCalls += 1;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    const http = createScriptedHttpClient([transportFailureResponse(503)]);
    const gateway = buildResilient(fixture, http, { wait, retryPolicy: FAST_POLICY });

    const events: ModelStreamEvent[] = [];
    const pending = (async () => {
      for await (const event of gateway.stream(requestFor(fixture), controller.signal)) {
        events.push(event);
      }
    })();

    await until(() => waitCalls === 1);
    controller.abort();
    await pending;

    expect(events).toEqual([ABORTED]);
    expect(http.calls()).toBe(1);
    expect(urls(http)).toEqual([`${TASK5_PRIMARY_BASE_URL}/v1/messages`]);
  });

  it("does not leak an unhandled rejection when a client rejects after abort", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const fixture = twoProviderFixture();
      let rejectLate: ((error: unknown) => void) | undefined;
      const gateway = createResilientRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: () =>
          new Promise((_, reject) => {
            rejectLate = reject;
          }),
      });
      const controller = new AbortController();
      const iterator = gateway.stream(requestFor(fixture), controller.signal)[Symbol.asyncIterator]();

      const first = iterator.next();
      await tickOnce();
      controller.abort();

      expect((await first).value).toEqual(ABORTED);

      rejectLate?.(new Error("late transport failure"));
      await tickOnce();
      await tickOnce();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps concurrent requests independent", async () => {
    const fixture = twoProviderFixture();
    // URL driven on purpose: the two requests interleave, so a positional
    // script would not describe either of them.
    const http = createFakeHttpClient((request) =>
      request.url.startsWith(TASK5_PRIMARY_BASE_URL)
        ? transportFailureResponse(503)
        : anthropicSuccessResponse("isolated"),
    );
    const gateway = buildResilient(fixture, http, {
      retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, ...FAST_POLICY },
    });

    const [first, second] = await Promise.all([
      run(gateway, requestFor(fixture)),
      run(gateway, requestFor(fixture)),
    ]);

    expect(textOf(first)).toBe("isolated");
    expect(textOf(second)).toBe("isolated");
    expect(first.filter((event) => event.type === "error")).toEqual([]);
    expect(second.filter((event) => event.type === "error")).toEqual([]);
    expect(first.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(second.filter((event) => event.type === "completed")).toHaveLength(1);
    // Two attempts per request: one on the failing primary, one on the fallback.
    expect(http.calls()).toBe(4);
  });

  it("keeps the legacy single shot gateway unchanged", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("would-be-used-by-retry"),
    ]);
    const singleShot = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await run(singleShot, requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(events).toEqual([
      {
        type: "error",
        code: "upstream_unavailable",
        message: "The upstream provider is currently unavailable.",
        retryable: true,
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

function tickOnce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits for a condition with a bounded number of macrotasks. */
async function until(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await tickOnce();
  }
  throw new Error("the expected condition was not reached in time");
}

async function nextEventWithTimeout(
  iterator: AsyncIterator<ModelStreamEvent>,
  timeoutMs = 1000,
): Promise<IteratorResult<ModelStreamEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for a resilient event")),
      timeoutMs,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
