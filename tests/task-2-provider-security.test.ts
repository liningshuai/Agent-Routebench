import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
  ProviderRegistryError,
  getOfficialProviderPresets,
  type ProviderDefinition,
  type RouteDefinition,
} from "../packages/provider-registry/src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_DIR = "packages/provider-registry";

// Secret-shaped fixtures. They are assembled so that raw credential-looking
// strings never appear verbatim in the repository sources.
const SECRET = "TOP_SECRET_PROVIDER_VALUE_9f3a";
const AUTH_FIELD = "Authorization";
const AUTH_HEADER_VALUE = `Bearer ${SECRET}`;
const PROVIDER_URL = "https://provider.example/v1";

function makeProvider(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "anthropic-main",
    name: "Anthropic Main",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    credentialRef: null,
    models: ["claude-3-5-sonnet"],
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

function expectErrorCode(run: () => unknown, code: string): unknown {
  const error = captureError(run);
  expect(error, `expected an error with code "${code}"`).toBeInstanceOf(
    ProviderRegistryError,
  );
  expect((error as ProviderRegistryError).code).toBe(code);
  return error;
}

function listSourceFiles(relativeDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir)) {
      if (entry === "node_modules") {
        continue;
      }
      const full = join(absoluteDir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out.push({
          path: relative(root, full).split(sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(join(root, relativeDir));
  return out;
}

const registrySources = listSourceFiles(`${PACKAGE_DIR}/src`);

describe("task 2 security — forbidden fields on providers", () => {
  it("rejects a provider carrying an apiKey field", () => {
    const registry = new InMemoryProviderRegistry();
    const provider = {
      ...makeProvider(),
      apiKey: SECRET,
    } as unknown as ProviderDefinition;

    expectErrorCode(() => registry.registerProvider(provider), "forbidden_provider_field");
    expect(registry.listProviders()).toEqual([]);
  });

  it("rejects a provider carrying a token field", () => {
    const registry = new InMemoryProviderRegistry();
    const provider = {
      ...makeProvider(),
      token: SECRET,
    } as unknown as ProviderDefinition;

    expectErrorCode(() => registry.registerProvider(provider), "forbidden_provider_field");
  });

  it("rejects a provider carrying an authorization field", () => {
    const registry = new InMemoryProviderRegistry();
    const provider = {
      ...makeProvider(),
      [AUTH_FIELD]: AUTH_HEADER_VALUE,
    } as unknown as ProviderDefinition;

    expectErrorCode(() => registry.registerProvider(provider), "forbidden_provider_field");
  });

  it("rejects a provider carrying a headers field", () => {
    const registry = new InMemoryProviderRegistry();
    const provider = {
      ...makeProvider(),
      headers: { [AUTH_FIELD]: AUTH_HEADER_VALUE },
    } as unknown as ProviderDefinition;

    expectErrorCode(() => registry.registerProvider(provider), "forbidden_provider_field");
  });

  it("rejects an update that sneaks in a forbidden provider field", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());

    expectErrorCode(
      () =>
        registry.updateProvider({
          ...makeProvider(),
          secret: SECRET,
        } as unknown as ProviderDefinition),
      "forbidden_provider_field",
    );
    expect(registry.getProvider("anthropic-main")).toEqual(makeProvider());
  });
});

describe("task 2 security — forbidden fields on routes", () => {
  it("rejects a route carrying secret fields", () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());

    const forbiddenExtras: Record<string, unknown>[] = [
      { apiKey: SECRET },
      { api_key: SECRET },
      { token: SECRET },
      { [AUTH_FIELD]: AUTH_HEADER_VALUE },
      { headers: { [AUTH_FIELD]: AUTH_HEADER_VALUE } },
      { secret: SECRET },
      { password: SECRET },
      { credential: SECRET },
      { baseUrl: PROVIDER_URL },
      { endpoint: PROVIDER_URL },
    ];

    for (const extra of forbiddenExtras) {
      const route = { ...makeRoute(), ...extra } as unknown as RouteDefinition;
      expectErrorCode(() => registry.registerRoute(route), "forbidden_route_field");
    }

    expect(registry.listRoutes()).toEqual([]);
  });
});

