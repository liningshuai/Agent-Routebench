import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
  type ProviderDefinition,
  type RouteDefinition,
} from "../packages/provider-registry/src/index.js";
import {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  createConfigSnapshot,
  createFileJsonConfigStore,
  loadProviderRegistry,
  saveProviderRegistry,
  validateConfigSnapshot,
} from "../packages/local-persistence/src/index.js";

const SECRET_MARKER = "TASK8_SYNTHETIC_SECRET";
const ANTHROPIC_URL = "https://api.anthropic.com";

const FORBIDDEN_MARKERS = [
  SECRET_MARKER,
  "apiKey",
  "api_key",
  "Authorization",
  "Bearer ",
  "password",
  "headers",
  "provider_secret",
  "credential:test-provider-secret-value",
];

function makeProvider(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "test-provider",
    name: "Test Provider",
    protocol: "anthropic_messages",
    baseUrl: ANTHROPIC_URL,
    credentialRef: "credential:test-provider",
    models: ["model-a"],
    enabled: true,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    id: "test-route",
    name: "Test Route",
    providerId: "test-provider",
    model: "model-a",
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

async function captureAsyncError(run: () => Promise<unknown>): Promise<PersistenceError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PersistenceError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected PersistenceError");
}

let tempDir: string;
let configPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task8-sec-"));
  configPath = join(tempDir, "config.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("task 8 security: forbidden fields", () => {
  it("rejects an apiKey field on a provider", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [{ ...makeProvider(), apiKey: SECRET_MARKER }],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
    expect(error.message).not.toContain(SECRET_MARKER);
  });

  it("rejects a headers field on a provider", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [
          { ...makeProvider(), headers: { Authorization: `Bearer ${SECRET_MARKER}` } },
        ],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
    expect(error.message).not.toContain(SECRET_MARKER);
  });

  it("rejects an Authorization field on a route", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [{ ...makeRoute(), authorization: `Bearer ${SECRET_MARKER}` }],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects a token field on a provider", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [{ ...makeProvider(), token: SECRET_MARKER }],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects a password embedded in baseUrl", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [
          makeProvider({
            baseUrl: `https://user:${SECRET_MARKER}@api.example.com`,
          }),
        ],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedProvider);
    expect(error.message).not.toContain(SECRET_MARKER);
  });

  it("rejects an endpoint field on a route", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [makeProvider()],
        routes: [{ ...makeRoute(), endpoint: "https://evil.example.com" }],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("rejects unknown root field carrying a secret", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [],
        routes: [],
        secrets: { apiKey: SECRET_MARKER },
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
    expect(error.message).not.toContain(SECRET_MARKER);
  });

  it("rejects a credential value instead of a reference", () => {
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
    expect(error.message).not.toContain(SECRET_MARKER);
  });
});

describe("task 8 security: file contents never leak secrets", () => {
  it("never writes secret markers to the config file", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());
    registry.registerRoute(makeRoute());

    const store = createFileJsonConfigStore({ filePath: configPath });
    await saveProviderRegistry(store, registry);

    const raw = await readFile(configPath, "utf8");
    for (const marker of FORBIDDEN_MARKERS) {
      expect(raw).not.toContain(marker);
    }
    expect(raw).toContain("credential:test-provider");
  });

  it("never writes a secret into a rejected save path", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());
    registry.registerRoute(makeRoute());
    const store = createFileJsonConfigStore({ filePath: configPath });
    await saveProviderRegistry(store, registry);

    const error = await captureAsyncError(() =>
      store.save({
        version: 1,
        providers: [{ ...makeProvider(), secret: SECRET_MARKER }],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
    expect(error.message).not.toContain(SECRET_MARKER);

    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain(SECRET_MARKER);
  });

  it("never writes a secret into a temp file after a failed rename path", async () => {
    const blockedPath = join(tempDir, "blocked");
    await writeFile(blockedPath, "x", "utf8");
    const badStore = createFileJsonConfigStore({
      filePath: join(blockedPath, "config.json"),
    });

    const error = await captureAsyncError(() =>
      badStore.save({
        version: 1,
        providers: [{ ...makeProvider(), apiKey: SECRET_MARKER }],
        routes: [],
      }),
    );
    expect(error.message).not.toContain(SECRET_MARKER);

    const entries = await readdir(tempDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) {
        const content = await readFile(join(tempDir, entry), "utf8");
        expect(content).not.toContain(SECRET_MARKER);
      }
    }
  });

  it("does not persist CredentialStore secrets", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.set("credential:test-provider", SECRET_MARKER);

    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(makeProvider());
    registry.registerRoute(makeRoute());

    const store = createFileJsonConfigStore({ filePath: configPath });
    await saveProviderRegistry(store, registry);

    const raw = await readFile(configPath, "utf8");
    expect(raw).not.toContain(SECRET_MARKER);
    expect(raw).toContain("credential:test-provider");

    const restored = await loadProviderRegistry(store);
    expect(restored.getProvider("test-provider")?.credentialRef).toBe(
      "credential:test-provider",
    );
  });

  it("does not read environment variables when saving", async () => {
    process.env.TASK8_SYNTHETIC_SECRET = SECRET_MARKER;
    try {
      const registry = new InMemoryProviderRegistry();
      registry.registerProvider(makeProvider());
      const store = createFileJsonConfigStore({ filePath: configPath });
      await saveProviderRegistry(store, registry);

      const raw = await readFile(configPath, "utf8");
      expect(raw).not.toContain(SECRET_MARKER);
    } finally {
      delete process.env.TASK8_SYNTHETIC_SECRET;
    }
  });

  it("does not perform network access during save or load", async () => {
    const originalFetch = globalThis.fetch;
    const originalHttp = globalThisThisHttp();
    const calls: string[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(String(args[0]));
      throw new Error("network disabled");
    }) as typeof fetch;

    try {
      const registry = new InMemoryProviderRegistry();
      registry.registerProvider(makeProvider());
      const store = createFileJsonConfigStore({ filePath: configPath });
      await saveProviderRegistry(store, registry);
      await loadProviderRegistry(store);
      expect(calls).toEqual([]);
      void originalHttp;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function globalThisThisHttp(): unknown {
  return undefined;
}

describe("task 8 security: error messages stay fixed", () => {
  it("does not echo file paths", async () => {
    const store = createFileJsonConfigStore({ filePath: configPath });
    await writeFile(configPath, "not-json", "utf8");
    const error = await captureAsyncError(() => store.load());
    expect(error.message).not.toContain(tempDir);
    expect(error.message).toBe("The configuration file could not be read.");
  });

  it("does not echo JSON content", () => {
    const error = captureError(() =>
      validateConfigSnapshot({
        version: 1,
        providers: [{ ...makeProvider(), extraField: SECRET_MARKER }],
        routes: [],
      }),
    );
    expect(error.message).not.toContain(SECRET_MARKER);
    expect(error.message).not.toContain("extraField");
  });

  it("uses fixed messages for write failures", async () => {
    const blocked = join(tempDir, "blocked");
    await writeFile(blocked, "x", "utf8");
    const badStore = createFileJsonConfigStore({
      filePath: join(blocked, "config.json"),
    });
    const error = await captureAsyncError(() => badStore.save({
      version: 1,
      providers: [],
      routes: [],
    }));
    expect(error.message).toBe("The configuration file could not be written.");
  });

  it("uses a fixed message for invalid paths", () => {
    const error = captureError(() =>
      createFileJsonConfigStore({ filePath: "../escape.json" }),
    );
    expect(error.message).toBe("The configuration file path is invalid.");
  });
});
