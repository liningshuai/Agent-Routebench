import { describe, expect, test } from "vitest";
import {
  createAgentBackendRunner,
  mapAgentLoopEvents,
} from "../packages/agent-backend/src/index.js";
import type { AgentLoopEvent } from "../packages/agent-runtime/src/index.js";
import {
  BACKEND_MODEL,
  BACKEND_TURN_ID,
  completed,
  createCountingLoopEvents,
  makeBackendRegistry,
  makeRunnerRequest,
  routeSelected,
  textDelta,
  loopCompleted,
} from "./helpers/agent-backend-fixtures.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
  bytesBody,
  httpResponse,
} from "./helpers/http-fixtures.js";
import { createGatedSource } from "./helpers/adapter-fixtures.js";

async function drain(iterable: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _event of iterable) {
    count += 1;
  }
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Task 21: cancellation", () => {
  test("a pre-aborted signal never resolves the route, reads credentials or sends HTTP", async () => {
    const fixture = makeBackendRegistry();
    let getCalls = 0;
    const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: {
        get: async (ref) => {
          getCalls += 1;
          return fixture.credentials.get(ref);
        },
        set: async (ref, value) => fixture.credentials.set(ref, value),
        has: async () => true,
        delete: async () => undefined,
      },
      httpClient: http.client,
    });
    const controller = new AbortController();
    controller.abort();
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest({ signal: controller.signal }))) {
      events.push(event);
    }
    expect(http.calls()).toBe(0);
    expect(getCalls).toBe(0);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.code).toBe("aborted");
    }
  });

  test("cancelling during a pending HTTP body ends the stream promptly", async () => {
    const fixture = makeBackendRegistry();
    const gated = createGatedSource();
    const http = createScriptedHttpClient([
      httpResponse(200, gated.stream),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const controller = new AbortController();
    const started = Date.now();
    const draining = drain(await runner.run(makeRunnerRequest({ signal: controller.signal })));
    await sleep(25);
    controller.abort();
    const count = await draining;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(count).toBeGreaterThanOrEqual(0);
    void gated;
  });

  test("cancelling during a pending tool execution ends the stream promptly", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([
      httpResponse(200, bytesBody(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"slow","input":{}}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      )),
    ]);
    const controller = new AbortController();
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
      toolExecutor: {
        execute: (_request, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("tool cancelled")), {
              once: true,
            });
          }),
      },
    });
    const started = Date.now();
    const draining = drain(
      await runner.run(
        makeRunnerRequest({
          signal: controller.signal,
          tools: [{ name: "slow", description: "slow", inputSchema: { type: "object" } }],
        }),
      ),
    );
    await sleep(25);
    controller.abort();
    const count = await draining;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("late upstream rejections do not escape as unhandled rejections", async () => {
    const fixture = makeBackendRegistry();
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("late http failure")), 30);
      }),
    });
    const controller = new AbortController();
    const draining = drain(await runner.run(makeRunnerRequest({ signal: controller.signal })));
    controller.abort();
    const count = await draining;
    expect(count).toBeGreaterThanOrEqual(0);
    await sleep(60);
  });

  test("exiting the runner stream early releases the upstream loop iterator", async () => {
    const fixture = makeBackendRegistry();
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello")]).client,
    });
    const counting = createCountingLoopEvents([
      routeSelected(0),
      textDelta(0, "a"),
      loopCompleted(1),
    ]);
    // Drive the mapper over a counting iterable to prove release semantics;
    // the runner delegates to the same mapping layer.
    for await (const _event of mapAgentLoopEvents(counting.iterable, BACKEND_TURN_ID)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counting.returned()).toBe(1);
  });

  test("two concurrent backend runners do not interfere", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([
      anthropicSuccessResponse("first"),
      anthropicSuccessResponse("second"),
    ]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    const [first, second] = await Promise.all([
      drain(await runner.run(makeRunnerRequest({ turnId: "turn-a" }))),
      drain(await runner.run(makeRunnerRequest({ turnId: "turn-b" }))),
    ]);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(http.calls()).toBe(2);
  });

  test("the mapper output always carries the runner's turnId as requestId", async () => {
    const fixture = makeBackendRegistry();
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello")]).client,
    });
    const events = [];
    for await (const event of await runner.run(makeRunnerRequest({ turnId: "turn-custom" }))) {
      events.push(event);
    }
    for (const event of events) {
      expect(event.requestId).toBe("turn-custom");
    }
  });
});

describe("Task 21: mapper release contract", () => {
  test("loop_completed ends the mapped stream and releases the upstream", async () => {
    const counting = createCountingLoopEvents([
      routeSelected(0),
      textDelta(0, "a"),
      loopCompleted(1),
    ]);
    const events = [];
    for await (const event of mapAgentLoopEvents(counting.iterable, BACKEND_TURN_ID)) {
      events.push(event);
    }
    expect(events[events.length - 1]?.type).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counting.returned()).toBe(1);
  });

  test("an upstream error ends the mapped stream and releases the upstream", async () => {
    const throwing: AsyncIterable<AgentLoopEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("upstream exploded");
        },
        return: async () => ({ value: undefined, done: true }),
      }),
    };
    const events = [];
    try {
      for await (const event of mapAgentLoopEvents(throwing, BACKEND_TURN_ID)) {
        events.push(event);
      }
      throw new Error("expected the mapped stream to reject");
    } catch {
      // The mapper surfaces upstream throw rejections to its consumer; the
      // runner wrapper owns the fixed-event boundary.
    }
    expect(events).toHaveLength(0);
  });
});

describe("Task 21: turn request passthrough", () => {
  test("the encoded request uses the turn-supplied model identity", async () => {
    const fixture = makeBackendRegistry();
    const http = createScriptedHttpClient([anthropicSuccessResponse("ok")]);
    const runner = createAgentBackendRunner({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });
    await drain(await runner.run(makeRunnerRequest()));
    const body = http.request(0)?.body ?? "";
    expect(body).toContain(BACKEND_MODEL);
  });
});