describe("task 2 security — credential reference boundary", () => {
  it("treats credentialRef as a reference, never as the secret itself", async () => {
    const registry = new InMemoryProviderRegistry();
    const store = new InMemoryCredentialStore();

    // A raw secret must not be accepted as a credentialRef.
    expectErrorCode(
      () => registry.registerProvider(makeProvider({ credentialRef: SECRET })),
      "invalid_credential_ref",
    );
    expectErrorCode(
      () =>
        registry.registerProvider(
          makeProvider({ credentialRef: `credential:${SECRET}` }),
        ),
      "invalid_credential_ref",
    );

    const ref = "credential:anthropic-main";
    registry.registerProvider(makeProvider({ credentialRef: ref }));
    registry.registerRoute(makeRoute());

    await store.set(ref, SECRET);

    expect(registry.getProvider("anthropic-main")?.credentialRef).toBe(ref);
    expect(registry.resolveRoute("default-route").credentialRef).toBe(ref);
    expect(await store.get(ref)).toBe(SECRET);
  });

  it("never puts the secret into a resolved route", async () => {
    const registry = new InMemoryProviderRegistry();
    const store = new InMemoryCredentialStore();
    const ref = "credential:anthropic-main";

    registry.registerProvider(makeProvider({ credentialRef: ref }));
    registry.registerRoute(makeRoute());
    await store.set(ref, SECRET);

    const resolved = registry.resolveRoute("default-route");
    const serialized = JSON.stringify(resolved);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("secret");
    expect(Object.keys(resolved).sort()).toEqual([
      "baseUrl",
      "credentialRef",
      "model",
      "protocol",
      "providerId",
      "routeId",
    ]);
  });

  it("does not leak the secret through registry error messages", () => {
    const registry = new InMemoryProviderRegistry();

    const errors: unknown[] = [
      captureError(() =>
        registry.registerProvider({
          ...makeProvider(),
          apiKey: SECRET,
        } as unknown as ProviderDefinition),
      ),
      captureError(() =>
        registry.registerProvider(makeProvider({ baseUrl: `${PROVIDER_URL}?k=${SECRET}` })),
      ),
      captureError(() =>
        registry.registerProvider(makeProvider({ credentialRef: SECRET })),
      ),
      captureError(() =>
        registry.registerProvider(makeProvider({ models: [PROVIDER_URL] })),
      ),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderRegistryError);
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(PROVIDER_URL);
      expect(message).not.toMatch(/authorization/i);
      expect(message).not.toMatch(/bearer/i);
      expect(message).not.toMatch(/api[_-]?key/i);
      expect(message).not.toMatch(/token/i);
      expect(message).not.toMatch(/secret/i);
    }
  });

  it("supports set, get, has and delete on the in-memory credential store", async () => {
    const store = new InMemoryCredentialStore();
    const ref = "credential:anthropic-main";

    expect(await store.has(ref)).toBe(false);
    expect(await store.get(ref)).toBeUndefined();

    await store.set(ref, SECRET);
    expect(await store.has(ref)).toBe(true);
    expect(await store.get(ref)).toBe(SECRET);

    await store.delete(ref);
    expect(await store.has(ref)).toBe(false);
    expect(await store.get(ref)).toBeUndefined();
  });

  it("rejects an invalid credential ref and an empty secret", async () => {
    const store = new InMemoryCredentialStore();

    await expect(store.set(SECRET, SECRET)).rejects.toMatchObject({
      code: "invalid_credential_ref",
    });
    await expect(store.set("credential:ok", "")).rejects.toMatchObject({
      code: "invalid_credential_value",
    });
    await expect(
      store.set("credential:ok", undefined as unknown as string),
    ).rejects.toMatchObject({ code: "invalid_credential_value" });
  });

  it("stores credentials only under an exact ref match", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("credential:anthropic-main", SECRET);

    expect(await store.get("credential:anthropic-other")).toBeUndefined();
    expect(await store.get("credential:anthropic-main ")).toBeUndefined();
    expect(await store.get("anthropic-main")).toBeUndefined();
  });

  it("does not reflect the stored secret into providers or routes", async () => {
    const registry = new InMemoryProviderRegistry();
    const store = new InMemoryCredentialStore();
    const ref = "credential:anthropic-main";

    registry.registerProvider(makeProvider({ credentialRef: ref }));
    registry.registerRoute(makeRoute());
    await store.set(ref, SECRET);

    for (const value of [
      registry.getProvider("anthropic-main"),
      registry.listProviders(),
      registry.getRoute("default-route"),
      registry.listRoutes(),
      registry.resolveRoute("default-route"),
    ]) {
      expect(JSON.stringify(value)).not.toContain(SECRET);
    }
  });
});

