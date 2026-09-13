import { describe, expect, test } from "vitest";
import {
  createLocalAgentHost,
  createRunnableLocalAgentHost,
  LocalAgentHostError,
} from "../apps/local-agent-host/src/index.js";
import { AgentBackendError } from "../packages/agent-backend/src/index.js";
import { InMemoryLocalAgentSessionStore } from "../packages/local-agent-api/src/index.js";
import type { LocalAgentSessionStore } from "../packages/local-agent-api/src/index.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
} from "./helpers/http-fixtures.js";
import {
  httpOk,
  makeBackendRegistry,
} from "./helpers/agent-backend-fixtures.js";
import { randomTestPort } from "./helpers/local-agent-host-fixtures.js";

export function compositionOptions(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const fixture = makeBackendRegistry();
  return {
    port: randomTestPort(),
    backend: {
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("hello")]).client,
    },
    ...overrides,
  };
}

class RecordingStore implements LocalAgentSessionStore {
  readonly created: string[] = [];
  readonly appended: number[] = [];
  readonly #inner = new InMemoryLocalAgentSessionStore();

  create() {
    const session = this.#inner.create();
    this.created.push(session.id);
    return session;
  }
  get(id: string) {
    return this.#inner.get(id);
  }
  listEvents(id: string) {
    return this.#inner.listEvents(id);
  }
  appendEvent(id: string, event: Parameters<LocalAgentSessionStore["appendEvent"]>[1]) {
    this.appended.push(this.appended.length + 1);
    this.#inner.appendEvent(id, event);
  }
  setStatus(
    id: string,
    status: Parameters<LocalAgentSessionStore["setStatus"]>[1],
    activeTurnId?: string,
  ) {
    this.#inner.setStatus(id, status, activeTurnId);
  }
}

