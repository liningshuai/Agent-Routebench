import { describe, expect, it } from "vitest";
import {
  InMemoryProviderRegistry,
  MAX_ROUTE_FALLBACKS,
  PROVIDER_REGISTRY_ERROR_CODES,
  ProviderRegistryError,
  type ProviderDefinition,
  type RouteDefinition,
} from "../packages/provider-registry/src/index.js";
import {
  ANTHROPIC_BASE_URL,
  TASK5_PRIMARY_BASE_URL,
  TASK5_PRIMARY_ID,
  TASK5_SECRET_PROBE,
  TASK5_SECRET_PRIMARY,
  candidateFixture,
  twoProviderFixture,
} from "./helpers/http-fixtures.js";

const MODEL = "offline-model";

function provider(
  id: string,
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id,
    name: `Provider ${id}`,
    protocol: "anthropic_messages",
    baseUrl: ANTHROPIC_BASE_URL,
    credentialRef: `credential:${id}`,
    models: [MODEL],
    enabled: true,
    ...overrides,
  };
}

function route(
  providerIds: readonly string[],
  overrides: Partial<RouteDefinition> = {},
): RouteDefinition {
  const [primary, ...fallbacks] = providerIds;
  return {
    id: "route-candidates",
    name: "Route Candidates",
    providerId: primary,
    model: MODEL,
    enabled: true,
    ...(fallbacks.length === 0 ? {} : { fallbackProviderIds: fallbacks }),
    ...overrides,
  };
}

function registryWith(providers: readonly ProviderDefinition[]): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  for (const definition of providers) {
    registry.registerProvider(definition);
  }
  return registry;
}

function expectErrorCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a ProviderRegistryError with code "${code}"`).toBeInstanceOf(
    ProviderRegistryError,
  );
  expect((caught as ProviderRegistryError).code).toBe(code);
  expect((caught as ProviderRegistryError).message).not.toContain(TASK5_SECRET_PROBE);
}

describe("task 5 candidate registry — stable error codes", () => {
  it("declares the five new fallback error codes", () => {
    const declared: ReadonlySet<string> = new Set(
      Object.values(PROVIDER_REGISTRY_ERROR_CODES),
    );
    for (const code of [
      "invalid_fallback_provider_ids",
      "duplicate_fallback_provider_id",
      "fallback_provider_not_found",
      "fallback_model_not_available",
      "too_many_fallback_providers",
    ]) {
      expect(declared.has(code), `missing error code ${code}`).toBe(true);
    }
  });

  it("exposes a bounded fallback limit", () => {
    expect(MAX_ROUTE_FALLBACKS).toBe(4);
  });
});

describe("task 5 candidate registry — route fallback validation", () => {
  it("accepts a route without fallbacks and keeps the field absent", () => {
    const registry = registryWith([provider(TASK5_PRIMARY_ID)]);
    registry.registerRoute(route([TASK5_PRIMARY_ID]));

    const stored = registry.getRoute("route-candidates");
    expect(stored?.fallbackProviderIds).toBeUndefined();
    expect(stored).toEqual(route([TASK5_PRIMARY_ID]));
  });

  it("accepts an ordered fallback list up to the limit", () => {
    const ids = ["b-one", "b-two", "b-three", "b-four"];
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      ...ids.map((id) => provider(id)),
    ]);

    registry.registerRoute(route([TASK5_PRIMARY_ID, ...ids]));

    expect(registry.getRoute("route-candidates")?.fallbackProviderIds).toEqual(ids);
    expect(MAX_ROUTE_FALLBACKS).toBe(ids.length);
  });

  it("rejects more fallbacks than the limit", () => {
    const ids = ["b-one", "b-two", "b-three", "b-four", "b-five"];
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      ...ids.map((id) => provider(id)),
    ]);

    expectErrorCode(
      () => registry.registerRoute(route([TASK5_PRIMARY_ID, ...ids])),
      "too_many_fallback_providers",
    );
    expect(registry.listRoutes()).toEqual([]);
  });

  it("rejects an unknown fallback provider", () => {
    const registry = registryWith([provider(TASK5_PRIMARY_ID)]);

    expectErrorCode(
      () => registry.registerRoute(route([TASK5_PRIMARY_ID, "ghost-provider"])),
      "fallback_provider_not_found",
    );
  });

  it("rejects a fallback provider that does not serve the route model", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one", { models: ["another-model"] }),
    ]);

    expectErrorCode(
      () => registry.registerRoute(route([TASK5_PRIMARY_ID, "b-one"])),
      "fallback_model_not_available",
    );
  });

  it("rejects a duplicated fallback id", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one"),
    ]);

    expectErrorCode(
      () => registry.registerRoute(route([TASK5_PRIMARY_ID, "b-one", "b-one"])),
      "duplicate_fallback_provider_id",
    );
  });

  it("rejects a fallback that repeats the primary provider", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one"),
    ]);

    expectErrorCode(
      () => registry.registerRoute(route([TASK5_PRIMARY_ID, TASK5_PRIMARY_ID])),
      "duplicate_fallback_provider_id",
    );
  });

  it("rejects malformed fallback lists", () => {
    const registry = registryWith([provider(TASK5_PRIMARY_ID)]);

    for (const bad of [
      "b-one",
      [1, 2],
      ["B-ONE"],
      ["b one"],
      [TASK5_SECRET_PROBE],
      ["credential:stolen"],
      [null],
      [""],
    ]) {
      expectErrorCode(
        () =>
          registry.registerRoute(
            route([TASK5_PRIMARY_ID], {
              fallbackProviderIds: bad,
            } as unknown as Partial<RouteDefinition>),
          ),
        "invalid_fallback_provider_ids",
      );
    }
    expect(registry.listRoutes()).toEqual([]);
  });

  it("applies the same fallback validation on update", () => {
    const registry = registryWith([provider(TASK5_PRIMARY_ID), provider("b-one")]);
    registry.registerRoute(route([TASK5_PRIMARY_ID]));

    expectErrorCode(
      () =>
        registry.updateRoute(
          route([TASK5_PRIMARY_ID], { fallbackProviderIds: ["ghost-provider"] }),
        ),
      "fallback_provider_not_found",
    );
    expect(registry.getRoute("route-candidates")?.fallbackProviderIds).toBeUndefined();
  });
});

describe("task 5 candidate registry — reference protection", () => {
  it("refuses to remove a provider that is only referenced as a fallback", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one"),
    ]);
    registry.registerRoute(route([TASK5_PRIMARY_ID, "b-one"]));

    expectErrorCode(() => registry.removeProvider("b-one"), "provider_has_routes");
    expect(registry.getProvider("b-one")).toBeDefined();
  });

  it("refuses an update that drops a model used by a fallback route", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one"),
    ]);
    registry.registerRoute(route([TASK5_PRIMARY_ID, "b-one"]));

    expectErrorCode(
      () =>
        registry.updateProvider(provider("b-one", { models: ["different-model"] })),
      "model_not_available",
    );
    expect(registry.getProvider("b-one")?.models).toEqual([MODEL]);
  });

  it("allows disabling a fallback provider without removing its model", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one"),
    ]);
    registry.registerRoute(route([TASK5_PRIMARY_ID, "b-one"]));

    registry.updateProvider(provider("b-one", { enabled: false }));

    expect(registry.getProvider("b-one")?.enabled).toBe(false);
    expect(registry.getRoute("route-candidates")?.fallbackProviderIds).toEqual(["b-one"]);
  });
});

describe("task 5 candidate registry — resolveRouteCandidates", () => {
  it("returns the primary provider when no fallbacks are configured", () => {
    const fixture = candidateFixture({ primary: { id: TASK5_PRIMARY_ID } });

    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);

    expect(candidates.map((candidate) => candidate.providerId)).toEqual([
      TASK5_PRIMARY_ID,
    ]);
  });

  it("returns primary then fallbacks in configuration order", () => {
    const fixture = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID },
      fallbacks: [{ id: "b-one" }, { id: "b-two" }, { id: "b-three" }],
    });

    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);

    expect(candidates.map((candidate) => candidate.providerId)).toEqual([
      TASK5_PRIMARY_ID,
      "b-one",
      "b-two",
      "b-three",
    ]);
  });

  it("skips a disabled fallback but keeps the enabled ones in order", () => {
    const fixture = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID },
      fallbacks: [
        { id: "b-one", enabled: false },
        { id: "b-two" },
        { id: "b-three", enabled: false },
      ],
    });

    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);

    expect(candidates.map((candidate) => candidate.providerId)).toEqual([
      TASK5_PRIMARY_ID,
      "b-two",
    ]);
  });

  it("resolves the fallback when the primary provider is disabled", () => {
    const fixture = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID, enabled: false },
      fallbacks: [{ id: "b-one" }, { id: "b-two" }],
    });

    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);

    expect(candidates.map((candidate) => candidate.providerId)).toEqual([
      "b-one",
      "b-two",
    ]);
  });

  it("fails with provider_disabled when every candidate is disabled", () => {
    const fixture = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID, enabled: false },
      fallbacks: [{ id: "b-one", enabled: false }],
    });

    expectErrorCode(
      () => fixture.registry.resolveRouteCandidates(fixture.routeId),
      "provider_disabled",
    );
  });

  it("fails with the documented codes for unknown and disabled routes", () => {
    const fixture = candidateFixture({ primary: { id: TASK5_PRIMARY_ID } });

    expectErrorCode(
      () => fixture.registry.resolveRouteCandidates("route-nowhere"),
      "route_not_found",
    );

    const disabled = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID },
      routeEnabled: false,
    });
    expectErrorCode(
      () => disabled.registry.resolveRouteCandidates(disabled.routeId),
      "route_disabled",
    );
  });

  it("follows the candidate protocol rather than a route wide protocol", () => {
    const fixture = candidateFixture({
      primary: {
        id: TASK5_PRIMARY_ID,
        protocol: "anthropic_messages",
        baseUrl: "https://a.task5.test",
      },
      fallbacks: [
        {
          id: "b-openai",
          protocol: "openai_compatible",
          baseUrl: "https://b.task5.test/v1",
        },
      ],
    });

    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);

    expect(candidates[0]?.protocol).toBe("anthropic_messages");
    expect(candidates[0]?.baseUrl).toBe("https://a.task5.test");
    expect(candidates[1]?.protocol).toBe("openai_compatible");
    expect(candidates[1]?.baseUrl).toBe("https://b.task5.test/v1");
  });

  it("returns only the six secret free route fields per candidate", () => {
    const fixture = twoProviderFixture();

    for (const candidate of fixture.registry.resolveRouteCandidates(fixture.routeId)) {
      expect(Object.keys(candidate).sort()).toEqual([
        "baseUrl",
        "credentialRef",
        "model",
        "protocol",
        "providerId",
        "routeId",
      ]);
      const serialized = JSON.stringify(candidate);
      expect(serialized).not.toContain(TASK5_SECRET_PRIMARY);
      expect(serialized).not.toContain(TASK5_SECRET_PROBE);
      expect(serialized).not.toContain("fallbackProviderIds");
      expect(serialized).not.toContain("headers");
      expect(serialized).not.toContain("authorization");
    }
  });

  it("carries each provider's own credentialRef", () => {
    const fixture = twoProviderFixture();

    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);

    expect(candidates[0]?.credentialRef).toBe(`credential:${TASK5_PRIMARY_ID}`);
    expect(candidates[1]?.credentialRef).toBe("credential:fallback-second");
  });

  it("returns copies that cannot pollute the registry", () => {
    const fixture = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID },
      fallbacks: [{ id: "b-one" }],
    });

    const first = fixture.registry.resolveRouteCandidates(
      fixture.routeId,
    ) as unknown as { providerId: string }[];
    first[0].providerId = "hacked";
    first.push({ providerId: "injected" });

    const second = fixture.registry.resolveRouteCandidates(fixture.routeId);
    expect(second.map((candidate) => candidate.providerId)).toEqual([
      TASK5_PRIMARY_ID,
      "b-one",
    ]);
  });

  it("keeps the legacy resolveRoute behaviour and shape untouched", () => {
    const fixture = twoProviderFixture();

    const single = fixture.registry.resolveRoute(fixture.routeId);

    expect(single).toEqual({
      routeId: fixture.routeId,
      providerId: TASK5_PRIMARY_ID,
      protocol: "anthropic_messages",
      baseUrl: TASK5_PRIMARY_BASE_URL,
      model: MODEL,
      credentialRef: `credential:${TASK5_PRIMARY_ID}`,
    });
    expect(JSON.stringify(single)).not.toContain("fallbackProviderIds");
  });
});

describe("task 5 candidate registry — route copies", () => {
  it("returns deep copies of the fallback array", () => {
    const fixture = candidateFixture({
      primary: { id: TASK5_PRIMARY_ID },
      fallbacks: [{ id: "b-one" }, { id: "b-two" }],
    });

    const fetched = fixture.registry.getRoute(
      fixture.routeId,
    ) as unknown as { fallbackProviderIds: string[] };
    fetched.fallbackProviderIds.push("injected");
    fetched.fallbackProviderIds[0] = "hacked";

    expect(fixture.registry.getRoute(fixture.routeId)?.fallbackProviderIds).toEqual([
      "b-one",
      "b-two",
    ]);

    const listed = fixture.registry.listRoutes() as unknown as {
      fallbackProviderIds: string[];
    }[];
    listed[0].fallbackProviderIds.length = 0;

    expect(fixture.registry.listRoutes()[0]?.fallbackProviderIds).toEqual([
      "b-one",
      "b-two",
    ]);
  });

  it("does not retain the caller supplied fallback array", () => {
    const registry = registryWith([provider(TASK5_PRIMARY_ID), provider("b-one")]);
    const fallbackProviderIds = ["b-one"];
    registry.registerRoute(
      route([TASK5_PRIMARY_ID], { fallbackProviderIds }),
    );

    fallbackProviderIds.push("b-two");

    expect(registry.getRoute("route-candidates")?.fallbackProviderIds).toEqual(["b-one"]);
  });

  it("keeps fallback configuration free of forbidden route fields", () => {
    const registry = registryWith([
      provider(TASK5_PRIMARY_ID),
      provider("b-one"),
    ]);

    for (const extra of [
      { headers: { authorization: TASK5_SECRET_PROBE } },
      { baseUrl: "https://evil.test" },
      { endpoint: "/steal" },
      { apiKey: TASK5_SECRET_PROBE },
      { token: TASK5_SECRET_PROBE },
      { secret: TASK5_SECRET_PROBE },
    ]) {
      expectErrorCode(
        () =>
          registry.registerRoute({
            ...route([TASK5_PRIMARY_ID, "b-one"]),
            ...extra,
          } as unknown as RouteDefinition),
        "forbidden_route_field",
      );
    }
    expect(registry.listRoutes()).toEqual([]);
  });
});
