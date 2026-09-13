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

describe("task 27 config security", () => {
  it("rejects provider with secret field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, secret: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with password field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, password: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with authorization field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, authorization: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with access_token field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, access_token: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with refresh_token field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, refresh_token: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with bearer field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, bearer: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects provider with oauth field", async () => {
    const { manager } = makeManager();
    await expect(
      manager.createProvider({ ...VALID_PROVIDER, oauth: "nope" }),
    ).rejects.toThrow();
  });

  it("rejects route with secret field", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    await expect(
      manager.createRoute({
        id: "r1",
        name: "R",
        providerId: "p1",
        model: "m1",
        enabled: true,
        secret: "nope",
      }),
    ).rejects.toThrow();
  });

  it("error messages do not contain provider id", async () => {
    const { manager } = makeManager();
    let message = "";
    try {
      await manager.createProvider({ ...VALID_PROVIDER, apiKey: "TOP_SECRET_MARKER" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("TOP_SECRET_MARKER");
  });

  it("does not expose credential secret in getSnapshot", async () => {
    const { manager } = makeManager();
    await manager.createProvider(VALID_PROVIDER);
    const snapshot = manager.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain("credential:p1");
  });

  it("rejects null options to createConfigManager", () => {
    expect(() =>
      createConfigManager(null as never),
    ).toThrow();
  });

  it("rejects missing jsonStore", () => {
    expect(() =>
      createConfigManager({ registry: new InMemoryProviderRegistry() } as never),
    ).toThrow();
  });
});
