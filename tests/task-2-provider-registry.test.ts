import { describe, expect, it } from "vitest";
import {
  InMemoryProviderRegistry,
  PROVIDER_REGISTRY_ERROR_CODES,
  ProviderRegistryError,
  getOfficialProviderPresets,
  type ProviderDefinition,
  type RouteDefinition,
} from "../packages/provider-registry/src/index.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function makeProvider(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "anthropic-main",
    name: "Anthropic Main",
    protocol: "anthropic_messages",
    baseUrl: ANTHROPIC_BASE_URL,
    credentialRef: null,
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

function captureError(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectErrorCode(run: () => unknown, code: string): void {
  const error = captureError(run);
  expect(error, `expected an error with code "${code}"`).toBeInstanceOf(
    ProviderRegistryError,
  );
  expect((error as ProviderRegistryError).code).toBe(code);
}

function readyRegistry(): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  registry.registerProvider(makeProvider());
  return registry;
}

describe("task 2 provider registry — stable error codes", () => {
  it("declares every required stable error code", () => {
    const required = [
      "invalid_provider_id",
      "duplicate_provider_id",
      "provider_not_found",
      "provider_disabled",
      "invalid_provider_name",
      "invalid_provider_protocol",
      "invalid_provider_url",
      "invalid_credential_ref",
      "invalid_provider_models",
      "forbidden_provider_field",
      "invalid_route_id",
      "duplicate_route_id",
      "route_not_found",
      "route_disabled",
      "invalid_route_name",
      "invalid_route_model",
      "forbidden_route_field",
      "provider_has_routes",
      "model_not_available",
      "invalid_registry_snapshot",
    ];

    const declared: ReadonlySet<string> = new Set(
      Object.values(PROVIDER_REGISTRY_ERROR_CODES),
    );
    for (const code of required) {
      expect(declared.has(code), `missing error code ${code}`).toBe(true);
    }
  });
});

