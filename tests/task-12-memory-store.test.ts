import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryStore,
  DEFAULT_MAX_MEMORY_CONTENT_BYTES,
  DEFAULT_MAX_MEMORY_ENTRIES_PER_SCOPE,
  DEFAULT_MAX_MEMORY_TAGS,
  DEFAULT_MAX_MEMORY_TAG_BYTES,
  MAX_MEMORY_CONTENT_BYTES_LIMIT,
  MAX_MEMORY_ENTRIES_PER_SCOPE_LIMIT,
  MAX_MEMORY_TAGS_LIMIT,
  MAX_MEMORY_TAG_BYTES_LIMIT,
  MEMORY_ERROR_CODES,
  MemoryError,
} from "../packages/agent-memory/src/index.js";
import { makeMemoryStore, saveFact } from "./helpers/memory-fixtures.js";

describe("task 12 memory store basics", () => {
  it("exports public default limits", () => {
    expect(DEFAULT_MAX_MEMORY_ENTRIES_PER_SCOPE).toBe(128);
    expect(DEFAULT_MAX_MEMORY_CONTENT_BYTES).toBe(16 * 1024);
    expect(DEFAULT_MAX_MEMORY_TAGS).toBe(16);
    expect(DEFAULT_MAX_MEMORY_TAG_BYTES).toBe(128);
    expect(MAX_MEMORY_ENTRIES_PER_SCOPE_LIMIT).toBe(4096);
    expect(MAX_MEMORY_CONTENT_BYTES_LIMIT).toBe(256 * 1024);
    expect(MAX_MEMORY_TAGS_LIMIT).toBe(64);
    expect(MAX_MEMORY_TAG_BYTES_LIMIT).toBe(1024);
  });

  it("creates an empty store", () => {
    const store = makeMemoryStore();
    expect(store.list("scope-a")).toEqual([]);
    expect(store.get("scope-a", "id-1")).toBeUndefined();
  });

  it("saves a new entry with generated id", () => {
    let n = 0;
    const store = makeMemoryStore({
      clock: () => 1000,
      idFactory: () => `mem-${String(++n)}`,
    });
    const entry = store.save({
      scopeId: "scope-a",
      kind: "fact",
      content: "likes TypeScript",
    });
    expect(entry.id).toBe("mem-1");
    expect(entry.createdAt).toBe(1000);
    expect(entry.updatedAt).toBe(1000);
    expect(entry.tags).toEqual([]);
  });

  it("updates an existing entry and preserves createdAt", async () => {
    let now = 1000;
    const store = makeMemoryStore({ clock: () => now });
    const first = saveFact(store, "scope-a", "original");
    now = 2000;
    const second = store.save({
      id: first.id,
      scopeId: "scope-a",
      kind: "fact",
      content: "updated",
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(1000);
    expect(second.updatedAt).toBe(2000);
    expect(second.content).toBe("updated");
  });

  it("does not overwrite entries across scopes", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    saveFact(store, "scope-a", "from-a");
    store.save({ id: "id-1", scopeId: "scope-b", kind: "fact", content: "from-b" });
    expect(store.get("scope-a", "id-1")?.content).toBe("from-a");
    expect(store.get("scope-b", "id-1")?.content).toBe("from-b");
  });

  it("lists only the requested scope", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    saveFact(store, "scope-a", "a1");
    saveFact(store, "scope-b", "b1");
    expect(store.list("scope-a")).toHaveLength(1);
    expect(store.list("scope-b")).toHaveLength(1);
  });

  it("lists by updatedAt DESC then id ASC", () => {
    let now = 1000;
    let n = 0;
    const store = makeMemoryStore({
      clock: () => now,
      idFactory: () => `id-${String(++n)}`,
    });
    saveFact(store, "scope-a", "first", [], "fact");
    now = 2000;
    saveFact(store, "scope-a", "second", [], "preference");
    now = 2000;
    saveFact(store, "scope-a", "third", [], "decision");
    const listed = store.list("scope-a");
    expect(listed).toHaveLength(3);
    // second and third share updatedAt=2000 → id ASC; first last.
    expect(listed[0]?.content).toBe("second");
    expect(listed[1]?.content).toBe("third");
    expect(listed[2]?.content).toBe("first");
  });

  it("searches content and tags deterministically", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    saveFact(store, "scope-a", "user prefers TypeScript", ["typescript"]);
    saveFact(store, "scope-a", "uses pnpm", ["package"]);
    saveFact(store, "scope-a", "offline tests only", ["testing", "typescript"]);

    const results = store.search("scope-a", "typescript offline");
    expect(results).toHaveLength(2);
    // offline-tests hits 2 tokens; prefers-typescript hits 1.
    expect(results[0]?.content).toBe("offline tests only");
    expect(results[1]?.content).toBe("user prefers TypeScript");
  });

  it("does not search across scopes", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    saveFact(store, "scope-a", "secret fact");
    expect(store.search("scope-b", "secret")).toEqual([]);
  });

  it("applies search limit default 20", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    for (let i = 0; i < 25; i += 1) {
      saveFact(store, "scope-a", `item ${String(i)}`);
    }
    expect(store.search("scope-a", "item")).toHaveLength(20);
    expect(store.search("scope-a", "item", { limit: 5 })).toHaveLength(5);
  });

  it("rejects invalid search limit", () => {
    const store = makeMemoryStore();
    expect(() => store.search("scope-a", "q", { limit: 0 })).toThrow(MemoryError);
    expect(() => store.search("scope-a", "q", { limit: 65 })).toThrow(/query is invalid/);
    expect(() => store.search("scope-a", "")).toThrow(/query is invalid/);
  });

  it("deletes an entry and returns boolean", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    const entry = saveFact(store, "scope-a", "x");
    expect(store.delete("scope-a", entry.id)).toBe(true);
    expect(store.delete("scope-a", entry.id)).toBe(false);
  });

  it("clears only the requested scope", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    saveFact(store, "scope-a", "a1");
    saveFact(store, "scope-a", "a2");
    saveFact(store, "scope-b", "b1");
    expect(store.clear("scope-a")).toBe(2);
    expect(store.list("scope-a")).toEqual([]);
    expect(store.list("scope-b")).toHaveLength(1);
  });

  it("returns defensive copies from get and list", () => {
    let n = 0;
    const store = makeMemoryStore({ idFactory: () => `id-${String(++n)}` });
    const entry = saveFact(store, "scope-a", "keep", ["tag-a"]);
    const copy = store.get("scope-a", entry.id) as unknown as { content: string; tags: string[] };
    copy.content = "mutated";
    copy.tags.push("injected");
    const listed = store.list("scope-a")[0] as { content: string };
    listed.content = "mutated-list";
    expect(store.get("scope-a", entry.id)?.content).toBe("keep");
    expect(store.get("scope-a", entry.id)?.tags).toEqual(["tag-a"]);
  });

  it("does not keep a reference to caller tags", () => {
    const store = makeMemoryStore();
    const tags = ["alpha"];
    const entry = store.save({
      scopeId: "scope-a",
      kind: "fact",
      content: "x",
      tags,
    });
    tags.push("beta");
    expect(entry.tags).toEqual(["alpha"]);
    expect(store.get("scope-a", entry.id)?.tags).toEqual(["alpha"]);
  });

  it("rejects invalid constructor options", () => {
    expect(() => new InMemoryMemoryStore({ maxEntriesPerScope: 0 })).toThrow(
      /options are invalid/,
    );
    expect(() => new InMemoryMemoryStore({ maxContentBytes: 1.5 })).toThrow(
      /options are invalid/,
    );
    expect(() => new InMemoryMemoryStore({ maxTagsPerEntry: -1 })).toThrow(
      /options are invalid/,
    );
    expect(
      () =>
        new InMemoryMemoryStore({
          maxEntriesPerScope: MAX_MEMORY_ENTRIES_PER_SCOPE_LIMIT + 1,
        }),
    ).toThrow(/options are invalid/);
  });

  it("rejects entries exceeding scope limit", () => {
    const store = makeMemoryStore({ maxEntriesPerScope: 1 });
    saveFact(store, "scope-a", "one");
    expect(() => saveFact(store, "scope-a", "two")).toThrow(/limit exceeded/);
  });

  it("rejects content exceeding byte limit", () => {
    const store = makeMemoryStore({ maxContentBytes: 8 });
    expect(() => saveFact(store, "scope-a", "x".repeat(50))).toThrow(
      /entry is invalid/,
    );
  });

  it("rejects unknown top-level fields", () => {
    const store = makeMemoryStore();
    expect(() =>
      store.save({
        scopeId: "scope-a",
        kind: "fact",
        content: "x",
        metadata: { extra: true },
      } as never),
    ).toThrow(/entry is invalid/);
  });

  it("rejects sensitive unknown fields", () => {
    const store = makeMemoryStore();
    for (const field of [
      "apiKey",
      "token",
      "authorization",
      "headers",
      "password",
      "secret",
      "credential",
    ]) {
      expect(() =>
        store.save({
          scopeId: "scope-a",
          kind: "fact",
          content: "x",
          [field]: "nope",
        } as never),
      ).toThrow(/entry is invalid/);
    }
  });

  it("uses fixed error messages without echoing input", () => {
    const store = makeMemoryStore();
    let message = "";
    try {
      store.save({ scopeId: "", kind: "fact", content: "TOP_SECRET_VALUE" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Memory entry is invalid.");
    expect(message).not.toContain("TOP_SECRET_VALUE");
  });

  it("exports stable error codes", () => {
    expect(MEMORY_ERROR_CODES.invalidEntry).toBe("invalid_memory_entry");
    expect(MEMORY_ERROR_CODES.invalidOptions).toBe("invalid_memory_options");
    expect(MEMORY_ERROR_CODES.invalidQuery).toBe("invalid_memory_query");
    expect(MEMORY_ERROR_CODES.memoryLimitExceeded).toBe("memory_limit_exceeded");
  });
});
