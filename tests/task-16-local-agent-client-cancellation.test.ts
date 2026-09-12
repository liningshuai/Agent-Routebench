import { describe, expect, it } from "vitest";
import {
  LocalAgentApiClient,
  LOCAL_AGENT_CLIENT_ERROR_CODES,
} from "../packages/local-agent-client/src/index.js";
import { createLoopbackDesktopApiClient } from "../apps/desktop/src/local-api-client.js";
import {
  completedEvent,
  jsonResponse,
  streamResponse,
  textEvent,
  userRequest,
} from "./helpers/local-agent-client-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("Task 16 Local Agent client cancellation", () => {
  it("cancels a pending fetch without waiting for it to settle", async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async (_url, init) => {
        signal = init?.signal as AbortSignal | undefined;
        return pending.promise;
      },
    );
    const controller = new AbortController();
    const request = client.health(controller.signal);

    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.aborted,
    });
    expect(signal).toBe(controller.signal);
    pending.resolve(jsonResponse({ ok: true }));
  });

  it("consumes a late fetch rejection after cancellation", async () => {
    const pending = deferred<Response>();
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => pending.promise,
    );
    const controller = new AbortController();
    const request = client.health(controller.signal);

    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.aborted,
    });
    pending.reject(new Error("late secret"));
    await Promise.resolve();
  });

  it("releases a late response body after cancellation without reading it", async () => {
    const pending = deferred<Response>();
    let cancelCalls = 0;
    let nextCalls = 0;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => pending.promise,
    );
    const controller = new AbortController();
    const request = client.health(controller.signal);

    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.aborted,
    });

    pending.resolve({
      ok: true,
      status: 200,
      body: {
        cancel() {
          cancelCalls += 1;
          return Promise.resolve();
        },
        getReader() {
          return {
            read() {
              nextCalls += 1;
              return Promise.resolve({ done: true, value: undefined });
            },
            releaseLock() {
              // no-op
            },
          };
        },
      },
    } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelCalls).toBe(1);
    expect(nextCalls).toBe(0);
  });

  it("stops a streaming turn after a pre-aborted signal", async () => {
    let calls = 0;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => {
        calls += 1;
        return streamResponse([completedEvent()]);
      },
    );
    const controller = new AbortController();
    controller.abort();

    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of client.runTurn("s", userRequest(), controller.signal)) {
          events.push(event);
        }
      })(),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.aborted });
    expect(calls).toBe(0);
    expect(events).toEqual([]);
  });

  it("passes cancellation through the Desktop adapter", async () => {
    const signals: AbortSignal[] = [];
    const client = createLoopbackDesktopApiClient({
      baseUrl: "http://127.0.0.1:4317",
      fetch: async (_url, init) => {
        signals.push(init?.signal as AbortSignal);
        return streamResponse([textEvent("ok"), completedEvent()]);
      },
    });
    const controller = new AbortController();
    const events: unknown[] = [];

    for await (const event of client.submitTurn("s", userRequest(), controller.signal)) {
      events.push(event);
    }

    expect(events).toEqual([textEvent("ok"), completedEvent()]);
    expect(signals[0]).toBe(controller.signal);
  });

  it("maps Desktop cancelTurn to the Local Agent cancel endpoint", async () => {
    let url = "";
    const client = createLoopbackDesktopApiClient({
      baseUrl: "http://localhost:4317/",
      fetch: async (requestUrl) => {
        url = requestUrl;
        return jsonResponse({ ok: true });
      },
    });

    await client.cancelTurn("s 1", "turn-1");

    expect(url).toBe("http://localhost:4317/v1/sessions/s%201/cancel");
  });
});