describe("task 2 provider registry — provider lifecycle", () => {
  it("registers a provider and reads it back", () => {
    const registry = new InMemoryProviderRegistry();
    const provider = makeProvider();

    registry.registerProvider(provider);

    expect(registry.getProvider("anthropic-main")).toEqual(provider);
    expect(registry.listProviders()).toEqual([provider]);
  });

  it("rejects a duplicate provider id without overwriting the original", () => {
    const registry = readyRegistry();

    expectErrorCode(
      () => registry.registerProvider(makeProvider({ name: "Impostor" })),
      "duplicate_provider_id",
    );
    expect(registry.getProvider("anthropic-main")?.name).toBe("Anthropic Main");
    expect(registry.listProviders()).toHaveLength(1);
  });

  it("rejects an invalid provider id", () => {
    const registry = new InMemoryProviderRegistry();

    for (const id of ["Anthropic Main", "1leading", "", "Uppercase", "has space"]) {
      expectErrorCode(
        () => registry.registerProvider(makeProvider({ id })),
        "invalid_provider_id",
      );
    }
    expect(registry.listProviders()).toHaveLength(0);
  });

  it("rejects an invalid provider name", () => {
    const registry = new InMemoryProviderRegistry();

    for (const name of ["", "   ", " padded ", "trailing\t"]) {
      expectErrorCode(
        () => registry.registerProvider(makeProvider({ name })),
        "invalid_provider_name",
      );
    }
  });

  it("rejects an unsupported protocol", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ protocol: "grpc" as unknown as ProviderDefinition["protocol"] }),
        ),
      "invalid_provider_protocol",
    );
    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({
            protocol: "anthropic" as unknown as ProviderDefinition["protocol"],
          }),
        ),
      "invalid_provider_protocol",
    );
  });

  it("rejects an invalid base url", () => {
    const registry = new InMemoryProviderRegistry();

    for (const baseUrl of [
      "not a url",
      "/v1",
      "ftp://api.anthropic.com",
      "api.anthropic.com",
      "",
    ]) {
      expectErrorCode(
        () => registry.registerProvider(makeProvider({ baseUrl })),
        "invalid_provider_url",
      );
    }
  });

  it("rejects a base url with query or hash", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ baseUrl: "https://api.anthropic.com/v1?api_key=x" }),
        ),
      "invalid_provider_url",
    );
    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ baseUrl: "https://api.anthropic.com/v1#fragment" }),
        ),
      "invalid_provider_url",
    );
  });

  it("rejects a base url with a username or password", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ baseUrl: "https://user@api.anthropic.com" }),
        ),
      "invalid_provider_url",
    );
    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ baseUrl: "https://user:pass@api.anthropic.com/v1" }),
        ),
      "invalid_provider_url",
    );
  });

  it("rejects a base url containing whitespace", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ baseUrl: "https://api.anthropic.com /v1" }),
        ),
      "invalid_provider_url",
    );
  });

  it("accepts a local http base url and keeps its path", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(
      makeProvider({
        id: "local-openai",
        protocol: "openai_compatible",
        baseUrl: "http://127.0.0.1:1234/v1",
        models: ["local-model"],
      }),
    );

    expect(registry.getProvider("local-openai")?.baseUrl).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  it("rejects an invalid credentialRef and accepts a well formed one", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () => registry.registerProvider(makeProvider({ credentialRef: "sk-ant-secret" })),
      "invalid_credential_ref",
    );
    expectErrorCode(
      () => registry.registerProvider(makeProvider({ credentialRef: "credential:" })),
      "invalid_credential_ref",
    );
    expectErrorCode(
      () => registry.registerProvider(makeProvider({ credentialRef: "Credential:x" })),
      "invalid_credential_ref",
    );

    expect(() =>
      registry.registerProvider(
        makeProvider({ credentialRef: "credential:anthropic-main" }),
      ),
    ).not.toThrow();
  });

  it("rejects invalid provider models", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () => registry.registerProvider(makeProvider({ models: [] })),
      "invalid_provider_models",
    );
    expectErrorCode(
      () => registry.registerProvider(makeProvider({ models: ["ok", ""] })),
      "invalid_provider_models",
    );
    expectErrorCode(
      () => registry.registerProvider(makeProvider({ models: ["dup", "dup"] })),
      "invalid_provider_models",
    );
    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ models: ["https://provider.example/v1"] }),
        ),
      "invalid_provider_models",
    );
    expectErrorCode(
      () => registry.registerProvider(makeProvider({ models: ["sk-livesecretkey"] })),
      "invalid_provider_models",
    );
  });

  it("rejects a non boolean enabled flag", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ enabled: "yes" as unknown as boolean }),
        ),
      "invalid_provider_enabled",
    );
  });

  it("fails to update a provider that does not exist", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () => registry.updateProvider(makeProvider({ id: "ghost" })),
      "provider_not_found",
    );
  });

  it("re-validates the full provider on update", () => {
    const registry = readyRegistry();

    expectErrorCode(
      () => registry.updateProvider(makeProvider({ baseUrl: "nope" })),
      "invalid_provider_url",
    );
    expect(registry.getProvider("anthropic-main")?.baseUrl).toBe(ANTHROPIC_BASE_URL);
  });

  it("refuses to update a provider when a route still uses a removed model", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    expectErrorCode(
      () => registry.updateProvider(makeProvider({ models: ["claude-3-5-haiku"] })),
      "model_not_available",
    );
    expect(registry.getProvider("anthropic-main")?.models).toEqual([
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
    ]);
    expect(registry.resolveRoute("default-route").model).toBe("claude-3-5-sonnet");
  });

  it("allows removing a model that no route uses", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    expect(() =>
      registry.updateProvider(makeProvider({ models: ["claude-3-5-sonnet"] })),
    ).not.toThrow();
    expect(registry.getProvider("anthropic-main")?.models).toEqual([
      "claude-3-5-sonnet",
    ]);
  });

  it("refuses to remove a provider that is still referenced by a route", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    expectErrorCode(
      () => registry.removeProvider("anthropic-main"),
      "provider_has_routes",
    );
    expect(registry.getProvider("anthropic-main")).toBeDefined();
    expect(registry.getRoute("default-route")).toBeDefined();
  });

  it("fails to remove a provider that does not exist", () => {
    const registry = readyRegistry();

    expectErrorCode(() => registry.removeProvider("ghost"), "provider_not_found");
  });

  it("removes an unreferenced provider", () => {
    const registry = readyRegistry();

    registry.removeProvider("anthropic-main");

    expect(registry.getProvider("anthropic-main")).toBeUndefined();
    expect(registry.listProviders()).toEqual([]);
  });
});

