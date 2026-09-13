import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { createConfigManager } from "../apps/local-agent-host/src/config-manager.js";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import type { LocalAgentHost } from "../apps/local-agent-host/src/types.js";
import { createLocalAgentApiServer } from "../packages/local-agent-api/src/index.js";
import type { LocalAgentApiServer } from "../packages/local-agent-api/src/index.js";
import {
  InMemoryJsonConfigStore,
} from "../packages/local-persistence/src/index.js";
import { InMemoryProviderRegistry } from "../packages/provider-registry/src/index.js";
import { createDesktopConfigClient } from "../apps/desktop/src/config-client.js";
import type { TauriInvoke } from "../apps/desktop/src/config-client.js";
import {
  createTempConfigDir,
  freeLoopbackPort,
  t28Provider,
  t28Route,
  t28Snapshot,
  writeSnapshot,
  type TempConfig,
} from "./helpers/task-28-fixtures.js";

/* ------------------------------------------------------------------ *
 * Task 28 — configuration management end-to-end closure.
 *
 * The Desktop client is exercised against a *real* local loopback server
 * through an injected Tauri-style `invoke`, so the API, the proxy mapping
 * and the Desktop client are all covered by one behaviour.
 * ------------------------------------------------------------------ */

let apiServer: LocalAgentApiServer | undefined;
let host: LocalAgentHost | undefined;
let temp: TempConfig | undefined;

afterEach(async () => {
  await apiServer?.close();
  apiServer = undefined;
  await host?.close();
  host = undefined;
  await temp?.dispose();
  temp = undefined;
});

const runner = {
  async run() {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "completed" as const, requestId: "turn" };
      },
    };
  },
};

interface StartedApi {
  readonly baseUrl: string;
  readonly manager: ReturnType<typeof createConfigManager>;
  readonly store: InMemoryJsonConfigStore;
  readonly registry: InMemoryProviderRegistry;
}

async function startApi(): Promise<StartedApi> {
  const registry = new InMemoryProviderRegistry();
  const store = new InMemoryJsonConfigStore();
  const manager = createConfigManager({ registry, jsonStore: store });
  apiServer = createLocalAgentApiServer({ port: 0, runner, configManager: manager } as never);
  await apiServer.start();
  return { baseUrl: apiServer.address() as string, manager, store, registry };
}

async function json(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

/**
 * A fake Tauri `invoke` that maps the fixed config commands onto the real
 * loopback Local Agent API, exactly as the Rust native proxy does.
 */
function httpBackedInvoke(baseUrl: string): TauriInvoke {
  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw payload;
    }
    return payload;
  };
  return async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    switch (command) {
      case "agent_get_config":
        return (await request("GET", "/v1/config")) as T;
      case "agent_create_provider":
        return (await request("POST", "/v1/providers", args?.provider)) as T;
      case "agent_update_provider":
        return (await request(
          "PUT",
          `/v1/providers/${String((args?.provider as { id: string }).id)}`,
          args?.provider,
        )) as T;
      case "agent_delete_provider":
        return (await request(
          "DELETE",
          `/v1/providers/${String(args?.providerId)}`,
        )) as T;
      case "agent_create_route":
        return (await request("POST", "/v1/routes", args?.route)) as T;
      case "agent_update_route":
        return (await request(
          "PUT",
          `/v1/routes/${String((args?.route as { id: string }).id)}`,
          args?.route,
        )) as T;
      case "agent_delete_route":
        return (await request("DELETE", `/v1/routes/${String(args?.routeId)}`)) as T;
      default:
        throw new Error("unknown command");
    }
  };
}

function desktopConfigClient(baseUrl: string) {
  return createDesktopConfigClient({
    invoke: httpBackedInvoke(baseUrl),
    listen: async () => () => undefined,
  });
}