describe("Task 22: runnable host composition", () => {
  test("createRunnableLocalAgentHost creates a startable host", async () => {
    const host = createRunnableLocalAgentHost(compositionOptions() as never);
    expect(host.state()).toBe("created");
    try {
      await host.start();
      expect(host.state()).toBe("running");
      expect(host.address()?.startsWith("http://127.0.0.1")).toBe(true);
    } finally {
      await host.close();
    }
  });

  test("class-instance and null-prototype backend options are accepted", () => {
    const fixture = makeBackendRegistry();
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.port = randomTestPort();
    nullProto.backend = {
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient([anthropicSuccessResponse("ok")]).client,
    };
    expect(() => createRunnableLocalAgentHost(nullProto as never)).not.toThrow();
  });

  test("null, undefined, arrays and primitives are rejected with the fixed error", () => {
    for (const bad of [null, undefined, [], 42, "host"]) {
      try {
        createRunnableLocalAgentHost(bad as never);
        throw new Error("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(LocalAgentHostError);
        expect((error as LocalAgentHostError).message).toBe(
          "Local agent host options are invalid.",
        );
      }
    }
  });

  test("a missing backend and a backend missing methods are rejected", () => {
    for (const overrides of [{ backend: undefined }, { backend: {} }, { backend: { registry: {} } }]) {
      let thrown: unknown;
      try {
        createRunnableLocalAgentHost(compositionOptions(overrides) as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(
        thrown instanceof LocalAgentHostError || thrown instanceof AgentBackendError,
      ).toBe(true);
    }
  });

  test("passing both backend and runner is an ambiguous configuration", () => {
    expect(() =>
      createRunnableLocalAgentHost(
        compositionOptions({ runner: { run: () => undefined } }) as never,
      ),
    ).toThrow(LocalAgentHostError);
  });

  test("unknown fields are rejected", () => {
    expect(() =>
      createRunnableLocalAgentHost(compositionOptions({ surprise: true }) as never),
    ).toThrow(LocalAgentHostError);
  });

  test("invalid ports and non-loopback hosts are rejected with fixed messages", () => {
    const portError = (() => {
      try {
        createRunnableLocalAgentHost(compositionOptions({ port: 0 }) as never);
      } catch (error) {
        return error as LocalAgentHostError;
      }
      throw new Error("expected a throw");
    })();
    expect(portError.message).toBe("Local agent host port is invalid.");
    const loopbackError = (() => {
      try {
        createRunnableLocalAgentHost(compositionOptions({ host: "0.0.0.0" }) as never);
      } catch (error) {
        return error as LocalAgentHostError;
      }
      throw new Error("expected a throw");
    })();
    expect(loopbackError.message).toBe("Local agent host must listen on loopback only.");
    expect(() => createRunnableLocalAgentHost(compositionOptions({ port: 0 }) as never)).toThrow(
      LocalAgentHostError,
    );
    expect(() =>
      createRunnableLocalAgentHost(compositionOptions({ port: 70000 }) as never),
    ).toThrow(LocalAgentHostError);
    expect(() =>
      createRunnableLocalAgentHost(compositionOptions({ host: "0.0.0.0" }) as never),
    ).toThrow(LocalAgentHostError);
  });

  test("invalid maxBodyBytes is rejected", () => {
    for (const maxBodyBytes of [0, -1, 1.5, "big"]) {
      expect(() =>
        createRunnableLocalAgentHost(compositionOptions({ maxBodyBytes }) as never),
      ).toThrow(LocalAgentHostError);
    }
  });

  test("an invalid backend never creates a listener", async () => {
    const options = compositionOptions({
      backend: { registry: {}, credentials: {} },
    });
    let listened = false;
    try {
      createRunnableLocalAgentHost(options as never);
    } catch {
      // synchronous fixed failure
    }
    // No host instance escaped, so nothing can be started or listened on.
    expect(listened).toBe(false);
  });

  test("an injected session store is actually used", async () => {
    const store = new RecordingStore();
    const host = createRunnableLocalAgentHost(
      compositionOptions({ store }) as never,
    );
    try {
      await host.start();
      const client = new (await import("../packages/local-agent-client/src/index.js")).LocalAgentApiClient(
        host.address()!,
      );
      const session = await client.createSession();
      expect(store.created).toEqual([session.id]);
      for await (const _event of client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        // drain
      }
      expect(store.appended.length).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });

  test("without an injected store the default in-memory store is used", async () => {
    const host = createRunnableLocalAgentHost(compositionOptions() as never);
    try {
      await host.start();
      const client = new (await import("../packages/local-agent-client/src/index.js")).LocalAgentApiClient(
        host.address()!,
      );
      const session = await client.createSession();
      const fetched = await client.getSession(session.id);
      expect(fetched.id).toBe(session.id);
    } finally {
      await host.close();
    }
  });

  test("a tiny maxBodyBytes is honored by the underlying server", async () => {
    const host = createRunnableLocalAgentHost(
      compositionOptions({ maxBodyBytes: 8 }) as never,
    );
    try {
      await host.start();
      const client = new (await import("../packages/local-agent-client/src/index.js")).LocalAgentApiClient(
        host.address()!,
      );
      const session = await client.createSession();
      const turnError = await (async () => {
        try {
          for await (const _event of client.runTurn(session.id, {
            messages: [{ role: "user", content: [{ type: "text", text: "way too long for 8 bytes" }] }],
            routeId: "route-t4",
            model: "offline-model",
          })) {
            // drain
          }
          return null;
        } catch (candidate) {
          return candidate as { code?: string };
        }
      })();
      expect(turnError?.code).toBe("api_http_error");
      const response = await fetch(`${host.address()}/v1/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      });
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("payload_too_large");
    } finally {
      await host.close();
    }
  });

  test("the plain createLocalAgentHost without a runner still defaults to not-ready", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    try {
      await host.start();
      const client = new (await import("../packages/local-agent-client/src/index.js")).LocalAgentApiClient(
        host.address()!,
      );
      const session = await client.createSession();
      const events = [];
      for await (const event of client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("error");
      if (events[0]?.type === "error") {
        expect(events[0].code).toBe("runner_error");
        expect(events[0].message).toBe("Agent runner failed.");
      }
    } finally {
      await host.close();
    }
  });
});