describe("task 2 provider registry — route lifecycle", () => {
  it("registers a route and resolves it deterministically", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    expect(registry.resolveRoute("default-route")).toEqual({
      routeId: "default-route",
      providerId: "anthropic-main",
      protocol: "anthropic_messages",
      baseUrl: ANTHROPIC_BASE_URL,
      model: "claude-3-5-sonnet",
      credentialRef: null,
    });
  });

  it("carries the credentialRef into the resolved route", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(
      makeProvider({ credentialRef: "credential:anthropic-main" }),
    );
    registry.registerRoute(makeRoute());

    expect(registry.resolveRoute("default-route").credentialRef).toBe(
      "credential:anthropic-main",
    );
  });

  it("rejects a route that references a missing provider", () => {
    const registry = new InMemoryProviderRegistry();

    expectErrorCode(
      () => registry.registerRoute(makeRoute({ providerId: "ghost" })),
      "provider_not_found",
    );
    expect(registry.listRoutes()).toEqual([]);
  });

  it("rejects a route that references a missing model", () => {
    const registry = readyRegistry();

    expectErrorCode(
      () => registry.registerRoute(makeRoute({ model: "gpt-4o" })),
      "model_not_available",
    );
    expect(registry.listRoutes()).toEqual([]);
  });

  it("rejects a duplicate route id", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    expectErrorCode(
      () => registry.registerRoute(makeRoute({ name: "Impostor" })),
      "duplicate_route_id",
    );
    expect(registry.getRoute("default-route")?.name).toBe("Default Route");
  });

  it("rejects an invalid route id, name and model", () => {
    const registry = readyRegistry();

    expectErrorCode(
      () => registry.registerRoute(makeRoute({ id: "Bad Route" })),
      "invalid_route_id",
    );
    expectErrorCode(
      () => registry.registerRoute(makeRoute({ name: "" })),
      "invalid_route_name",
    );
    expectErrorCode(
      () => registry.registerRoute(makeRoute({ name: " padded " })),
      "invalid_route_name",
    );
    expectErrorCode(
      () => registry.registerRoute(makeRoute({ model: "" })),
      "invalid_route_model",
    );
    expectErrorCode(
      () =>
        registry.registerRoute(
          makeRoute({ model: "https://provider.example/v1" }),
        ),
      "invalid_route_model",
    );
  });

  it("rejects an enabled route on a disabled provider", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider({ enabled: false }));

    expectErrorCode(
      () => registry.registerRoute(makeRoute({ enabled: true })),
      "provider_disabled",
    );
    expect(() =>
      registry.registerRoute(makeRoute({ enabled: false })),
    ).not.toThrow();
  });

  it("refuses to resolve through a disabled provider", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    registry.updateProvider(makeProvider({ enabled: false }));

    expectErrorCode(() => registry.resolveRoute("default-route"), "provider_disabled");
  });

  it("refuses to resolve a disabled route", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute({ enabled: false }));

    expectErrorCode(() => registry.resolveRoute("default-route"), "route_disabled");
  });

  it("fails to resolve an unknown route", () => {
    const registry = readyRegistry();

    expectErrorCode(() => registry.resolveRoute("ghost"), "route_not_found");
  });

  it("re-validates the provider and model when a route changes", () => {
    const registry = readyRegistry();
    registry.registerProvider(
      makeProvider({
        id: "openai-main",
        name: "OpenAI Main",
        protocol: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4o"],
      }),
    );
    registry.registerRoute(makeRoute());

    expectErrorCode(
      () => registry.updateRoute(makeRoute({ model: "gpt-4o" })),
      "model_not_available",
    );
    expectErrorCode(
      () => registry.updateRoute(makeRoute({ providerId: "ghost" })),
      "provider_not_found",
    );

    expect(() => registry.updateRoute(makeRoute({ model: "claude-3-5-haiku" }))).not.toThrow();
    expect(registry.resolveRoute("default-route").model).toBe("claude-3-5-haiku");
  });

  it("switches a route to another provider", () => {
    const registry = readyRegistry();
    registry.registerProvider(
      makeProvider({
        id: "openai-main",
        name: "OpenAI Main",
        protocol: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4o"],
      }),
    );
    registry.registerRoute(makeRoute());

    registry.updateRoute(
      makeRoute({ providerId: "openai-main", model: "gpt-4o" }),
    );

    expect(registry.resolveRoute("default-route")).toEqual({
      routeId: "default-route",
      providerId: "openai-main",
      protocol: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      credentialRef: null,
    });
  });

  it("fails to update a route that does not exist", () => {
    const registry = readyRegistry();

    expectErrorCode(
      () => registry.updateRoute(makeRoute({ id: "ghost" })),
      "route_not_found",
    );
  });

  it("stops resolving a route after removal", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    registry.removeRoute("default-route");

    expect(registry.getRoute("default-route")).toBeUndefined();
    expect(registry.listRoutes()).toEqual([]);
    expectErrorCode(() => registry.resolveRoute("default-route"), "route_not_found");
  });

  it("fails to remove a route that does not exist", () => {
    const registry = readyRegistry();

    expectErrorCode(() => registry.removeRoute("ghost"), "route_not_found");
  });

  it("uses the updated provider configuration on the next resolve", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    registry.updateProvider(
      makeProvider({ baseUrl: "https://api.anthropic.com/v2" }),
    );

    expect(registry.resolveRoute("default-route").baseUrl).toBe(
      "https://api.anthropic.com/v2",
    );
  });
});

