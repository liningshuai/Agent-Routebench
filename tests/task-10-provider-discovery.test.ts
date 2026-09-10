import { describe, expect, it } from "vitest";
import { createProviderDiscovery } from "../packages/provider-discovery/src/index.js";
import {
  ANTHROPIC_BASE,
  OPENAI_BASE,
  anthropicModelsBody,
  bodyFromText,
  fakeHttpClient,
  makeCredentialStore,
  makeOpenAIProvider,
  makeAnthropicProvider,
  makeRegistry,
  openaiModelsBody,
  trackingCredentialStore,
} from "./helpers/provider-discovery-fixtures.js";

describe("task 10 provider discovery basics", () => {
  it("rejects null options", () => {
    expect(() =>
      createProviderDiscovery(null as never),
    ).toThrow(/discovery options are invalid/);
  });

  it("rejects array options", () => {
    expect(() =>
      createProviderDiscovery([] as never),
    ).toThrow(/discovery options are invalid/);
  });

  it("rejects primitive options", () => {
    expect(() =>
      createProviderDiscovery("nope" as never),
    ).toThrow(/discovery options are invalid/);
  });

  it("rejects missing registry", async () => {
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    expect(() =>
      createProviderDiscovery({
        credentialStore,
        httpClient: client,
      } as never),
    ).toThrow(/discovery options are invalid/);
  });

  it("accepts class registry, class credential store and plain httpClient", async () => {
    const registry = await makeRegistry();
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    expect(() =>
      createProviderDiscovery({ registry, credentialStore, httpClient: client }),
    ).not.toThrow();
  });

  it("lists Anthropic models from /v1/models", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    const catalog = await discovery.listModels("anthropic-main");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.method).toBe("GET");
    expect(calls[0]?.request.url).toBe(`${ANTHROPIC_BASE}/v1/models`);
    expect(calls[0]?.request.body).toBe("");
    expect(calls[0]?.request.headers["x-api-key"]).toBeDefined();
    expect(calls[0]?.request.headers["anthropic-version"]).toBeDefined();
    expect(calls[0]?.request.headers["authorization"]).toBeUndefined();
    expect(calls[0]?.request.headers["bearer"]).toBeUndefined();
    expect(catalog.providerId).toBe("anthropic-main");
    expect(catalog.protocol).toBe("anthropic_messages");
    expect(catalog.models).toEqual([
      {
        id: "claude-3-5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        createdAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "claude-3-5-haiku",
        displayName: "Claude 3.5 Haiku",
        createdAt: "2025-01-02T00:00:00Z",
      },
    ]);
    expect(typeof catalog.checkedAt).toBe("number");
  });

  it("lists OpenAI models from /models", async () => {
    const registry = await makeRegistry([makeOpenAIProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(openaiModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    const catalog = await discovery.listModels("openai-main");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.method).toBe("GET");
    expect(calls[0]?.request.url).toBe(`${OPENAI_BASE}/models`);
    expect(calls[0]?.request.headers["authorization"]).toBeDefined();
    expect(calls[0]?.request.headers["x-api-key"]).toBeUndefined();
    expect(catalog.protocol).toBe("openai_compatible");
    expect(catalog.models).toEqual([
      { id: "gpt-4o", created: 1710000000, ownedBy: "openai" },
      { id: "gpt-4o-mini", created: 1710000001, ownedBy: "openai" },
    ]);
  });

  it("checks provider health as healthy on 2xx with a valid catalog", async () => {
    let now = 1000;
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
      clock: () => {
        now += 5;
        return now;
      },
    });

    const health = await discovery.checkProvider("anthropic-main");

    expect(health.providerId).toBe("anthropic-main");
    expect(health.status).toBe("healthy");
    expect(health.latencyMs).toBe(5);
    // clock: start=1005, finish=1010; checkedAt is the completion timestamp.
    expect(health.checkedAt).toBe(1010);
    expect(health).not.toHaveProperty("models");
    expect(health).not.toHaveProperty("baseUrl");
    expect(health).not.toHaveProperty("credentialRef");
  });

  it("rejects unknown provider ids", async () => {
    const registry = await makeRegistry();
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await expect(discovery.checkProvider("missing")).rejects.toMatchObject({
      code: "provider_not_found",
    });
    await expect(discovery.listModels("missing")).rejects.toMatchObject({
      code: "provider_not_found",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects empty provider ids", async () => {
    const registry = await makeRegistry();
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await expect(discovery.checkProvider("")).rejects.toMatchObject({
      code: "invalid_provider_id",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects disabled providers without calling HTTP", async () => {
    const registry = await makeRegistry([makeAnthropicProvider({ enabled: false })]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await expect(discovery.checkProvider("anthropic-main")).rejects.toMatchObject({
      code: "provider_disabled",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects missing credentialRef without calling HTTP", async () => {
    const registry = await makeRegistry([makeAnthropicProvider({ credentialRef: null })]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await expect(discovery.checkProvider("anthropic-main")).rejects.toMatchObject({
      code: "missing_credential",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects credentials the store does not hold", async () => {
    const registry = await makeRegistry([
      makeAnthropicProvider({ credentialRef: "credential:absent" }),
    ]);
    const credentialStore = await makeCredentialStore({
      "credential:anthropic-main": "fixture-credential-value",
    });
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await expect(discovery.checkProvider("anthropic-main")).rejects.toMatchObject({
      code: "credential_not_found",
    });
    expect(calls).toHaveLength(0);
  });

  it("calls CredentialStore.get exactly once per invocation", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const inner = await makeCredentialStore();
    const credentialStore = trackingCredentialStore(inner);
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await discovery.checkProvider("anthropic-main");
    expect(credentialStore.getCalls).toEqual(["credential:anthropic-main"]);
    expect(credentialStore.setCalls).toBe(0);
    expect(credentialStore.deleteCalls).toBe(0);
  });

  it("does not put the secret into the catalog result", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    const catalog = await discovery.listModels("anthropic-main");
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("fixture-credential-value");
    expect(serialized).not.toContain("credential:anthropic-main");
    expect(serialized).not.toContain(ANTHROPIC_BASE);
  });

  it("supports an injectable clock for deterministic checkedAt", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
      clock: () => 42,
    });

    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.checkedAt).toBe(42);
  });

  it("does not mutate the registry", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const before = JSON.stringify(registry.listProviders());
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await discovery.listModels("anthropic-main");
    await discovery.checkProvider("anthropic-main");
    expect(JSON.stringify(registry.listProviders())).toBe(before);
  });

  it("returns a defensive copy of the model list", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    const catalog = await discovery.listModels("anthropic-main");
    const first = catalog.models[0] as { id: string };
    first.id = "mutated";
    (catalog.models as unknown as { push: (x: unknown) => void }).push({ id: "extra" });

    const again = await discovery.listModels("anthropic-main");
    expect(again.models[0]?.id).toBe("claude-3-5-sonnet");
    expect(again.models).toHaveLength(2);
  });

  it("accepts a custom baseUrl without duplicated slashes", async () => {
    const registry = await makeRegistry([
      makeAnthropicProvider({
        id: "custom-anthropic",
        baseUrl: "https://proxy.example.com/anthropic/",
        credentialRef: "credential:anthropic-main",
      }),
    ]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({ registry, credentialStore, httpClient: client });

    await discovery.listModels("custom-anthropic");
    expect(calls[0]?.request.url).toBe(
      "https://proxy.example.com/anthropic/v1/models",
    );
  });
});
