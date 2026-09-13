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
  models: ["m1"],
  enabled: true,
};

describe("task 27 config concurrency", () => {
  it("serializes concurrent provider creations", async () => {
    const { manager, registry } = makeManager();
    await Promise.all([
      manager.createProvider(VALID_PROVIDER),
      manager.createProvider({ ...VALID_PROVIDER, id: "p2" }),
      manager.createProvider({ ...VALID_PROVIDER, id: "p3" }),
    ]);
    expect(registry.listProviders()).toHaveLength(3);
  });

  it("concurrent update and read are consistent", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await Promise.all([
      manager.updateProvider({ ...VALID_PROVIDER, name: "Updated" }),
      manager.getSnapshot(),
    ]);
    expect(manager.getSnapshot().providers).toHaveLength(1);
  });

  it("two managers on different stores are isolated", async () => {
    const registryA = new InMemoryProviderRegistry();
    const storeA = new InMemoryJsonConfigStore();
    const managerA = createConfigManager({ registry: registryA, jsonStore: storeA });

    const registryB = new InMemoryProviderRegistry();
    const storeB = new InMemoryJsonConfigStore();
    const managerB = createConfigManager({ registry: registryB, jsonStore: storeB });

    await managerA.createProvider(VALID_PROVIDER);
    expect(managerA.getSnapshot().providers).toHaveLength(1);
    expect(managerB.getSnapshot().providers).toHaveLength(0);
  });

  it("save failure rolls back memory state", async () => {
    const registry = new InMemoryProviderRegistry();
    // Use a store that always fails.
    const failingStore = {
      load: async () => undefined,
      save: async () => {
        throw new Error("persistence failure");
      },
    };
    const manager = createConfigManager({ registry, jsonStore: failingStore });

    await expect(manager.createProvider(VALID_PROVIDER)).rejects.toThrow();
    // Memory should be rolled back.
    expect(registry.getProvider("p1")).toBeUndefined();
  });

  it("rollback preserves prior state on update failure", async () => {
    const registry = new InMemoryProviderRegistry();
    const jsonStore = new InMemoryJsonConfigStore();
    const manager = createConfigManager({ registry, jsonStore });
    await manager.createProvider(VALID_PROVIDER);

    // Now swap to a failing store by creating a new manager with same registry
    // but failing store — simulate save failure on update.
    const failingStore = {
      load: async () => undefined,
      save: async () => {
        throw new Error("save failed");
      },
    };
    const failingManager = createConfigManager({ registry, jsonStore: failingStore });
    await expect(
      failingManager.updateProvider({ ...VALID_PROVIDER, name: "Changed" }),
    ).rejects.toThrow();
    // Original state preserved.
    expect(registry.getProvider("p1")?.name).toBe("P1");
  });
});
