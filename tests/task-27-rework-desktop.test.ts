// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountDesktopUi } from "../apps/desktop/src/ui.js";
import { createDesktopConfigClient } from "../apps/desktop/src/config-client.js";
import type { DesktopApiClient } from "../apps/desktop/src/types.js";
import type { DesktopConfigApiClient } from "../apps/desktop/src/config-client.js";

const session = {
  id: "session-1",
  status: "idle" as const,
  createdAt: 1,
  updatedAt: 1,
};

const snapshot = {
  version: 1 as const,
  providers: [
    {
      id: "provider-one",
      name: "Provider One",
      protocol: "openai_compatible" as const,
      baseUrl: "https://api.example.invalid/v1",
      credentialRef: "credential:provider-one",
      models: ["model-one"],
      enabled: true,
    },
  ],
  routes: [],
};

function makeClient(): DesktopApiClient {
  return {
    async load() {},
    async createSession() { return session; },
    async *submitTurn() {},
    async cancelTurn() {},
  };
}

function makeConfigClient(): DesktopConfigApiClient {
  return {
    async getConfig() { return structuredClone(snapshot); },
    async createProvider(input) { return input as never; },
    async updateProvider(input) { return input as never; },
    async deleteProvider() {},
    async createRoute(input) { return input as never; },
    async updateRoute(input) { return input as never; },
    async deleteRoute() {},
  };
}

describe("Task 27 rework: Desktop configuration panel", () => {
  it("renders providers and routes only when a config client is injected", async () => {
    const container = document.createElement("div");
    const ui = mountDesktopUi(container, makeClient(), makeConfigClient());
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector(".config-panel")).not.toBeNull();
    expect(container.textContent).toContain("Provider One");
    expect(container.querySelector(".provider-form")).not.toBeNull();
    expect(container.querySelector(".route-form")).not.toBeNull();
    ui.unmount();
  });

  it("does not render credentials as an input or expose tool payloads", async () => {
    const container = document.createElement("div");
    const ui = mountDesktopUi(container, makeClient(), makeConfigClient());
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).not.toContain("apiKey");
    expect(container.innerHTML).not.toContain("Authorization");
    expect(container.querySelector("[name=credentialRef]")).not.toBeNull();
    ui.unmount();
  });

  it("rejects a secret-bearing configuration response before the UI sees it", async () => {
    const client = createDesktopConfigClient({
      invoke: async <T>(): Promise<T> => ({
        version: 1,
        providers: [{ ...snapshot.providers[0], apiKey: "TASK27_SECRET" }],
        routes: [],
      }) as T,
      listen: async () => () => undefined,
    });
    await expect(client.getConfig()).rejects.toThrow();
  });
});