describe("task 2 provider registry — copy isolation", () => {
  it("returns provider copies that cannot pollute registry state", () => {
    const registry = readyRegistry();

    const fetched = registry.getProvider("anthropic-main") as unknown as {
      name: string;
      protocol: string;
      baseUrl: string;
      enabled: boolean;
      models: string[];
    };
    fetched.name = "Hacked";
    fetched.protocol = "openai_compatible";
    fetched.baseUrl = "https://evil.example";
    fetched.enabled = false;
    fetched.models.push("evil-model");

    expect(registry.getProvider("anthropic-main")).toEqual(makeProvider());

    const listed = registry.listProviders() as unknown as { name: string }[];
    listed[0].name = "Hacked";
    expect(registry.listProviders()[0]?.name).toBe("Anthropic Main");
  });

  it("returns route copies that cannot pollute registry state", () => {
    const registry = readyRegistry();
    registry.registerRoute(makeRoute());

    const fetched = registry.getRoute("default-route") as unknown as {
      name: string;
      model: string;
      enabled: boolean;
    };
    fetched.name = "Hacked";
    fetched.model = "evil-model";
    fetched.enabled = false;

    expect(registry.getRoute("default-route")).toEqual(makeRoute());

    const listed = registry.listRoutes() as unknown as { name: string }[];
    listed[0].name = "Hacked";
    expect(registry.listRoutes()[0]?.name).toBe("Default Route");
  });

  it("does not retain a reference to the caller supplied models array", () => {
    const registry = new InMemoryProviderRegistry();
    const models = ["claude-3-5-sonnet"];
    registry.registerProvider(makeProvider({ models }));

    models.push("injected-model");

    expect(registry.getProvider("anthropic-main")?.models).toEqual([
      "claude-3-5-sonnet",
    ]);
  });
});

describe("task 2 provider registry — official presets", () => {
  it("exposes the two official protocol presets", () => {
    const presets = getOfficialProviderPresets();

    expect(presets).toContainEqual({
      id: "anthropic-official",
      name: "Anthropic",
      protocol: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(presets).toContainEqual({
      id: "openai-official",
      name: "OpenAI",
      protocol: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("does not register or enable presets automatically", () => {
    const registry = new InMemoryProviderRegistry();

    getOfficialProviderPresets();

    expect(registry.listProviders()).toEqual([]);
    expect(registry.getProvider("anthropic-official")).toBeUndefined();
  });

  it("returns a fresh copy on every call", () => {
    const first = getOfficialProviderPresets();
    const second = getOfficialProviderPresets();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
  });
});
