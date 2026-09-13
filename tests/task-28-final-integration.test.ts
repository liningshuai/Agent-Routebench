import { afterEach, describe, expect, it } from "vitest";

import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import type { ConfiguredLocalAgentHostOptions } from "../apps/local-agent-host/src/configured-host.js";
import type { LocalAgentHost } from "../apps/local-agent-host/src/types.js";
import {
  bytesBody,
  createFakeHttpClient,
  httpResponse,
  transportFailureResponse,
  anthropicDeltaFrame,
  anthropicSuccessResponse,
  type FakeHttpClient,
} from "./helpers/http-fixtures.js";
import { anthropicToolUseStream } from "./helpers/agent-backend-fixtures.js";
import {
  T28_BASE_URL,
  T28_CREDENTIAL_REF,
  T28_FALLBACK_BASE_URL,
  T28_FALLBACK_PROVIDER_ID,
  T28_FALLBACK_SECRET,
  T28_MODEL,
  T28_PROVIDER_ID,
  T28_ROUTE_ID,
  T28_SECRET,
  createRecordingCredentialBackend,
  createSession,
  createTempConfigDir,
  eventTypes,
  freeLoopbackPort,
  runTurn,
  t28Provider,
  t28Route,
  t28Snapshot,
  t28TurnBody,
  writeSnapshot,
  type RecordingCredentialBackend,
  type TempConfig,
} from "./helpers/task-28-fixtures.js";

/* ------------------------------------------------------------------ *
 * Task 28 — final end-to-end integration.
 *
 * Every scenario runs the real chain:
 *
 *   Configured Host → Local Agent API → Agent Backend → Route Resolution
 *     → CredentialStore.get() → Routed HTTP Gateway → Agent Runtime
 *     → NDJSON events → HTTP client
 *
 * Only the provider HTTP client and the credential backend are injected
 * fakes; no real provider, network or credential is ever touched.
 * ------------------------------------------------------------------ */

const READ_FILE_TOOL = {
  name: "read_file",
  description: "Reads a local file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

/**
 * A provider body that emits one visible text frame and then never finishes,
 * so a turn stays in flight until it is explicitly cancelled.
 */
function hangingBody(): AsyncIterable<Uint8Array> {
  const prefix =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    anthropicDeltaFrame("in-flight");
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(prefix);
      await new Promise<void>(() => undefined);
    },
  };
}

interface Harness {
  readonly baseUrl: string;
  readonly host: LocalAgentHost;
  readonly credentials: RecordingCredentialBackend;
  readonly http: FakeHttpClient;
}

let host: LocalAgentHost | undefined;
let temp: TempConfig | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await temp?.dispose();
  temp = undefined;
});

/** Boots a real configured host on a real loopback port. */
async function boot(
  options: {
    readonly snapshot?: ReturnType<typeof t28Snapshot>;
    readonly respond?: (
      request: { url: string; body: string; headers: Record<string, string> },
      index: number,
    ) => ReturnType<Parameters<typeof createFakeHttpClient>[0]>;
    readonly backendExtras?: Partial<ConfiguredLocalAgentHostOptions>;
    readonly secrets?: Record<string, string>;
  } = {},
): Promise<Harness> {
  temp = await createTempConfigDir();
  await writeSnapshot(temp.filePath, options.snapshot ?? t28Snapshot());
  const credentials = createRecordingCredentialBackend(
    options.secrets ?? {
      [T28_CREDENTIAL_REF]: T28_SECRET,
      [`credential:${T28_FALLBACK_PROVIDER_ID}`]: T28_FALLBACK_SECRET,
    },
  );
  const http = createFakeHttpClient((request, index) =>
    options.respond === undefined
      ? anthropicSuccessResponse("hello")
      : options.respond(request, index),
  );
  const port = await freeLoopbackPort();
  host = await createConfiguredLocalAgentHost({
    port,
    configFilePath: temp.filePath,
    credentials: credentials.store(),
    httpClient: http.client,
    ...(options.backendExtras ?? {}),
  });
  return { baseUrl: host.address() as string, host, credentials, http };
}

