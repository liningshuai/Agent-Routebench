import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryProviderRegistry,
  type ProviderDefinition,
  type RouteDefinition,
} from "../packages/provider-registry/src/index.js";
import {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  createFileJsonConfigStore,
  createConfigSnapshot,
  loadProviderRegistry,
  saveProviderRegistry,
  type JsonConfigStore,
  type PersistedConfigV1,
} from "../packages/local-persistence/src/index.js";

const ANTHROPIC_URL = "https://api.anthropic.com";

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
let store: JsonConfigStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task8-"));
  configPath = join(tempDir, "config.json");
  store = createFileJsonConfigStore({ filePath: configPath });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function baseRegistry(): InMemoryProviderRegistry {
  const registry = new InMemoryProviderRegistry();
  registry.registerProvider(makeProvider());
  registry.registerRoute(makeRoute());
  return registry;
}

const validSnapshot = () => createConfigSnapshot(baseRegistry());

describe("task 8 file store path validation", () => {
  it("accepts an absolute path", () => {
    expect(isAbsolute(configPath)).toBe(true);
    expect(() => createFileJsonConfigStore({ filePath: configPath })).not.toThrow();
  });

  it("rejects an empty path", () => {
    const error = captureError(() =>
      createFileJsonConfigStore({ filePath: "" }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidConfigFilePath);
  });

  it("rejects a relative path", () => {
    const error = captureError(() =>
      createFileJsonConfigStore({ filePath: "config.json" }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidConfigFilePath);
  });

  it("rejects a null path", () => {
    const error = captureError(() =>
      createFileJsonConfigStore({ filePath: null as unknown as string }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidConfigFilePath);
  });

  it("rejects a numeric path", () => {
    const error = captureError(() =>
      createFileJsonConfigStore({ filePath: 42 as unknown as string }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidConfigFilePath);
  });

  it("rejects a query-string style fake path", () => {
    const error = captureError(() =>
      createFileJsonConfigStore({ filePath: `${tempDir}/config.json?x=1` }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidConfigFilePath);
  });
});

describe("task 8 file store load", () => {
  it("returns undefined when the file does not exist", async () => {
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("loads a previously saved snapshot", async () => {
    const snapshot = validSnapshot();
    await store.save(snapshot);
    const loaded = await store.load();
    expect(loaded).toEqual(snapshot);
  });

  it("throws config_file_invalid for malformed JSON", async () => {
    await writeFile(configPath, "{not json", "utf8");
    const error = await captureAsyncError(() => store.load());
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.configFileInvalid);
  });

  it("throws config_file_invalid for an empty file", async () => {
    await writeFile(configPath, "", "utf8");
    const error = await captureAsyncError(() => store.load());
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.configFileInvalid);
  });

  it("throws unsupported_config_version for unknown versions", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ version: 99, providers: [], routes: [] }),
      "utf8",
    );
    const error = await captureAsyncError(() => store.load());
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.unsupportedConfigVersion);
  });

  it("throws a stable error for a schema-invalid document", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, providers: "nope", routes: [] }),
      "utf8",
    );
    const error = await captureAsyncError(() => store.load());
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedConfig);
  });

  it("does not delete or overwrite a corrupt file on load failure", async () => {
    const corrupt = "{broken";
    await writeFile(configPath, corrupt, "utf8");
    await captureAsyncError(() => store.load());
    await expect(readFile(configPath, "utf8")).resolves.toBe(corrupt);
  });
});