describe("task 2 security — official presets", () => {
  it("ships no secret-bearing field in any preset", () => {
    const presets = getOfficialProviderPresets();

    expect(presets.length).toBeGreaterThanOrEqual(2);
    for (const preset of presets) {
      expect(Object.keys(preset).sort()).toEqual([
        "baseUrl",
        "id",
        "name",
        "protocol",
      ]);
      const serialized = JSON.stringify(preset);
      expect(serialized).not.toMatch(/authorization/i);
      expect(serialized).not.toMatch(/bearer/i);
      expect(serialized).not.toMatch(/api[_-]?key/i);
      expect(serialized).not.toMatch(/token/i);
      expect(serialized).not.toMatch(/secret/i);
      expect(serialized).not.toMatch(/credential/i);
      expect(serialized).not.toMatch(/headers/i);
    }
  });

  it("does not let caller mutation pollute later preset reads", () => {
    const first = getOfficialProviderPresets() as unknown as {
      id: string;
      name: string;
      baseUrl: string;
      protocol: string;
    }[];
    first[0].name = "Hacked";
    first[0].baseUrl = "https://evil.example";
    first[0].protocol = "openai_compatible";
    first.length = 0;

    const second = getOfficialProviderPresets();

    expect(second).toContainEqual({
      id: "anthropic-official",
      name: "Anthropic",
      protocol: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(second).toContainEqual({
      id: "openai-official",
      name: "OpenAI",
      protocol: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
    });
  });
});

describe("task 2 security — no network, no persistence", () => {
  it("never calls fetch during a full registry lifecycle", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const registry = new InMemoryProviderRegistry();
      const store = new InMemoryCredentialStore();
      const ref = "credential:anthropic-main";

      getOfficialProviderPresets();
      registry.registerProvider(makeProvider({ credentialRef: ref }));
      registry.registerRoute(makeRoute());
      registry.updateProvider(makeProvider({ credentialRef: ref, name: "Renamed" }));
      registry.updateRoute(makeRoute({ name: "Renamed Route" }));
      registry.listProviders();
      registry.listRoutes();
      registry.resolveRoute("default-route");
      await store.set(ref, SECRET);
      await store.get(ref);
      await store.has(ref);
      await store.delete(ref);
      captureError(() => registry.resolveRoute("ghost"));
      registry.removeRoute("default-route");
      registry.removeProvider("anthropic-main");

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("imports no network module anywhere in the package", () => {
    expect(registrySources.length).toBeGreaterThan(0);

    const forbidden = [
      /from\s+["'](node:)?(http|https|http2|net|tls|dns)["']/,
      /require\(\s*["'](node:)?(http|https|http2|net|tls|dns)["']\s*\)/,
      /\bundici\b/,
      /\baxios\b/,
      /\bnode-fetch\b/,
      /\bsuperagent\b/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /new\s+WebSocket\b/,
    ];

    for (const file of registrySources) {
      for (const pattern of forbidden) {
        expect(pattern.test(file.text), `${file.path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it("writes no files, databases, environment variables or keychain entries", () => {
    const forbidden = [
      /from\s+["'](node:)?fs["']/,
      /from\s+["'](node:)?fs\/promises["']/,
      /require\(\s*["'](node:)?fs["']\s*\)/,
      /\bwriteFileSync?\b/,
      /\bappendFileSync?\b/,
      /\bcreateWriteStream\b/,
      /\bsqlite\b/i,
      /\bbetter-sqlite3\b/,
      /\blevel(db|down)\b/i,
      /\bindexeddb\b/i,
      /\bkeytar\b/,
      /\bprocess\.env\b/,
    ];

    for (const file of registrySources) {
      for (const pattern of forbidden) {
        expect(pattern.test(file.text), `${file.path} matched ${pattern}`).toBe(false);
      }
    }
  });

  it("declares no runtime dependency for the package", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, `${PACKAGE_DIR}/package.json`), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.name).toBe("@agent-workbench/provider-registry");
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.types).toBe("./src/index.ts");
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });

  it("keeps provider-registry free of other workspace packages", () => {
    for (const file of registrySources) {
      expect(file.text, file.path).not.toContain("agent-core");
      expect(file.text, file.path).not.toContain("model-gateway");
      expect(file.text, file.path).not.toContain("cc-switch");
      expect(file.text, file.path).not.toContain("agent-contracts");
      expect(file.text, file.path).not.toMatch(/\.\.\/\.\.[^"']*\/src\//);
    }
  });
});