describe("Task 28 final config: Desktop → proxy → API → ConfigManager closure", () => {
  it("reads an empty configuration through the Desktop client", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    expect(await client.getConfig()).toEqual({ version: 1, providers: [], routes: [] });
  });

  it("creates, updates and deletes a provider through the Desktop client", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);

    const created = await client.createProvider(t28Provider());
    expect(created).toMatchObject({ id: "provider-t28", enabled: true });

    const updated = await client.updateProvider({ ...t28Provider(), name: "Renamed" });
    expect(updated.name).toBe("Renamed");

    await client.deleteProvider("provider-t28");
    expect((await client.getConfig()).providers).toHaveLength(0);
  });

  it("creates, updates and deletes a route through the Desktop client", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());

    const created = await client.createRoute(t28Route());
    expect(created).toMatchObject({ id: "route-t28", providerId: "provider-t28" });

    const updated = await client.updateRoute({ ...t28Route(), model: "offline-model" });
    expect(updated.model).toBe("offline-model");

    await client.deleteRoute("route-t28");
    expect((await client.getConfig()).routes).toHaveLength(0);
  });

  it("writes every Desktop mutation into the same store the ConfigManager uses", async () => {
    const { baseUrl, store } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());
    await client.createRoute(t28Route());

    const persisted = await store.load();
    expect(persisted?.providers).toHaveLength(1);
    expect(persisted?.routes).toHaveLength(1);
    expect(persisted?.providers[0]?.id).toBe("provider-t28");
  });

  it("keeps the API, proxy and Desktop client response shapes identical", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());

    const rawResponse = await json(`${baseUrl}/v1/config`);
    const raw = (await rawResponse.json()) as unknown;
    const throughProxy = (await httpBackedInvoke(baseUrl)("agent_get_config")) as unknown;
    const throughClient = await client.getConfig();

    expect(throughProxy).toEqual(raw);
    expect(throughClient).toEqual(raw);
  });

  it("rejects a provider delete that a route still references", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());
    await client.createRoute(t28Route());

    await expect(client.deleteProvider("provider-t28")).rejects.toMatchObject({
      code: "config_mutation_failed",
      message: "Failed to save configuration.",
    });
    // Nothing was removed.
    expect((await client.getConfig()).providers).toHaveLength(1);
  });

  it("rejects a route whose fallback provider does not exist", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());

    const response = await json(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28Route({ fallbackProviderIds: ["missing-provider"] })),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_config_request",
        message: "Configuration request is invalid.",
      },
    });
  });

  it("rejects a route model that the provider does not serve", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());

    const response = await json(`${baseUrl}/v1/routes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28Route({ model: "not-served-model" })),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_config_request",
        message: "Configuration request is invalid.",
      },
    });
  });

  it("rejects a duplicate provider id with a fixed error", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());
    const response = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28Provider()),
    });
    expect(response.status).toBe(400);
  });

  it("rejects an unknown provider field with a fixed error", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...t28Provider(), unexpected: true }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects an invalid protocol with a fixed error", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...t28Provider(), protocol: "grpc" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects invalid JSON with the fixed invalid_json error", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_json", message: "Request body is not valid JSON." },
    });
  });

  it("returns the fixed unavailable error when no manager is wired", async () => {
    apiServer = createLocalAgentApiServer({ port: 0, runner });
    await apiServer.start();
    const response = await json(`${apiServer.address()}/v1/config`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "configuration_unavailable",
        message: "Configuration is unavailable.",
      },
    });
  });

  it("rejects methods that are not assigned to a config path", async () => {
    const { baseUrl } = await startApi();
    expect((await json(`${baseUrl}/v1/config`, { method: "DELETE" })).status).toBe(405);
    expect((await json(`${baseUrl}/v1/providers`, { method: "GET" })).status).toBe(405);
    expect((await json(`${baseUrl}/v1/routes`, { method: "DELETE" })).status).toBe(405);
  });
});

describe("Task 28 final config: security and durability", () => {
  it("rejects every secret-bearing field with the same fixed message", async () => {
    const { baseUrl } = await startApi();
    for (const field of [
      "apiKey",
      "token",
      "authorization",
      "headers",
      "password",
      "secret",
      "api_key",
      "credential",
      "endpoint",
      "access_token",
    ]) {
      const response = await json(`${baseUrl}/v1/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...t28Provider(), [field]: "T28_SYNTHETIC_VALUE" }),
      });
      expect(response.status, field).toBe(400);
      const payload = (await response.json()) as { error: { code: string; message: string } };
      expect(payload.error.code, field).toBe("invalid_config_request");
      expect(payload.error.message, field).toBe("Configuration request is invalid.");
      expect(JSON.stringify(payload), field).not.toContain("T28_SYNTHETIC_VALUE");
    }
  });

  it("enforces the configuration request field boundary on providers", async () => {
    const { baseUrl } = await startApi();
    const post = async (body: unknown): Promise<Response> =>
      json(`${baseUrl}/v1/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // A secret field and an unknown field are both refused...
    const secret = await post({ ...t28Provider(), apiKey: "T28_SYNTHETIC_VALUE" });
    const unknown = await post({ ...t28Provider(), unexpected: true });
    expect(secret.status).toBe(400);
    expect(unknown.status).toBe(400);

    // ...with byte-identical fixed payloads, so the error text cannot be used
    // to tell the two guards apart, and neither value is echoed back.
    expect(await secret.json()).toEqual(await unknown.json());
    expect(await post({ ...t28Provider(), apiKey: "T28_SYNTHETIC_VALUE" }).then((r) => r.text()))
      .not.toContain("T28_SYNTHETIC_VALUE");
    expect(await post({ ...t28Provider(), unexpected: true }).then((r) => r.text()))
      .not.toContain("unexpected");

    // Nothing was persisted by either attempt.
    expect((await (await json(`${baseUrl}/v1/config`)).json()) as unknown).toEqual({
      version: 1,
      providers: [],
      routes: [],
    });
  });

  it("enforces the configuration request field boundary on routes", async () => {
    const { baseUrl } = await startApi();
    await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t28Provider()),
    });
    const post = async (body: unknown): Promise<Response> =>
      json(`${baseUrl}/v1/routes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const secret = await post({ ...t28Route(), authorization: "T28_SYNTHETIC_VALUE" });
    const unknown = await post({ ...t28Route(), unexpected: true });
    const transport = await post({ ...t28Route(), baseUrl: "https://api.evil.invalid" });
    for (const response of [secret, unknown, transport]) {
      expect(response.status).toBe(400);
    }
    expect(await secret.json()).toEqual(await unknown.json());
    expect((await (await json(`${baseUrl}/v1/config`)).json()) as { routes: unknown[] }).toMatchObject({
      routes: [],
    });
  });

  it("never echoes a rejected value, path or exception in a config error", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...t28Provider(), baseUrl: "not-a-url" }),
    });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toContain("not-a-url");
    expect(text).not.toContain("Error");
    expect(text).not.toContain("stack");
    expect(text).not.toContain("/v1/");
    expect(text).not.toContain("http");
  });

  it("turns a malformed percent-encoded config id into a fixed 400", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers/%E0%A4%A`, { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_config_request",
        message: "Configuration request is invalid.",
      },
    });
  });

  it("never returns secret fields in a configuration snapshot", async () => {
    const { baseUrl } = await startApi();
    const client = desktopConfigClient(baseUrl);
    await client.createProvider(t28Provider());
    const snapshot = await client.getConfig();
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "apiKey",
      "api_key",
      "token",
      "authorization",
      "headers",
      "password",
      "secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("credential:t28");
  });

  it("rolls the in-memory registry back when persistence fails", async () => {
    const registry = new InMemoryProviderRegistry();
    const failingStore = {
      async load() {
        return undefined;
      },
      async save(): Promise<void> {
        throw new Error("disk is full");
      },
    };
    const manager = createConfigManager({ registry, jsonStore: failingStore });

    await expect(manager.createProvider(t28Provider())).rejects.toMatchObject({
      code: "config_persistence_failed",
    });
    expect(manager.getSnapshot()).toEqual({ version: 1, providers: [], routes: [] });
    expect(registry.listProviders()).toHaveLength(0);
  });

  it("rolls a failed update back to the previous provider value", async () => {
    const registry = new InMemoryProviderRegistry();
    const store = new InMemoryJsonConfigStore();
    const manager = createConfigManager({ registry, jsonStore: store });
    await manager.createProvider(t28Provider());

    let failNext = false;
    const flaky = {
      load: () => store.load(),
      save: async (snapshot: unknown): Promise<void> => {
        if (failNext) {
          throw new Error("write failed");
        }
        await store.save(snapshot);
      },
    };
    const flakyManager = createConfigManager({ registry, jsonStore: flaky });
    failNext = true;
    await expect(
      flakyManager.updateProvider({ ...t28Provider(), name: "ShouldNotStick" }),
    ).rejects.toMatchObject({ code: "config_persistence_failed" });
    expect(registry.getProvider("provider-t28")?.name).toBe("Provider T28");
  });

  it("persists only the non-sensitive reference to disk", async () => {
    temp = await createTempConfigDir();
    await writeSnapshot(temp.filePath, t28Snapshot());
    const port = await freeLoopbackPort();
    host = await createConfiguredLocalAgentHost({ port, configFilePath: temp.filePath });
    const client = desktopConfigClient(host.address() as string);
    await client.createProvider(
      t28Provider({ id: "provider-two", credentialRef: "credential:provider-two" }),
    );

    const onDisk = await readFile(temp.filePath, "utf8");
    expect(onDisk).toContain("credential:provider-two");
    expect(onDisk).not.toContain("apiKey");
    expect(onDisk).not.toContain("authorization");
    expect(onDisk).not.toContain("headers");
    expect(onDisk).not.toContain("password");
  });

  it("creates an empty first-run config only when explicitly allowed", async () => {
    temp = await createTempConfigDir();
    const port = await freeLoopbackPort();
    host = await createConfiguredLocalAgentHost({
      port,
      configFilePath: temp.filePath,
      createIfMissing: true,
    });
    expect(await readFile(temp.filePath, "utf8")).toContain('"version": 1');
    const client = desktopConfigClient(host.address() as string);
    expect(await client.getConfig()).toEqual({ version: 1, providers: [], routes: [] });
  });

  it("reloads a first-run config from a fresh process", async () => {
    temp = await createTempConfigDir();
    const firstPort = await freeLoopbackPort();
    const first = await createConfiguredLocalAgentHost({
      port: firstPort,
      configFilePath: temp.filePath,
      createIfMissing: true,
    });
    const client = desktopConfigClient(first.address() as string);
    await client.createProvider(t28Provider());
    await client.createRoute(t28Route());
    await first.close();

    const secondPort = await freeLoopbackPort();
    host = await createConfiguredLocalAgentHost({
      port: secondPort,
      configFilePath: temp.filePath,
    });
    const reloaded = await desktopConfigClient(host.address() as string).getConfig();
    expect(reloaded.providers).toHaveLength(1);
    expect(reloaded.routes).toHaveLength(1);
    expect(reloaded.routes[0]?.providerId).toBe("provider-t28");
  });
});
