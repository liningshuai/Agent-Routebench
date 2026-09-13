import { describe, expect, it } from "vitest";
import { InMemoryProviderRegistry } from "../packages/provider-registry/src/index.js";
import { InMemoryJsonConfigStore } from "../packages/local-persistence/src/index.js";
import { createConfigManager } from "../apps/local-agent-host/src/config-manager.js";

function makeManager() {
  const registry = new InMemoryProviderRegistry();
  const jsonStore = new InMemoryJsonConfigStore();
  return { registry, jsonStore, manager: createConfigManager({ registry, jsonStore }) };
}

const VALID_PROVIDER = {
  id: "p1",
  name: "P1",
  protocol: "openai_compatible",
  baseUrl: "https://api.example.invalid/v1",
  credentialRef: "credential:p1",
  models: ["m1", "m2"],
  enabled: true,
};

describe("task 27 config manager route CRUD", () => {
  it("creates a route after provider exists", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    const route = await manager.createRoute({
      id: "r1",
      name: "Route 1",
      providerId: "p1",
      model: "m1",
      enabled: true,
    });
    expect(route.id).toBe("r1");
  });

  it("rejects route referencing non-existent provider", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createRoute({
        id: "r1",
        name: "R",
        providerId: "ghost",
        model: "m1",
        enabled: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects route with model not on provider", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await expect(
      manager.createRoute({
        id: "r1",
        name: "R",
        providerId: "p1",
        model: "missing-model",
        enabled: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects route with unknown fallback provider", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await expect(
      manager.createRoute({
        id: "r1",
        name: "R",
        providerId: "p1",
        model: "m1",
        enabled: true,
        fallbackProviderIds: ["ghost"],
      }),
    ).rejects.toThrow();
  });

  it("rejects route with fallback not providing the model", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await manager.createProvider({
      ...VALID_PROVIDER,
      id: "p2",
      models: ["other"],
    });
    await expect(
      manager.createRoute({
        id: "r1",
        name: "R",
        providerId: "p1",
        model: "m1",
        enabled: true,
        fallbackProviderIds: ["p2"],
      }),
    ).rejects.toThrow();
  });

  it("accepts valid fallback provider", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await manager.createProvider({
      ...VALID_PROVIDER,
      id: "p2",
    });
    const route = await manager.createRoute({
      id: "r1",
      name: "R",
      providerId: "p1",
      model: "m1",
      enabled: true,
      fallbackProviderIds: ["p2"],
    });
    expect(route.fallbackProviderIds).toEqual(["p2"]);
  });

  it("updates a route", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await manager.createRoute({
      id: "r1",
      name: "Old",
      providerId: "p1",
      model: "m1",
      enabled: true,
    });
    const result = await manager.updateRoute({
      id: "r1",
      name: "New",
      providerId: "p1",
      model: "m1",
      enabled: true,
    });
    expect(result.name).toBe("New");
  });

  it("deletes a route", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await manager.createRoute({
      id: "r1",
      name: "R",
      providerId: "p1",
      model: "m1",
      enabled: true,
    });
    await manager.deleteRoute("r1");
    expect(manager.getSnapshot().routes).toHaveLength(0);
  });

  it("rejects deleting a non-existent route", async () => {
    const { manager } = makeManager();
    await expect(manager.deleteRoute("missing")).rejects.toThrow();
  });

  it("getSnapshot returns version 1 with providers and routes", async () => {
    const { manager } = makeManager();
    const snapshot = manager.getSnapshot();
    expect(snapshot.version).toBe(1);
    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(Array.isArray(snapshot.routes)).toBe(true);
  });
});
