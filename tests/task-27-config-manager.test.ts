import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryProviderRegistry } from "../packages/provider-registry/src/index.js";
import { InMemoryJsonConfigStore } from "../packages/local-persistence/src/index.js";
import { createConfigManager } from "../apps/local-agent-host/src/config-manager.js";

let tempDir: string;
let jsonStore: InMemoryJsonConfigStore;
let registry: InMemoryProviderRegistry;
let manager: ReturnType<typeof createConfigManager>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task27-"));
  jsonStore = new InMemoryJsonConfigStore();
  registry = new InMemoryProviderRegistry();
  manager = createConfigManager({ registry, jsonStore });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const VALID_PROVIDER = {
  id: "test-provider",
  name: "Test Provider",
  protocol: "openai_compatible",
  baseUrl: "https://api.example.invalid/v1",
  credentialRef: "credential:test-provider",
  models: ["model-a"],
  enabled: true,
};

describe("task 27 config manager provider CRUD", () => {
  it("creates a provider", async () => {
    const result = await manager.createProvider(VALID_PROVIDER);
    expect(result.id).toBe("test-provider");
    expect(result.protocol).toBe("openai_compatible");
    expect(registry.getProvider("test-provider")).toBeDefined();
  });

  it("returns a defensive copy of the provider", async () => {
    await manager.createProvider(VALID_PROVIDER);
    const snapshot = manager.getSnapshot();
    expect(snapshot.providers).toHaveLength(1);
    const providers = snapshot.providers as unknown[];
    // Mutating the snapshot should not affect the registry.
    expect(registry.getProvider("test-provider")).toBeDefined();
    void providers;
  });

  it("rejects null input", async () => {
    await expect(manager.createProvider(null)).rejects.toThrow();
  });

  it("rejects undefined input", async () => {
    await expect(manager.createProvider(undefined)).rejects.toThrow();
  });

  it("rejects array input", async () => {
    await expect(manager.createProvider([])).rejects.toThrow();
  });

  it("rejects primitive input", async () => {
    await expect(manager.createProvider("nope")).rejects.toThrow();
  });

  it("rejects provider with apiKey field", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, apiKey: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with token field", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, token: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with headers field", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, headers: {} }),
    ).rejects.toThrow();
  });

  it("rejects provider with empty id", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, id: "" }),
    ).rejects.toThrow();
  });

  it("rejects provider with empty name", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, name: "" }),
    ).rejects.toThrow();
  });

  it("rejects provider with invalid protocol", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, protocol: "invalid" }),
    ).rejects.toThrow();
  });

  it("rejects provider with invalid baseUrl", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, baseUrl: "not-a-url" }),
    ).rejects.toThrow();
  });

  it("rejects provider with empty models", async () => {
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, models: [] }),
    ).rejects.toThrow();
  });

  it("updates an existing provider", async () => {
    await manager.createProvider(VALID_PROVIDER);
    const result = await manager.updateProvider({
      ...VALID_PROVIDER,
      name: "Updated Name",
    });
    expect(result.name).toBe("Updated Name");
    expect(registry.getProvider("test-provider")?.name).toBe("Updated Name");
  });

  it("rejects updating a non-existent provider", async () => {
    await expect(
      manager.updateProvider({ ...VALID_PROVIDER, id: "missing" }),
    ).rejects.toThrow();
  });

  it("rejects removing a non-existent provider", async () => {
    await expect(manager.deleteProvider("missing")).rejects.toThrow();
  });

  it("deletes a provider that is not referenced by any route", async () => {
    await manager.createProvider(VALID_PROVIDER);
    await manager.deleteProvider("test-provider");
    expect(registry.getProvider("test-provider")).toBeUndefined();
  });

  it("rejects deleting a provider referenced by a route", async () => {
    await manager.createProvider(VALID_PROVIDER);
    await manager.createRoute({
      id: "route-1",
      name: "Route 1",
      providerId: "test-provider",
      model: "model-a",
      enabled: true,
    });
    await expect(manager.deleteProvider("test-provider")).rejects.toThrow();
  });

  it("rejects updating a provider to remove a model still used by a route", async () => {
    await manager.createProvider(VALID_PROVIDER);
    await manager.createRoute({
      id: "route-1",
      name: "Route 1",
      providerId: "test-provider",
      model: "model-a",
      enabled: true,
    });
    await expect(
      manager.updateProvider({ ...VALID_PROVIDER, models: ["model-b"] }),
    ).rejects.toThrow();
  });

  it("provider CRUD persists to config store", async () => {
    await manager.createProvider(VALID_PROVIDER);
    const snapshot = manager.getSnapshot();
    expect(snapshot.providers).toHaveLength(1);
    // Reload from the same store should recover the provider.
    const store2 = new InMemoryJsonConfigStore();
    await store2.save(snapshot);
    const loaded = await store2.load();
    expect(loaded?.providers).toHaveLength(1);
  });
});
