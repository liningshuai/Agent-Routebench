import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryProviderRegistry,
  type ProviderDefinition,
} from "../packages/provider-registry/src/index.js";
import {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  createConfigSnapshot,
  createFileJsonConfigStore,
  InMemoryJsonConfigStore,
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
    models: ["claude-3-5-sonnet"],
    enabled: true,
    ...overrides,
  };
}

function snapshotWithProvider(id: string): PersistedConfigV1 {
  const registry = new InMemoryProviderRegistry();
  registry.registerProvider(makeProvider({ id, name: id }));
  return createConfigSnapshot(registry);
}

function captureAsyncError(run: () => Promise<unknown>): Promise<PersistenceError> {
  return run().then(
    () => {
      throw new Error("expected PersistenceError");
    },
    (error: unknown) => {
      if (error instanceof PersistenceError) {
        return error;
      }
      throw error;
    },
  );
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task8-conc-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("task 8 InMemoryJsonConfigStore", () => {
  it("starts empty", async () => {
    const store = new InMemoryJsonConfigStore();
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("round-trips a snapshot", async () => {
    const store = new InMemoryJsonConfigStore();
    const snapshot = snapshotWithProvider("alpha");
    await store.save(snapshot);
    await expect(store.load()).resolves.toEqual(snapshot);
  });

  it("returns a deep copy so caller mutation does not corrupt the store", async () => {
    const store = new InMemoryJsonConfigStore();
    const snapshot = snapshotWithProvider("alpha");
    await store.save(snapshot);

    const loaded = await store.load();
    (loaded?.providers[0] as { name: string }).name = "mutated";

    const again = await store.load();
    expect(again?.providers[0]?.name).toBe("alpha");
  });

  it("does not share arrays with the caller input", async () => {
    const store = new InMemoryJsonConfigStore();
    const snapshot = snapshotWithProvider("alpha");
    const inputModels = snapshot.providers[0]!.models as string[];
    await store.save(snapshot);

    inputModels.push("injected");
    const loaded = await store.load();
    expect(loaded?.providers[0]?.models).toEqual(["claude-3-5-sonnet"]);
  });

  it("rejects an invalid snapshot without overwriting the previous value", async () => {
    const store = new InMemoryJsonConfigStore();
    const good = snapshotWithProvider("alpha");
    await store.save(good);

    await expect(
      store.save({ version: 1, providers: "bad", routes: [] }),
    ).rejects.toBeInstanceOf(PersistenceError);

    await expect(store.load()).resolves.toEqual(good);
  });

  it("supports sequential saves", async () => {
    const store = new InMemoryJsonConfigStore();
    await store.save(snapshotWithProvider("one"));
    await store.save(snapshotWithProvider("two"));
    const loaded = await store.load();
    expect(loaded?.providers[0]?.id).toBe("two");
  });

  it("serializes concurrent saves", async () => {
    const store = new InMemoryJsonConfigStore();
    await Promise.all([
      store.save(snapshotWithProvider("first")),
      store.save(snapshotWithProvider("second")),
      store.save(snapshotWithProvider("third")),
    ]);
    const loaded = await store.load();
    expect(loaded?.providers).toHaveLength(1);
    expect(["first", "second", "third"]).toContain(loaded?.providers[0]?.id);
  });

  it("never touches the filesystem", async () => {
    const store = new InMemoryJsonConfigStore();
    await store.save(snapshotWithProvider("alpha"));
    const entries = await readdir(tempDir);
    expect(entries).toEqual([]);
  });

  it("does not perform network access", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error("network disabled");
    }) as typeof fetch;

    try {
      const store = new InMemoryJsonConfigStore();
      await store.save(snapshotWithProvider("alpha"));
      await store.load();
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("task 8 file store concurrency", () => {
  it("serializes concurrent saves on the same store", async () => {
    const configPath = join(tempDir, "config.json");
    const store = createFileJsonConfigStore({ filePath: configPath });

    const snapshots = ["a", "b", "c"].map((id) => snapshotWithProvider(id));
    await Promise.all(snapshots.map((snap) => store.save(snap)));

    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedConfigV1;
    expect(parsed.providers).toHaveLength(1);
    expect(["a", "b", "c"]).toContain(parsed.providers[0]?.id);

    const entries = await readdir(tempDir);
    expect(entries).toEqual(["config.json"]);
  });

  it("keeps two independent stores isolated", async () => {
    const pathA = join(tempDir, "a.json");
    const pathB = join(tempDir, "b.json");
    const storeA = createFileJsonConfigStore({ filePath: pathA });
    const storeB = createFileJsonConfigStore({ filePath: pathB });

    await Promise.all([
      storeA.save(snapshotWithProvider("from-a")),
      storeB.save(snapshotWithProvider("from-b")),
    ]);

    const a = JSON.parse(await readFile(pathA, "utf8")) as PersistedConfigV1;
    const b = JSON.parse(await readFile(pathB, "utf8")) as PersistedConfigV1;
    expect(a.providers[0]?.id).toBe("from-a");
    expect(b.providers[0]?.id).toBe("from-b");
  });

  it("does not mix contents across interleaved sequential saves", async () => {
    const configPath = join(tempDir, "config.json");
    const store = createFileJsonConfigStore({ filePath: configPath });

    for (const id of ["one", "two", "three", "four"]) {
      await store.save(snapshotWithProvider(id));
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedConfigV1;
      expect(parsed.providers[0]?.id).toBe(id);
      const entries = await readdir(tempDir);
      expect(entries).toEqual(["config.json"]);
    }
  });

  it("reports a stable code when concurrent invalid saves fail", async () => {
    const configPath = join(tempDir, "config.json");
    const store = createFileJsonConfigStore({ filePath: configPath });
    await store.save(snapshotWithProvider("keep"));

    const results = await Promise.allSettled([
      store.save({ version: 1, providers: [], routes: [] }),
      store.save({ version: 1, providers: "bad", routes: [] }),
    ]);

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    if (results[1]?.status === "rejected") {
      expect((results[1].reason as PersistenceError).code).toBe(
        PERSISTENCE_ERROR_CODES.invalidPersistedConfig,
      );
    }

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      providers: [],
      routes: [],
    });
  });
});

describe("task 8 recovery isolation", () => {
  it("rejects an invalid snapshot without creating a store value", async () => {
    const store = new InMemoryJsonConfigStore();
    const error = await captureAsyncError(() =>
      store.save({
        version: 1,
        providers: [{ ...makeProvider(), secret: "nope" }],
        routes: [],
      }),
    );
    expect(error.code).toBe(PERSISTENCE_ERROR_CODES.forbiddenPersistedField);
    await expect(store.load()).resolves.toBeUndefined();
  });
});
