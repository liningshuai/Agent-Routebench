import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { InMemoryProviderRegistry } from "../packages/provider-registry/src/index.js";
import { InMemoryJsonConfigStore } from "../packages/local-persistence/src/index.js";
import { createConfigManager } from "../apps/local-agent-host/src/config-manager.js";
import { createLocalAgentApiServer } from "../packages/local-agent-api/src/index.js";
import type { LocalAgentApiServer } from "../packages/local-agent-api/src/index.js";

const provider = {
  id: "provider-one",
  name: "Provider One",
  protocol: "openai_compatible" as const,
  baseUrl: "https://api.example.invalid/v1",
  credentialRef: "credential:provider-one",
  models: ["model-one"],
  enabled: true,
};

const runner = {
  async run() {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "completed" as const,
          requestId: "turn",
        };
      },
    };
  },
};

let server: LocalAgentApiServer | undefined;

const repoRoot = resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startApi() {
  const registry = new InMemoryProviderRegistry();
  const jsonStore = new InMemoryJsonConfigStore();
  const configManager = createConfigManager({ registry, jsonStore });
  server = createLocalAgentApiServer({
    port: 0,
    runner,
    configManager,
  } as never);
  await server.start();
  return { baseUrl: server.address() as string, configManager };
}

async function json(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

describe("Task 27 rework: Local Agent API configuration endpoints", () => {
  it("wires the configured file through the sidecar into the real config bridge", () => {
    const lib = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
    const sidecar = readRepoFile("apps/desktop/src-tauri/src/sidecar.rs");
    const commands = readRepoFile("apps/desktop/src-tauri/src/commands.rs");
    const host = readRepoFile("apps/local-agent-host/src/host.ts");
    const configuredHost = readRepoFile("apps/local-agent-host/src/configured-host.ts");
    const proxy = readRepoFile("apps/desktop/src-tauri/src/proxy.rs");
    const tauriEntry = readRepoFile("apps/desktop/src/tauri-entry.ts");
    expect(lib).toContain("with_config_path");
    expect(lib).toContain("with_create_config_if_missing(true)");
    expect(lib).toContain("HostRuntime::with_backends");
    expect(sidecar).toContain('.arg("--config")');
    expect(sidecar).toContain('.arg("--create-if-missing")');
    expect(host.match(/configManager: options\.configManager/g)?.length).toBe(2);
    expect(configuredHost).toContain("createConfigManager");
    expect(configuredHost).toContain("configManager,");
    expect(proxy).toContain('"/v1/config"');
    expect(proxy).toContain('"/v1/providers"');
    expect(tauriEntry).toContain("createDesktopConfigClient");
    expect(tauriEntry).toContain("configClient");
    expect(commands).toContain("runtime.config_backend().get_config()");
    expect(commands).toContain("runtime.config_backend().create_provider");
  });

  it("serves a non-sensitive snapshot through GET /v1/config", async () => {
    const { baseUrl, configManager } = await startApi();
    await configManager.createProvider(provider);
    const response = await json(`${baseUrl}/v1/config`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      providers: [provider],
      routes: [],
    });
  });

  it("creates and updates a provider through HTTP", async () => {
    const { baseUrl } = await startApi();
    const created = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      body: JSON.stringify(provider),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    expect((await created.json()).provider).toEqual(provider);

    const updated = await json(`${baseUrl}/v1/providers/provider-one`, {
      method: "PUT",
      body: JSON.stringify({ ...provider, name: "Updated" }),
      headers: { "content-type": "application/json" },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).provider.name).toBe("Updated");
  });

  it("creates and deletes a route through HTTP", async () => {
    const { baseUrl } = await startApi();
    await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      body: JSON.stringify(provider),
      headers: { "content-type": "application/json" },
    });
    const route = {
      id: "route-one",
      name: "Route One",
      providerId: provider.id,
      model: "model-one",
      enabled: true,
    };
    const created = await json(`${baseUrl}/v1/routes`, {
      method: "POST",
      body: JSON.stringify(route),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    expect((await created.json()).route).toEqual(route);

    const deleted = await json(`${baseUrl}/v1/routes/route-one`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
  });

  it("maps registry validation failures to a fixed 400 configuration error", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/routes`, {
      method: "POST",
      body: JSON.stringify({
        id: "route-one",
        name: "Route One",
        providerId: "missing-provider",
        model: "model-one",
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_config_request",
        message: "Configuration request is invalid.",
      },
    });
  });

  it("rejects secrets without touching the configuration manager", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers`, {
      method: "POST",
      body: JSON.stringify({ ...provider, apiKey: "TASK27_SECRET" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_config_request",
        message: "Configuration request is invalid.",
      },
    });
  });

  it("rejects a path/body id mismatch", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers/other-provider`, {
      method: "PUT",
      body: JSON.stringify(provider),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(400);
  });

  it("uses a fixed unavailable response when no manager is wired", async () => {
    server = createLocalAgentApiServer({ port: 0, runner });
    await server.start();
    const response = await json(`${server.address()}/v1/config`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "configuration_unavailable",
        message: "Configuration is unavailable.",
      },
    });
  });

  it("rejects methods not assigned to configuration routes", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/config`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("turns malformed encoded config ids into a fixed 400 response", async () => {
    const { baseUrl } = await startApi();
    const response = await json(`${baseUrl}/v1/providers/%E0%A4%A`, {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_config_request",
        message: "Configuration request is invalid.",
      },
    });
  });
});
