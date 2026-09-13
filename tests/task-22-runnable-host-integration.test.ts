import { describe, expect, test } from "vitest";
import { LocalAgentApiClient } from "../packages/local-agent-client/src/index.js";
import { createRunnableLocalAgentHost } from "../apps/local-agent-host/src/index.js";
import {
  anthropicToolUseStream,
  httpOk,
  makeBackendRegistry,
} from "./helpers/agent-backend-fixtures.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
} from "./helpers/http-fixtures.js";

interface Handle {
  readonly port: number;
  readonly client: LocalAgentApiClient;
  readonly close: () => Promise<void>;
}

function composition(overrides: {
  script?: unknown[];
  backendOverrides?: Record<string, unknown>;
  [key: string]: unknown;
} = {}): Record<string, unknown> {
  const { script, backendOverrides, ...rest } = overrides;
  const fixture = makeBackendRegistry(backendOverrides ?? {});
  const scripted = script ?? [anthropicSuccessResponse("hello from backend")];
  return {
    port: 30000 + Math.floor(Math.random() * 30000),
    backend: {
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient(scripted as never).client,
    },
    ...rest,
  };
}

async function startHost(
  options: Record<string, unknown>,
): Promise<Handle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const host = createRunnableLocalAgentHost(options as never);
    try {
      await host.start();
      return {
        port: Number(host.address()!.split(":").pop()),
        client: new LocalAgentApiClient(host.address()!),
        close: () => host.close(),
      };
    } catch (error) {
      lastError = error;
      await host.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("unable to start host");
}

function textOptions(): Record<string, unknown> {
  return composition({ script: [anthropicSuccessResponse("hello from backend")] });
}

describe("Task 22: end-to-end through the runnable host", () => {
  test("health and session creation work through the composition", async () => {
    const handle = await startHost(textOptions());
    try {
      expect(((await handle.client.health()) as { ok?: boolean }).ok).toBe(true);
      const session = await handle.client.createSession();
      expect(session.status).toBe("idle");
    } finally {
      await handle.close();
    }
  });

  test("a text turn streams route_selected, text_delta and exactly one completed", async () => {
    const handle = await startHost(textOptions());
    try {
      const session = await handle.client.createSession();
      const events = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        events.push(event);
      }
      const types = events.map((event) => event.type);
      expect(types[0]).toBe("route_selected");
      expect(types).toContain("text_delta");
      expect(types.filter((type) => type === "completed")).toHaveLength(1);
      expect(types[types.length - 1]).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("a completed turn leaves the session completed", async () => {
    const handle = await startHost(textOptions());
    try {
      const session = await handle.client.createSession();
      for await (const _event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        // drain
      }
      expect((await handle.client.getSession(session.id)).status).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("a provider failure leaves the session failed", async () => {
    const options = composition({
      script: [anthropicSuccessResponse("ok")],
      backendOverrides: { providerEnabled: false },
    });
    const handle = await startHost(options as never);
    try {
      const session = await handle.client.createSession();
      const events = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        events.push(event);
      }
      expect(events[events.length - 1]?.type).toBe("error");
      expect((await handle.client.getSession(session.id)).status).toBe("failed");
    } finally {
      await handle.close();
    }
  });

  test("a tool turn executes the multi-turn loop and emits one final completed", async () => {
    const options = composition({
      script: [
        httpOk(anthropicToolUseStream("call-1", "grep", '{"path":"a.txt"}')),
        anthropicSuccessResponse("done"),
      ],
    });
    const optionsWithExecutor = {
      ...options,
      backend: {
        ...(options.backend as Record<string, unknown>),
        toolExecutor: {
          async execute() {
            return { content: "tool output" };
          },
        },
      },
    };
    const handle = await startHost(optionsWithExecutor as never);
    try {
      const session = await handle.client.createSession();
      const events = [];
      for await (const event of handle.client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "grep", description: "search", inputSchema: { type: "object" } }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        events.push(event);
      }
      const types = events.map((event) => event.type);
      expect(types).toContain("tool_call");
      // The middle model turn's completed never leaked into the API stream.
      expect(types.filter((type) => type === "completed")).toHaveLength(1);
      expect(types[types.length - 1]).toBe("completed");
      expect((await handle.client.getSession(session.id)).status).toBe("completed");
    } finally {
      await handle.close();
    }
  });

  test("two host instances are isolated", async () => {
    const first = await startHost(textOptions());
    const second = await startHost(textOptions());
    try {
      expect(first.port).not.toBe(second.port);
      const firstSession = await first.client.createSession();
      for await (const _event of first.client.runTurn(firstSession.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        // drain
      }
      expect((await first.client.getSession(firstSession.id)).status).toBe("completed");
      const secondSession = await second.client.createSession();
      expect((await second.client.getSession(secondSession.id)).status).toBe("idle");
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("two sessions on one host are isolated", async () => {
    const handle = await startHost(textOptions());
    try {
      const first = await handle.client.createSession();
      const second = await handle.client.createSession();
      for await (const _event of handle.client.runTurn(first.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        // drain
      }
      expect((await handle.client.getSession(first.id)).status).toBe("completed");
      expect((await handle.client.getSession(second.id)).status).toBe("idle");
    } finally {
      await handle.close();
    }
  });

  test("the port stops listening after close and closing again stays safe", async () => {
    const handle = await startHost(textOptions());
    const port = handle.port;
    await handle.close();
    await handle.close();
    const probe = createRunnableLocalAgentHost({ ...textOptions(), port } as never);
    let rebound = false;
    try {
      await probe.start();
      rebound = probe.address()!.includes(`:${String(port)}`);
    } catch {
      rebound = false;
    }
    await probe.close();
    expect(rebound).toBe(true);
  });

  test("a repeated start is still rejected with the fixed error", async () => {
    const handle = await startHost(textOptions());
    try {
      const { createRunnableLocalAgentHost: factory } = await import(
        "../apps/local-agent-host/src/index.js"
      );
      void factory;
      // Re-starting a closed host is a new lifecycle; the fixed-error path is
      // covered by the host-level lifecycle tests. Here we assert the running
      // host rejects a second start through the composition options type.
      const second = createRunnableLocalAgentHost(textOptions() as never);
      await second.start();
      await expect(second.start()).rejects.toMatchObject({
        message: "Local agent host is already started.",
      });
      await second.close();
    } finally {
      await handle.close();
    }
  });
});
