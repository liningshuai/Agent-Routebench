import { describe, expect, test } from "vitest";
import { createAgentBackendRunner } from "../packages/agent-backend/src/index.js";
import type { AgentLoopEvent } from "../packages/agent-runtime/src/index.js";
import { createRunnableLocalAgentHost } from "../apps/local-agent-host/src/index.js";
import { mapAgentLoopEvents } from "../packages/agent-backend/src/index.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
} from "./helpers/http-fixtures.js";
import { createGatedSource } from "./helpers/adapter-fixtures.js";
import { httpResponse } from "./helpers/http-fixtures.js";
import {
  completed,
  createCountingLoopEvents,
  makeBackendRegistry,
  makeRunnerRequest,
  routeSelected,
  textDelta,
  loopCompleted,
} from "./helpers/agent-backend-fixtures.js";
import { createStartedRunnableHost } from "./helpers/local-agent-host-fixtures.js";

function composition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture = makeBackendRegistry();
  return {
    port: 30000 + Math.floor(Math.random() * 30000),
    backend: {
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello")]).client,
    },
    ...overrides,
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _item of iterable) {
    count += 1;
  }
  return count;
}

describe("Task 22: cancellation and release through the composition", () => {
  test("a pre-aborted client signal never resolves the route or reads credentials", async () => {
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
    expect(events[events.length - 1]?.type).toBe("error");
  });

  test("cancelling a gated body ends the composed host turn promptly", async () => {
    const fixture = makeBackendRegistry();
    const gated = createGatedSource();
    const started = await createStartedRunnableHost({
      backend: {
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: createScriptedHttpClient([httpResponse(200, gated.stream)]).client,
      },
      port: undefined,
    } as never);
    const { host } = started;
    const { LocalAgentApiClient } = await import("../packages/local-agent-client/src/index.js");
    try {
      const client = new LocalAgentApiClient(host.address()!);
      const session = await client.createSession();
      const controller = new AbortController();
      const started = Date.now();
      const draining = (async () => {
        try {
          for await (const _event of client.runTurn(
            session.id,
            {
              messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
              routeId: "route-t4",
              model: "offline-model",
            },
            controller.signal,
          )) {
            // drain
          }
        } catch {
          // abort can surface as a client error
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 60));
      controller.abort();
      await draining;
      expect(Date.now() - started).toBeLessThan(3000);
      // Poll for the session terminal status to land.
      let status = (await client.getSession(session.id)).status;
      for (let attempt = 0; attempt < 20 && status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = (await client.getSession(session.id)).status;
      }
      expect(["cancelled", "failed"]).toContain(status);
    } finally {
      await started.dispose();
    }
  });

  test("closing the host releases the mapped upstream iterator", async () => {
    const counting = createCountingLoopEvents([
      routeSelected(0),
      textDelta(0, "a"),
      completed(0),
      loopCompleted(1),
    ]);
    const events = [];
    for await (const event of mapAgentLoopEvents(counting.iterable, "turn-1")) {
      events.push(event);
      if (events.length === 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counting.returned()).toBe(1);
  });

  test("the mapped stream never leaks runtime-only events", async () => {
    const runtimeEvents: AgentLoopEvent[] = [
      routeSelected(0),
      textDelta(0, "a"),
      completed(0),
      loopCompleted(1),
    ];
    const events = [];
    for await (const event of mapAgentLoopEvents(
      (async function* () {
        for (const runtimeEvent of runtimeEvents) {
          yield runtimeEvent;
        }
      })(),
      "turn-1",
    )) {
      events.push(event);
    }
    for (const event of events) {
      expect(["route_selected", "text_delta", "usage", "tool_call", "completed", "error"]).toContain(
        event.type,
      );
    }
  });
});