describe("Task 28 final integration: configured host end-to-end", () => {
  it("streams a text answer through the whole chain as NDJSON", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(result.status).toBe(200);
    expect(result.turnId).not.toBeNull();
    expect(eventTypes(result.events)).toEqual([
      "route_selected",
      "text_delta",
      "usage",
      "completed",
    ]);
    const text = result.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toBe("hello");
  });

  it("sends the request to the configured provider URL with the stored secret", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(harness.http.calls()).toBe(1);
    const request = harness.http.request(0);
    expect(request.url.startsWith(T28_BASE_URL)).toBe(true);
    expect(request.headers["x-api-key"]).toBe(T28_SECRET);
  });

  it("reads the credential only when a turn actually runs", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    expect(harness.credentials.gets()).toBe(0);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(harness.credentials.gets()).toBe(1);
  });

  it("never resolves a route before the turn is submitted", async () => {
    const harness = await boot();
    await createSession(harness.baseUrl);
    expect(harness.http.calls()).toBe(0);
    expect(harness.credentials.calls().length).toBe(0);
  });

  it("exposes the same events through the session events endpoint", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    const listed = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/events`);
    const payload = (await listed.json()) as { events: unknown[] };
    expect(payload.events.length).toBe(result.events.length);
  });

  it("surfaces a non-retryable provider failure as one fixed error event", async () => {
    const harness = await boot({
      respond: () => httpResponse(401, bytesBody("upstream-body-must-not-leak")),
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    // Agent Core always announces the requested route first; the failure
    // itself is exactly one fixed terminal error event.
    expect(eventTypes(result.events)).toEqual(["route_selected", "error"]);
    expect(result.events[1]).toEqual({
      type: "error",
      requestId: result.turnId,
      code: "gateway_error",
      message: "Model gateway request failed.",
      retryable: false,
    });
    expect(result.raw).not.toContain("upstream-body-must-not-leak");
    expect(harness.http.calls()).toBe(1);
  });

  it("retries a retryable provider failure once and streams a single answer", async () => {
    const harness = await boot({
      respond: (_request, index) =>
        index === 0 ? transportFailureResponse(503) : anthropicSuccessResponse("after-retry"),
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(harness.http.calls()).toBe(2);
    expect(eventTypes(result.events).filter((type) => type === "completed")).toHaveLength(1);
    const text = result.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toBe("after-retry");
  });

  it("fails over to the ordered fallback provider with the fallback credential", async () => {
    const harness = await boot({
      snapshot: t28Snapshot(
        [
          t28Provider(),
          t28Provider({
            id: T28_FALLBACK_PROVIDER_ID,
            baseUrl: T28_FALLBACK_BASE_URL,
            credentialRef: `credential:${T28_FALLBACK_PROVIDER_ID}`,
          }),
        ],
        [t28Route({ fallbackProviderIds: [T28_FALLBACK_PROVIDER_ID] })],
      ),
      respond: (request) =>
        request.url.startsWith(T28_FALLBACK_BASE_URL)
          ? anthropicSuccessResponse("from-fallback")
          : transportFailureResponse(503),
      backendExtras: { retryPolicy: { maxAttemptsPerProvider: 1 } },
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(harness.http.calls()).toBe(2);
    expect(harness.http.request(0).url.startsWith(T28_BASE_URL)).toBe(true);
    expect(harness.http.request(1).url.startsWith(T28_FALLBACK_BASE_URL)).toBe(true);
    expect(harness.http.request(1).headers["x-api-key"]).toBe(T28_FALLBACK_SECRET);
    const text = result.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toBe("from-fallback");
  });

  it("never retries once a visible event has already been emitted", async () => {
    const partialThenError = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      anthropicDeltaFrame("partial"),
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
    ].join("");
    const harness = await boot({
      respond: () => httpResponse(200, bytesBody(partialThenError)),
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(harness.http.calls()).toBe(1);
    expect(eventTypes(result.events)).toEqual(["route_selected", "text_delta", "error"]);
  });

  it("runs a multi-turn tool call and emits exactly one final completed", async () => {
    const harness = await boot({
      respond: (_request, index) =>
        index === 0
          ? httpResponse(200, bytesBody(anthropicToolUseStream("call-1", "read_file", '{"path":"a.txt"}')))
          : anthropicSuccessResponse("tool-done"),
      backendExtras: {
        toolExecutor: { async execute() { return { content: "file-body", isError: false }; } },
        policy: { decide: () => "allow" as const },
      },
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(
      harness.baseUrl,
      sessionId,
      t28TurnBody({ tools: [READ_FILE_TOOL] }),
    );

    expect(harness.http.calls()).toBe(2);
    expect(eventTypes(result.events)).toEqual([
      "route_selected",
      "tool_call",
      "usage",
      "route_selected",
      "text_delta",
      "usage",
      "completed",
    ]);
    expect(eventTypes(result.events).filter((type) => type === "completed")).toHaveLength(1);
    // The second request must carry the tool result of the first turn.
    expect(harness.http.request(1).body).toContain("call-1");
    expect(harness.http.request(1).body).toContain("file-body");
  });

  it("never leaks an intermediate completed event from a middle turn", async () => {
    const harness = await boot({
      respond: (_request, index) =>
        index === 0
          ? httpResponse(200, bytesBody(anthropicToolUseStream("call-1", "read_file", '{"path":"a.txt"}')))
          : anthropicSuccessResponse("done"),
      backendExtras: {
        toolExecutor: { async execute() { return { content: "file-body", isError: false }; } },
        policy: { decide: () => "allow" as const },
      },
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(
      harness.baseUrl,
      sessionId,
      t28TurnBody({ tools: [READ_FILE_TOOL] }),
    );
    const completed = result.events.filter((event) => event.type === "completed");
    expect(completed).toHaveLength(1);
    expect(result.events[result.events.length - 1]?.type).toBe("completed");
  });

  it("denies a tool when the policy denies it and reports a fixed result", async () => {
    const executed: string[] = [];
    const harness = await boot({
      respond: (_request, index) =>
        index === 0
          ? httpResponse(200, bytesBody(anthropicToolUseStream("call-1", "read_file", '{"path":"a.txt"}')))
          : anthropicSuccessResponse("done"),
      backendExtras: {
        toolExecutor: {
          async execute() {
            executed.push("ran");
            return { content: "file-body", isError: false };
          },
        },
        policy: { decide: () => "deny" as const },
      },
    });
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody({ tools: [READ_FILE_TOOL] }));

    expect(executed).toHaveLength(0);
    expect(harness.http.request(1).body).toContain("Tool execution was denied.");
  });

  it("fails closed when a tool call arrives without any policy", async () => {
    const executed: string[] = [];
    const harness = await boot({
      respond: (_request, index) =>
        index === 0
          ? httpResponse(200, bytesBody(anthropicToolUseStream("call-1", "read_file", '{"path":"a.txt"}')))
          : anthropicSuccessResponse("done"),
      backendExtras: {
        toolExecutor: {
          async execute() {
            executed.push("ran");
            return { content: "file-body", isError: false };
          },
        },
      },
    });
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody({ tools: [READ_FILE_TOOL] }));

    expect(executed).toHaveLength(0);
    expect(harness.http.request(1).body).toContain("Tool execution was denied.");
  });

  it("asks for approval and only executes after an explicit approval", async () => {
    const executed: string[] = [];
    let asked = 0;
    const harness = await boot({
      respond: (_request, index) =>
        index === 0
          ? httpResponse(200, bytesBody(anthropicToolUseStream("call-1", "read_file", '{"path":"a.txt"}')))
          : anthropicSuccessResponse("done"),
      backendExtras: {
        toolExecutor: {
          async execute() {
            executed.push("ran");
            return { content: "file-body", isError: false };
          },
        },
        policy: { decide: () => "ask" as const },
        approvalHandler: {
          async requestApproval() {
            asked += 1;
            return "approved" as const;
          },
        },
      },
    });
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody({ tools: [READ_FILE_TOOL] }));

    expect(asked).toBe(1);
    expect(executed).toHaveLength(1);
    expect(harness.http.request(1).body).toContain("file-body");
  });

  it("does not execute when the approval is refused", async () => {
    const executed: string[] = [];
    const harness = await boot({
      respond: (_request, index) =>
        index === 0
          ? httpResponse(200, bytesBody(anthropicToolUseStream("call-1", "read_file", '{"path":"a.txt"}')))
          : anthropicSuccessResponse("done"),
      backendExtras: {
        toolExecutor: {
          async execute() {
            executed.push("ran");
            return { content: "file-body", isError: false };
          },
        },
        policy: { decide: () => "ask" as const },
        approvalHandler: { async requestApproval() { return "denied" as const; } },
      },
    });
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody({ tools: [READ_FILE_TOOL] }));

    expect(executed).toHaveLength(0);
    expect(harness.http.request(1).body).toContain("Tool execution was denied.");
  });

  it("cancels a running turn, reports aborted once and starts no further round", async () => {
    const harness = await boot({ respond: () => httpResponse(200, hangingBody()) });
    const sessionId = await createSession(harness.baseUrl);
    const pending = fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28TurnBody()),
    }).catch(() => undefined);

    // Wait until the provider request is in flight, then cancel.
    for (let index = 0; index < 400 && harness.http.calls() === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.http.calls()).toBe(1);
    const cancelResponse = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/cancel`, {
      method: "POST",
    });
    expect(cancelResponse.status).toBe(200);
    await pending;

    // No second provider round is ever started after a cancellation.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.http.calls()).toBe(1);

    const session = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}`);
    const payload = (await session.json()) as { session: { status: string } };
    expect(payload.session.status).toBe("cancelled");
  });

  it("reports a cancelled turn as exactly one fixed aborted error event", async () => {
    const harness = await boot({ respond: () => httpResponse(200, hangingBody()) });
    const sessionId = await createSession(harness.baseUrl);
    const pending = fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28TurnBody()),
    });
    for (let index = 0; index < 400 && harness.http.calls() === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/cancel`, { method: "POST" });
    const response = await pending;
    const raw = await response.text();
    const events = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; code?: string });
    const terminal = events.filter(
      (event) => event.type === "completed" || event.type === "error",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "error", code: "aborted" });
  });

  it("keeps secrets, provider URLs, credential refs and raw bodies out of the event stream", async () => {
    const harness = await boot({
      respond: () => transportFailureResponse(503),
      backendExtras: { retryPolicy: { maxAttemptsPerProvider: 1 } },
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    for (const forbidden of [
      T28_SECRET,
      T28_CREDENTIAL_REF,
      T28_BASE_URL,
      "t4-body-secret",
      "TASK5_SYNTHETIC_SECRET_VALUE",
      "x-api-key",
      "Bearer",
    ]) {
      expect(result.raw).not.toContain(forbidden);
    }
  });

  it("reports an unknown route as a fixed error without contacting any provider", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(
      harness.baseUrl,
      sessionId,
      t28TurnBody({ routeId: "route-does-not-exist" }),
    );

    expect(eventTypes(result.events)).toEqual(["route_selected", "error"]);
    expect(result.events[1]).toMatchObject({
      type: "error",
      code: "gateway_error",
      message: "Model gateway request failed.",
    });
    expect(harness.http.calls()).toBe(0);
    expect(harness.credentials.gets()).toBe(0);
  });

  it("reports a missing credential as a fixed error without contacting any provider", async () => {
    const harness = await boot({
      snapshot: t28Snapshot([t28Provider()], [t28Route()]),
      secrets: {},
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(harness.http.calls()).toBe(0);
    expect(eventTypes(result.events)).toEqual(["route_selected", "error"]);
    expect(result.events[1]).toMatchObject({
      type: "error",
      code: "gateway_error",
      message: "Model gateway request failed.",
    });
  });

  it("streams an OpenAI-compatible provider through the same chain", async () => {
    const harness = await boot({
      snapshot: t28Snapshot(
        [t28Provider({ protocol: "openai_compatible", baseUrl: "https://api.t28-openai.test/v1" })],
        [t28Route()],
      ),
      respond: () =>
        httpResponse(
          200,
          bytesBody(
            [
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
              `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":"openai-hello"},"finish_reason":null}]}\n\n`,
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\n',
              "data: [DONE]\n\n",
            ].join(""),
          ),
        ),
    });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    const text = result.events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toBe("openai-hello");
    expect(harness.http.request(0).headers["authorization"]).toBe(`Bearer ${T28_SECRET}`);
    expect(result.raw).not.toContain(T28_SECRET);
  });

  it("rejects a turn whose model does not match the resolved route", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(
      harness.baseUrl,
      sessionId,
      t28TurnBody({ model: "some-other-model" }),
    );

    expect(harness.http.calls()).toBe(0);
    expect(eventTypes(result.events)).toEqual(["route_selected", "error"]);
    expect(result.events[1]).toMatchObject({ type: "error", code: "gateway_error" });
  });

  it("releases the per-session turn slot once a turn completes", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const first = await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(first.events.at(-1)?.type).toBe("completed");

    // The session is no longer busy: a second turn must be accepted.
    const second = await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(second.status).toBe(200);
    expect(second.events.at(-1)?.type).toBe("completed");
    expect(harness.http.calls()).toBe(2);
  });

  it("releases the per-session turn slot after a cancellation", async () => {
    const harness = await boot({ respond: () => httpResponse(200, hangingBody()) });
    const sessionId = await createSession(harness.baseUrl);
    const pending = fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28TurnBody()),
    });
    for (let index = 0; index < 400 && harness.http.calls() === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/cancel`, { method: "POST" });
    await pending;

    // A cancelled turn must not leave the session permanently busy.
    const again = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/cancel`, {
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      ok: true,
      code: "not_running",
      message: "No turn is running.",
    });
  });

  it("keeps two concurrent sessions fully isolated", async () => {
    const harness = await boot();
    const first = await createSession(harness.baseUrl);
    const second = await createSession(harness.baseUrl);
    expect(first).not.toBe(second);

    const [a, b] = await Promise.all([
      runTurn(harness.baseUrl, first, t28TurnBody()),
      runTurn(harness.baseUrl, second, t28TurnBody()),
    ]);
    expect(a.turnId).not.toBe(b.turnId);
    expect(a.events.at(-1)?.type).toBe("completed");
    expect(b.events.at(-1)?.type).toBe("completed");
    expect(harness.http.calls()).toBe(2);
  });

  it("refuses a second concurrent turn on the same session", async () => {
    const harness = await boot({ respond: () => httpResponse(200, hangingBody()) });
    const sessionId = await createSession(harness.baseUrl);
    const first = fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28TurnBody()),
    });
    for (let index = 0; index < 200 && harness.http.calls() === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28TurnBody()),
    });
    expect(second.status).toBe(409);
    await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/cancel`, { method: "POST" });
    await first;
  });
});