describe("task 8 file store save", () => {
  it("writes atomically and round-trips", async () => {
    const snapshot = validSnapshot();
    await store.save(snapshot);
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedConfigV1;
    expect(parsed).toEqual(snapshot);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("supports UTF-8 chinese content", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(
      makeProvider({ name: "中文供应商", models: ["模型-a"] }),
    );
    registry.registerRoute(
      makeRoute({ name: "默认路由", model: "模型-a" }),
    );
    const snapshot = createConfigSnapshot(registry);

    await store.save(snapshot);
    const loaded = await store.load();
    expect(loaded?.providers[0]?.name).toBe("中文供应商");
    expect(loaded?.routes[0]?.name).toBe("默认路由");
  });

  it("supports emoji in names", async () => {
    const registry = new InMemoryProviderRegistry();
    registry.registerProvider(
      makeProvider({ name: "Emoji 🚀 Provider", models: ["model-a"] }),
    );
    const snapshot = createConfigSnapshot(registry);

    await store.save(snapshot);
    const loaded = await store.load();
    expect(loaded?.providers[0]?.name).toBe("Emoji 🚀 Provider");
  });

  it("writes multi-line pretty JSON with two-space indent", async () => {
    await store.save(validSnapshot());
    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain('\n  "version": 1');
  });

  it("leaves the previous file intact when the snapshot is invalid", async () => {
    await store.save(validSnapshot());
    const before = await readFile(configPath, "utf8");

    const error = await captureAsyncError(() =>
      store.save({ version: 1, providers: "bad", routes: [] }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.invalidPersistedConfig);

    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it("replaces the previous file on a second save", async () => {
    const first = validSnapshot();
    await store.save(first);

    const registry2 = new InMemoryProviderRegistry();
    registry2.registerProvider(
      makeProvider({ id: "second-provider", name: "Second" }),
    );
    const second = createConfigSnapshot(registry2);
    await store.save(second);

    const loaded = await store.load();
    expect(loaded?.providers).toHaveLength(1);
    expect(loaded?.providers[0]?.id).toBe("second-provider");
  });

  it("leaves no temporary files behind after a successful save", async () => {
    await store.save(validSnapshot());
    const entries = await readdir(tempDir);
    expect(entries).toEqual(["config.json"]);
  });

  it("does not leave a temp file when rename fails", async () => {
    const blockedPath = join(tempDir, "blocked");
    await writeFile(blockedPath, "not-a-dir", "utf8");
    const badStore = createFileJsonConfigStore({
      filePath: join(blockedPath, "config.json"),
    });

    const error = await captureAsyncError(() => badStore.save(validSnapshot()));
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.configFileWriteFailed);

    const entries = await readdir(tempDir);
    expect(entries).toEqual(["blocked"]);
  });
});

describe("task 8 loadProviderRegistry / saveProviderRegistry", () => {
  it("returns an empty registry when the file is missing", async () => {
    const registry = await loadProviderRegistry(store);
    expect(registry.listProviders()).toEqual([]);
    expect(registry.listRoutes()).toEqual([]);
  });

  it("saves and reloads a registry", async () => {
    const original = baseRegistry();
    await saveProviderRegistry(store, original);

    const restored = await loadProviderRegistry(store);
    expect(restored.getProvider("anthropic-main")?.credentialRef).toBe(
      "credential:anthropic-main",
    );
    expect(restored.resolveRoute("default-route").baseUrl).toBe(ANTHROPIC_URL);
  });

  it("does not modify the source registry on save", async () => {
    const original = baseRegistry();
    const before = JSON.stringify(original.listProviders());
    await saveProviderRegistry(store, original);
    expect(JSON.stringify(original.listProviders())).toBe(before);
  });

  it("throws unsupported_config_version when loading a future version", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ version: 2, providers: [], routes: [] }),
      "utf8",
    );
    const error = await captureAsyncError(() => loadProviderRegistry(store));
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.unsupportedConfigVersion);
  });

  it("throws a stable error when the file is empty", async () => {
    await writeFile(configPath, "", "utf8");
    const error = await captureAsyncError(() => loadProviderRegistry(store));
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.configFileInvalid);
  });

  it("does not partially restore when a provider is invalid", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [makeProvider(), { ...makeProvider({ id: "bad" }), apiKey: "x" }],
        routes: [],
      }),
      "utf8",
    );
    const error = await captureAsyncError(() => loadProviderRegistry(store));
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
  });

  it("does not partially restore when a route references a missing provider", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [makeProvider()],
        routes: [makeRoute({ providerId: "ghost" })],
      }),
      "utf8",
    );
    const error = await captureAsyncError(() => loadProviderRegistry(store));
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.persistedProviderNotFound);
  });

  it("keeps two file stores independent", async () => {
    const otherPath = join(tempDir, "other.json");
    const otherStore = createFileJsonConfigStore({ filePath: otherPath });

    await store.save(validSnapshot());
    await expect(otherStore.load()).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(validSnapshot());
  });
});
