import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProviderDiscovery } from "../packages/provider-discovery/src/index.js";
import {
  ANTHROPIC_BASE,
  FIXTURE_SECRET,
  anthropicModelsBody,
  bodyFromText,
  fakeHttpClient,
  makeAnthropicProvider,
  makeCredentialStore,
  makeOpenAIProvider,
  makeRegistry,
  trackingCredentialStore,
  trackingRegistry,
} from "./helpers/provider-discovery-fixtures.js";

const pkgRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "provider-discovery",
);

function forbiddenPatterns(): RegExp[] {
  return [
    /console\.(log|error|warn|info)/,
    /process\.env/,
    /node:fs/,
    /node:http/,
    /node:https/,
    /\bfetch\s*\(/,
    /axios/,
    /undici/,
    /WebSocket/,
    /keytar/,
    /sqlite/,
  ];
}

describe("task 10 security source boundaries", () => {
  it("source files avoid forbidden runtime APIs", () => {
    const files = [
      "src/types.ts",
      "src/errors.ts",
      "src/parse.ts",
      "src/discovery.ts",
      "src/index.ts",
    ];
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, file), "utf8");
      for (const pattern of forbiddenPatterns()) {
        expect(text, `${file} must not match ${String(pattern)}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("package depends only on provider-registry and model-gateway", () => {
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@agent-workbench/model-gateway",
      "@agent-workbench/provider-registry",
    ]);
  });

  it("does not use cross-package src path imports", () => {
    const files = ["src/types.ts", "src/errors.ts", "src/parse.ts", "src/discovery.ts", "src/index.ts"];
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, file), "utf8");
      expect(text).not.toMatch(/\.\.\/\.\.\/(provider-registry|model-gateway|agent-core)\/src/);
    }
  });
});

describe("task 10 security runtime boundaries", () => {
  it("never calls global fetch", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args[0]);
      throw new Error("network disabled");
    }) as typeof fetch;

    try {
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
      });
      await discovery.listModels("anthropic-main");
      await discovery.checkProvider("anthropic-main");
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not write to the credential store", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const inner = await makeCredentialStore();
    const credentialStore = trackingCredentialStore(inner);
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    await discovery.listModels("anthropic-main");
    expect(credentialStore.setCalls).toBe(0);
    expect(credentialStore.deleteCalls).toBe(0);
  });

  it("does not mutate the provider registry", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const tracked = trackingRegistry(registry);
    const before = JSON.stringify(registry.listProviders());
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry: tracked,
      credentialStore,
      httpClient: client,
    });
    await discovery.listModels("anthropic-main");
    expect(tracked.registerCalls).toBe(0);
    expect(tracked.updateCalls).toBe(0);
    expect(JSON.stringify(registry.listProviders())).toBe(before);
  });

  it("does not leak the secret into health results", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const health = await discovery.checkProvider("anthropic-main");
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(FIXTURE_SECRET);
    expect(serialized).not.toContain("credential:anthropic-main");
    expect(serialized).not.toContain(ANTHROPIC_BASE);
    // The secret is only used to build the outbound request header.
    expect(calls[0]?.request.headers["x-api-key"]).toBe(FIXTURE_SECRET);
  });

  it("does not leak the secret into error messages", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(`{"data":[{"id":""}],"note":"${FIXTURE_SECRET}"}`),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    let message = "";
    try {
      await discovery.listModels("anthropic-main");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(FIXTURE_SECRET);
    expect(message).not.toContain(ANTHROPIC_BASE);
    expect(message).not.toMatch(/https?:\/\//);
    expect(message).not.toMatch(/Bearer/i);
    expect(message).not.toMatch(/x-api-key/i);
  });

  it("does not leak providerId, credentialRef or baseUrl in error messages", async () => {
    const registry = await makeRegistry([
      makeAnthropicProvider({ credentialRef: "credential:anthropic-main" }),
    ]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 500,
      body: bodyFromText("boom"),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    let message = "";
    try {
      await discovery.listModels("anthropic-main");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("anthropic-main");
    expect(message).not.toContain("credential:");
    expect(message).not.toContain("api.anthropic.com");
  });

  it("does not put the secret into the URL", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    await discovery.listModels("anthropic-main");
    expect(calls[0]?.request.url).not.toContain(FIXTURE_SECRET);
    expect(calls[0]?.request.url).not.toContain("credential:");
    expect(calls[0]?.request.url).not.toContain("anthropic-main");
  });

  it("does not put providerId or credentialRef into the URL", async () => {
    const registry = await makeRegistry([makeOpenAIProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText("{}"),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    await discovery.checkProvider("openai-main").catch(() => undefined);
    expect(calls[0]?.request.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.request.url).not.toContain("openai-main");
  });

  it("health result has no URL, headers or credential fields", async () => {
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
    });
    const health = await discovery.checkProvider("anthropic-main");
    expect(Object.keys(health).sort()).toEqual([
      "checkedAt",
      "latencyMs",
      "providerId",
      "status",
    ]);
  });
});
