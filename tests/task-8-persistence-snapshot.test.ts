import { describe, expect, it } from "vitest";
import {
  InMemoryProviderRegistry,
  type ProviderDefinition,
  type RouteDefinition,
} from "../packages/provider-registry/src/index.js";
import {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  createConfigSnapshot,
  createRegistryFromSnapshot,
  validateConfigSnapshot,
  type PersistedConfigV1,
} from "../packages/local-persistence/src/index.js";

const ANTHROPIC_URL = "https://api.anthropic.com";
const OPENAI_URL = "https://api.openai.com";

function makeProvider(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "anthropic-main",
    name: "Anthropic Main",
    protocol: "anthropic_messages",
    baseUrl: ANTHROPIC_URL,
    credentialRef: "credential:anthropic-main",
    models: ["claude-3-5-sonnet", "claude-3-5-haiku"],
    enabled: true,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "default-route",
    name: "Default Route",
    providerId: "anthropic-main",
    model: "claude-3-5-sonnet",
    enabled: true,
    ...overrides,
  };
}

function captureError(run: () => unknown): PersistenceError {
  try {
    run();
  } catch (error) {
    if (error instanceof PersistenceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected PersistenceError");
}

function baseRegistry(): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  registry.registerProvider(makeProvider());
  registry.registerRoute(makeRoute());
  return registry;
}

describe("task 8 snapshot", () => {
  it("creates an empty snapshot from an empty registry", () => {
    const snapshot = createConfigSnapshot(new InMemoryProviderRegistry());
    expect(snapshot.version).toBe(1);
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.routes).toEqual([]);
  });

  it("captures provider fields", () => {
    const snapshot = createConfigSnapshot(baseRegistry());
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]).toEqual({
      id: "anthropic-main",
      name: "Anthropic Main",
      protocol: "anthropic_messages",
      baseUrl: ANTHROPIC_URL,
      credentialRef: "credential:anthropic-main",
      models: ["claude-3-5-sonnet", "claude-3-5-haiku"],
      enabled: true,
    });
  });

  it("captures route fields", () => {
    const snapshot = createConfigSnapshot(baseRegistry());
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]).toEqual({
      id: "default-route",
      name: "Default Route",
      providerId: "anthropic-main",
      model: "claude-3-5-sonnet",
      enabled: true,
    });
  });

  it("captures fallbackProviderIds", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());
    registry.registerProvider(
      makeProvider({
        id: "openai-backup",
        name: "OpenAI Backup",
        protocol: "openai_compatible",
        baseUrl: OPENAI_URL,
        credentialRef: null,
        models: ["claude-3-5-sonnet", "gpt-4o"],
      }),
    );
    registry.registerRoute(
      makeRoute({ fallbackProviderIds: ["openai-backup"] }),
    );

    const snapshot = createConfigSnapshot(registry);
    expect(snapshot.routes[0]?.fallbackProviderIds).toEqual(["openai-backup"]);
  });

  it("keeps credentialRef and never stores a secret value", () => {
    const snapshot = createConfigSnapshot(baseRegistry());
    expect(snapshot.providers[0]?.credentialRef).toBe("credential:anthropic-main");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("TASK8_SYNTHETIC_SECRET");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Authorization");
  });

  it("returns a deep copy so caller mutation does not affect the registry", () => {
    const registry = baseRegistry();
    const snapshot = createConfigSnapshot(registry);

    (snapshot.providers[0] as unknown as { name: string }).name = "mutated";
    (snapshot.providers[0] as unknown as { models: string[] }).models.push(
      "evil-model",
    );

    const stored = registry.getProvider("anthropic-main");
    expect(stored?.name).toBe("Anthropic Main");
    expect(stored?.models).not.toContain("evil-model");
  });

  it("sorts providers by id for stable output", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider({ id: "zeta-provider" }));
    registry.registerProvider(
      makeProvider({ id: "alpha-provider", baseUrl: OPENAI_URL, protocol: "openai_compatible" }),
    );
    registry.registerProvider(
      makeProvider({ id: "mid-provider", baseUrl: "https://mid.example.com", protocol: "openai_compatible" }),
    );

    const snapshot = createConfigSnapshot(registry);
    expect(snapshot.providers.map((p) => p.id)).toEqual([
      "alpha-provider",
      "mid-provider",
      "zeta-provider",
    ]);
  });

  it("sorts routes by id for stable output", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider({ models: ["m1", "m2", "m3"] }));
    registry.registerRoute(makeRoute({ id: "z-route", model: "m1" }));
    registry.registerRoute(makeRoute({ id: "a-route", model: "m2" }));

    const snapshot = createConfigSnapshot(registry);
    expect(snapshot.routes.map((r) => r.id)).toEqual(["a-route", "z-route"]);
  });

  it("rejects invalid version", () => {
    const error = captureError(() =>
      validateConfigSnapshot({ version: 2, providers: [], routes: [] }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.unsupportedConfigVersion);
  });

  it("rejects missing version", () => {
    const error = captureError(() =>
      validateConfigSnapshot({ providers: [], routes: [] }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.unsupportedConfigVersion);
  });

  it("rejects missing providers array", () => {
    const error = captureError(() =>
      validateConfigSnapshot({ version: 1, routes: [] }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedConfig);
  });

  it("rejects missing routes array", () => {
    const error = captureError(() =>
      validateConfigSnapshot({ version: 1, providers: [] }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedConfig);
  });

  it("rejects unknown root fields", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [],
        routes: [],
        credentials: { secret: "nope" },
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects unknown provider fields", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [{ ...makeProvider(), apiKey: "sk-evil" }],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects unknown route fields", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [{ ...makeRoute(), endpoint: "https://evil.example.com" }],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects duplicate provider ids", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider(), makeProvider()],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.duplicatePersistedProvider);
  });

  it("rejects duplicate route ids", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute(), makeRoute()],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.duplicatePersistedRoute);
  });

  it("rejects a route whose provider is unknown", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute({ providerId: "ghost-provider" })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedProviderNotFound);
  });

  it("rejects a route whose model is not on the provider", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute({ model: "not-a-model" })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedModelNotAvailable);
  });

  it("rejects a fallback provider that is unknown", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute({ fallbackProviderIds: ["ghost-backup"] })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedProviderNotFound);
  });

  it("rejects a fallback provider that does not serve the model", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [
          makeProvider(),
          makeProvider({
            id: "other-provider",
            baseUrl: OPENAI_URL,
            protocol: "openai_compatible",
            models: ["other-model"],
          }),
        ],
        routes: [makeRoute({ fallbackProviderIds: ["other-provider"] })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedModelNotAvailable);
  });

  it("rejects an enabled route on a disabled provider", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider({ enabled: false })],
        routes: [makeRoute({ enabled: true })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedProvider);
  });

  it("accepts a disabled route on a disabled provider", () => {
    const snapshot = validateConfigSnapshot({
      version: 1,
      providers: [makeProvider({ enabled: false })],
      routes: [makeRoute({ enabled: false })],
    });
    expect(snapshot.providers[0]?.enabled).toBe(false);
    expect(snapshot.routes[0]?.enabled).toBe(false);
  });

  it("rejects non-JSON values such as undefined", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [{ ...makeProvider(), name: undefined }],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedProvider);
  });

  it("rejects non-finite numbers", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [],
        extra: Number.POSITIVE_INFINITY,
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects circular objects", () => {
    const cyclic: Record<string, unknown> = {
      version: 1,
      providers: [],
      routes: [],
    };
    cyclic.self = cyclic;

    const error = captureError(() => validateConfigSnapshot(cyclic));
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("does not mutate the caller supplied snapshot", () => {
    const input = {
      version: 1,
      providers: [makeProvider()],
      routes: [makeRoute()],
    };
    const clone = structuredClone(input);
    const result = validateConfigSnapshot(input);
    expect(input).toEqual(clone);
    (result.providers[0] as { name: string }).name = "changed";
    expect(input.providers[0]?.name).toBe("Anthropic Main");
  });

  it("rejects credential value masquerading as credentialRef", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [
          makeProvider({
            credentialRef: "credential:test-provider-secret-value",
          }),
        ],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedProvider);
  });

  it("restores a registry from a valid snapshot", () => {
    const original = baseRegistry();
    const snapshot = createConfigSnapshot(original);
    const restored = createRegistryFromSnapshot(snapshot);

    expect(restored.getProvider("anthropic-main")?.baseUrl).toBe(ANTHROPIC_URL);
    expect(restored.getRoute("default-route")?.model).toBe("claude-3-5-sonnet");
  });

  it("restores fallbacks so they resolve", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());
    registry.registerProvider(
      makeProvider({
        id: "openai-backup",
        name: "OpenAI Backup",
        protocol: "openai_compatible",
        baseUrl: OPENAI_URL,
        credentialRef: null,
        models: ["claude-3-5-sonnet", "gpt-4o"],
      }),
    );
    registry.registerRoute(
      makeRoute({ fallbackProviderIds: ["openai-backup"] }),
    );

    const restored = createRegistryFromSnapshot(createConfigSnapshot(registry));
    const candidates = restored.resolveRouteCandidates("default-route");
    expect(candidates.map((c) => c.providerId)).toEqual([
      "anthropic-main",
      "openai-backup",
    ]);
  });

  it("isolates the restored registry from later snapshot mutation", () => {
    const snapshot = createConfigSnapshot(baseRegistry());
    const restored = createRegistryFromSnapshot(snapshot);
    (snapshot.providers[0] as { baseUrl: string }).baseUrl = "https://evil.example.com";

    expect(restored.getProvider("anthropic-main")?.baseUrl).toBe(ANTHROPIC_URL);
  });

  it("isolates the snapshot from later registry mutation", () => {
    const original = baseRegistry();
    const snapshot = createConfigSnapshot(original);
    const restored = createRegistryFromSnapshot(snapshot);
    restored.updateProvider(
      makeProvider({ name: "Changed After Restore" }),
    );

    expect(snapshot.providers[0]?.name).toBe("Anthropic Main");
  });

  it("does not return a partial registry when restore fails", () => {
    const error = captureError(() =>
      createRegistryFromSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute({ providerId: "ghost" })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedProviderNotFound);
  });

  it("does not return a partial registry when a route is invalid", () => {
    const error = captureError(() =>
      createRegistryFromSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute({ model: "missing-model" })],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedModelNotAvailable);
  });

  it("returns an empty registry for empty providers and routes", () => {
    const restored = createRegistryFromSnapshot({
      version: 1,
      providers: [],
      routes: [],
    });
    expect(restored.listProviders()).toEqual([]);
    expect(restored.listRoutes()).toEqual([]);
  });

  it("round trips a validated snapshot without changing shape", () => {
    const snapshot = createConfigSnapshot(baseRegistry());
    const validated = validateConfigSnapshot(snapshot);
    expect(validated).toEqual(snapshot);
  });

  it("replaces a registry-backed snapshot through validate without touching CredentialStore", () => {
    const snapshot = createConfigSnapshot(baseRegistry()) as PersistedConfigV1;
    const validated = validateConfigSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(validated.providers[0]?.credentialRef).toBe("credential:anthropic-main");
    expect(JSON.stringify(validated)).not.toContain("TASK8_SYNTHETIC_SECRET");
  });
});
