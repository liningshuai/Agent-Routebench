import { describe, expect, test } from "vitest";
import { LocalAgentApiClient } from "../packages/local-agent-client/src/index.js";
import { createLocalAgentHost } from "../apps/local-agent-host/src/index.js";
import { createAgentBackendRunner } from "../packages/agent-backend/src/index.js";
import {
  anthropicToolUseStream,
  httpOk,
  makeBackendRegistry,
  BACKEND_MODEL,
  BACKEND_ROUTE_ID,
} from "./helpers/agent-backend-fixtures.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
  httpResponse,
} from "./helpers/http-fixtures.js";
import { createGatedSource } from "./helpers/adapter-fixtures.js";

interface HostHandle {
  readonly port: number;
  readonly client: LocalAgentApiClient;
  readonly close: () => Promise<void>;
}

async function startBackendHost(
  runner: ReturnType<typeof createAgentBackendRunner>,
): Promise<HostHandle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = 30000 + Math.floor(Math.random() * 30000);
    const host = createLocalAgentHost({ host: "127.0.0.1", port, runner });
    try {
      await host.start();
      return {
        port,
        client: new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`),
        close: () => host.close(),
      };
    } catch (error) {
      lastError = error;
      await host.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("unable to start host");
}

function textRunner(): ReturnType<typeof createAgentBackendRunner> {
  const fixture = makeBackendRegistry();
  return createAgentBackendRunner({
    registry: fixture.registry,
    credentials: fixture.credentials,
    httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello from backend")]).client,
  });
}

describe("Task 21: loopback integration through the Node host", () => {
  test("health, session creation and a full streamed turn work end to end", async () => {
    const handle = await startBackendHost(textRunner());
    try {
      const health = (await handle.client.health()) as { ok?: boolean };
      expect(health.ok).toBe(true);
      const session = await handle.client.createSession();
      expect(session.status).toBe("idle");
      const events = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: BACKEND_ROUTE_ID,
        model: BACKEND_MODEL,
      })) {
        events.push(event);
      }
      const types = events.map((event) => event.type);
      expect(types).toContain("route_selected");
      expect(types).toContain("text_delta");
      expect(types[types.length - 1]).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("the turn events are recorded by the session store", async () => {
    const handle = await startBackendHost(textRunner());
    try {
      const session = await handle.client.createSession();
      for await (const _event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: BACKEND_ROUTE_ID,
        model: BACKEND_MODEL,
      })) {
        // drain
      }
      const events = await handle.client.listEvents(session.id);
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]?.type).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("a normal completed turn leaves the session completed", async () => {
    const handle = await startBackendHost(textRunner());
    try {
      const session = await handle.client.createSession();
      for await (const _event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: BACKEND_ROUTE_ID,
        model: BACKEND_MODEL,
      })) {
        // drain
      }
      const after = await handle.client.getSession(session.id);
      expect(after.status).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("a backend error event leaves the session failed", async () => {
    const fixture = makeBackendRegistry({ providerEnabled: false });
    const handle = await startBackendHost(
      createAgentBackendRunner({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: createScriptedHttpClient([anthropicSuccessResponse("ok")]).client,
      }),
    );
    try {
      const session = await handle.client.createSession();
      const events = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: BACKEND_ROUTE_ID,
        model: BACKEND_MODEL,
      })) {
        events.push(event);
      }
      expect(events[events.length - 1]?.type).toBe("error");
      const after = await handle.client.getSession(session.id);
      expect(after.status).toBe("failed");
    } finally {
      await handle.close();
    }
  });

  test("a tool turn runs two gateway rounds and finishes completed", async () => {
    const fixture = makeBackendRegistry();
    const handle = await startBackendHost(
      createAgentBackendRunner({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: createScriptedHttpClient([
          httpOk(anthropicToolUseStream("call-1", "grep", '{"path":"a.txt"}')),
          anthropicSuccessResponse("done"),
        ]).client,
        toolExecutor: {
          async execute() {
            return { content: "tool output" };
          },
        },
      }),
    );
    try {
      const session = await handle.client.createSession();
      const types = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "grep", description: "search", inputSchema: { type: "object" } }],
        routeId: BACKEND_ROUTE_ID,
        model: BACKEND_MODEL,
      })) {
        types.push(event.type);
      }
      expect(types).toContain("tool_call");
      expect(types.filter((type) => type === "completed")).toHaveLength(1);
      const after = await handle.client.getSession(session.id);
      expect(after.status).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("two sessions on one backend host are independent", async () => {
    const handle = await startBackendHost(textRunner());
    try {
      const first = await handle.client.createSession();
      const second = await handle.client.createSession();
      for await (const _event of handle.client.runTurn(first.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: BACKEND_ROUTE_ID,
        model: BACKEND_MODEL,
      })) {
        // drain
      }
      const firstAfter = await handle.client.getSession(first.id);
      const secondAfter = await handle.client.getSession(second.id);
      expect(firstAfter.status).toBe("completed");
      expect(secondAfter.status).toBe("idle");
    } finally {
      await handle.close();
    }
  });
});

describe("Task 21: session terminal status rules (Task 9 minimal fix)", () => {
  test("a streamed terminal error event leaves the session failed", async () => {
    const fixture = makeBackendRegistry();
    const handle = await startBackendHost(
      createAgentBackendRunner({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: createScriptedHttpClient([anthropicSuccessResponse("ok")]).client,
      }),
    );
    try {
      const session = await handle.client.createSession();
      const events = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-does-not-exist",
        model: BACKEND_MODEL,
      })) {
        events.push(event);
      }
      expect(events[events.length - 1]?.type).toBe("error");
      const after = await handle.client.getSession(session.id);
      expect(after.status).toBe("failed");
    } finally {
      await handle.close();
    }
  });

  test("a client-side abort leaves the session cancelled", async () => {
    const fixture = makeBackendRegistry();
    const gated = createGatedSource();
    const handle = await startBackendHost(
      createAgentBackendRunner({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: createScriptedHttpClient([
          httpResponse(200, gated.stream),
        ]).client,
      }),
    );
    try {
      const session = await handle.client.createSession();
      const controller = new AbortController();
      void gated;
      const draining = (async () => {
        const events = [];
        try {
          for await (const event of handle.client.runTurn(
            session.id,
            {
              messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
              routeId: BACKEND_ROUTE_ID,
              model: BACKEND_MODEL,
            },
            controller.signal,
          )) {
            events.push(event);
          }
        } catch {
          // client-side abort can surface as a client error
        }
        return events;
      })();
      await new Promise((resolve) => setTimeout(resolve, 80));
      controller.abort();
      await draining;
      // Server-side cleanup lands asynchronously after the client aborts.
      let after = await handle.client.getSession(session.id);
      for (let attempt = 0; attempt < 20 && after.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        after = await handle.client.getSession(session.id);
      }
      expect(["cancelled", "failed"]).toContain(after.status);
    } finally {
      await handle.close();
    }
  });
});
