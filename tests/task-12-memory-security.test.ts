import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ContextError,
  InMemoryMemoryStore,
  buildContext,
} from "../packages/agent-memory/src/index.js";
import {
  makeMemoryEntry,
  makeMemoryStore,
  userText,
} from "./helpers/memory-fixtures.js";

const pkgRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "agent-memory",
);

describe("task 12 memory security", () => {
  it("source avoids forbidden runtime APIs", () => {
    const files = [
      "src/types.ts",
      "src/errors.ts",
      "src/memory-store.ts",
      "src/context-validation.ts",
      "src/context-builder.ts",
      "src/index.ts",
    ];
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, file), "utf8");
      expect(text).not.toMatch(/process\.env/);
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(/axios/);
      expect(text).not.toMatch(/undici/);
      expect(text).not.toMatch(/node:http/);
      expect(text).not.toMatch(/node:https/);
      expect(text).not.toMatch(/node:fs/);
      expect(text).not.toMatch(/WebSocket/);
      expect(text).not.toMatch(/keytar/);
      expect(text).not.toMatch(/sqlite/);
      expect(text).not.toMatch(/child_process/);
      expect(text).not.toMatch(/console\.(log|error)/);
    }
  });

  it("package depends only on agent-core", () => {
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([
      "@agent-workbench/agent-core",
    ]);
  });

  it("does not use cross-package src path imports", () => {
    const files = [
      "src/types.ts",
      "src/errors.ts",
      "src/memory-store.ts",
      "src/context-validation.ts",
      "src/context-builder.ts",
      "src/index.ts",
    ];
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, file), "utf8");
      expect(text).not.toMatch(
        /\.\.\/\.\.\/(agent-core|model-gateway|session-persistence)\/src/,
      );
    }
  });

  it("does not echo content in validation errors", () => {
    const store = makeMemoryStore();
    let message = "";
    try {
      store.save({
        scopeId: "scope-a",
        kind: "fact",
        content: "SECRET_MARKER_XYZ",
      });
      store.save({
        scopeId: "scope-a",
        kind: "fact",
        content: "ok",
        tags: [""],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("SECRET_MARKER_XYZ");
  });

  it("does not echo scopeId or id in errors", () => {
    const store = makeMemoryStore();
    let message = "";
    try {
      store.save({ scopeId: "/etc/passwd", kind: "fact", content: "x" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("/etc/passwd");
  });

  it("rejects sensitive fields on memory input without echoing them", () => {
    const store = makeMemoryStore();
    let message = "";
    try {
      store.save({
        scopeId: "scope-a",
        kind: "fact",
        content: "x",
        authorization: "Bearer TOP_SECRET",
      } as never);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("TOP_SECRET");
  });

  it("rejects sensitive fields in context options", async () => {
    await expect(
      buildContext({
        messages: [userText("hi")],
        maxContextBytes: 1000,
        apiKey: "sk-secret",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_context_options" });
  });

  it("rejects sensitive fields inside memory entries used by context", async () => {
    await expect(
      buildContext({
        messages: [userText("hi")],
        memoryEntries: [
          {
            id: "m1",
            scopeId: "s",
            kind: "fact",
            content: "x",
            tags: [],
            createdAt: 1,
            updatedAt: 1,
            secret: "nope",
          },
        ] as never,
        maxContextBytes: 10000,
      }),
    ).rejects.toMatchObject({ code: "invalid_context_memory" });
  });

  it("does not call fetch during memory operations", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error("network disabled");
    }) as typeof fetch;
    try {
      const store = new InMemoryMemoryStore();
      store.save({ scopeId: "s", kind: "fact", content: "x" });
      store.search("s", "x");
      await buildContext({ messages: [userText("hi")], maxContextBytes: 5000 });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not write memory to the filesystem", () => {
    // In-memory only by construction: no fs import exists in the package.
    const files = ["src/memory-store.ts", "src/context-builder.ts"];
    for (const file of files) {
      expect(readFileSync(join(pkgRoot, file), "utf8")).not.toMatch(
        /node:fs/,
      );
    }
  });
});

describe("task 12 final fix: memory entry runtime validation", () => {
  async function expectMemoryRejectedWith(
    entry: unknown,
  ): Promise<ContextError> {
    let caught: unknown;
    let resolved: unknown;
    try {
      resolved = await buildContext({
        messages: [userText("hi")],
        memoryEntries: [entry] as never,
        maxContextBytes: 40_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(ContextError);
    expect((caught as ContextError).code).toBe("invalid_context_memory");
    expect((caught as ContextError).message).toBe("Context memory is invalid.");
    return caught as ContextError;
  }

  it("rejects a numeric tag", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ tags: [123 as never] }));
  });

  it("rejects a boolean tag", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ tags: [true as never] }));
  });

  it("rejects a null tag", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ tags: [null as never] }));
  });

  it("rejects an object tag and nested arrays", async () => {
    await expectMemoryRejectedWith(
      makeMemoryEntry({ tags: [{ evil: true } as never] }),
    );
    await expectMemoryRejectedWith(
      makeMemoryEntry({ tags: [["nested"] as never] }),
    );
  });

  it("rejects an empty-string tag", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ tags: [""] }));
  });

  it("rejects duplicate tags", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ tags: ["dup", "dup"] }));
  });

  it("rejects a tag containing a NUL byte", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ tags: ["a\0b"] }));
  });

  it("rejects a tag exceeding 128 UTF-8 bytes", async () => {
    await expectMemoryRejectedWith(
      makeMemoryEntry({ tags: ["t".repeat(129)] }),
    );
  });

  it("rejects more than 16 tags on one entry", async () => {
    await expectMemoryRejectedWith(
      makeMemoryEntry({
        tags: Array.from({ length: 17 }, (_, i) => `tag-${String(i)}`),
      }),
    );
  });

  it("rejects an id with illegal characters", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ id: "../evil" }));
  });

  it("rejects an id longer than 64 characters", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ id: "a".repeat(65) }));
  });

  it("rejects an illegal scopeId", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ scopeId: "has space" }));
  });

  it("rejects content exceeding the 16 KiB UTF-8 byte limit", async () => {
    await expectMemoryRejectedWith(
      makeMemoryEntry({ content: "x".repeat(16 * 1024 + 1) }),
    );
  });

  it("rejects content containing a NUL byte", async () => {
    await expectMemoryRejectedWith(makeMemoryEntry({ content: "a\0b" }));
  });

  it("rejects a non-finite createdAt", async () => {
    await expectMemoryRejectedWith(
      makeMemoryEntry({ createdAt: Number.NaN }),
    );
  });

  it("rejects an infinite updatedAt", async () => {
    await expectMemoryRejectedWith(
      makeMemoryEntry({ updatedAt: Number.POSITIVE_INFINITY }),
    );
  });

  it("rejects unknown fields such as providerId", async () => {
    await expectMemoryRejectedWith({
      ...makeMemoryEntry(),
      providerId: "anthropic",
    });
  });

  it("rejects sensitive fields without echoing their values", async () => {
    const error = await expectMemoryRejectedWith({
      ...makeMemoryEntry(),
      apiKey: "sk-TOP-SECRET-VALUE",
    });
    expect(error.message).not.toContain("sk-TOP-SECRET-VALUE");
  });

  it("does not echo rejected ids, content or tags in the error", async () => {
    const error = await expectMemoryRejectedWith(
      makeMemoryEntry({
        id: "LEAK_MARKER_ID with spaces",
        content: "LEAK_MARKER_CONTENT https://leak.invalid/path",
        tags: ["LEAK_MARKER_TAG"],
      }),
    );
    expect(error.message).toBe("Context memory is invalid.");
    expect(error.message).not.toContain("LEAK_MARKER_ID");
    expect(error.message).not.toContain("LEAK_MARKER_CONTENT");
    expect(error.message).not.toContain("LEAK_MARKER_TAG");
    expect(error.message).not.toContain("leak.invalid");
  });

  it("still injects a valid memory entry into the context", async () => {
    const result = await buildContext({
      messages: [userText("hi")],
      memoryEntries: [makeMemoryEntry()],
      maxContextBytes: 10_000,
    });
    expect(result.compressed).toBe(false);
    expect(result.includedMemoryIds).toEqual(["mem-1"]);
    const text = result.messages[0]?.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(text).toContain("[fact] likes TypeScript");
  });

  it("accepts boundary-sized valid entries", async () => {
    const entry = makeMemoryEntry({
      id: "a".repeat(64),
      content: "x".repeat(16 * 1024),
      tags: ["t".repeat(128), ...Array.from({ length: 15 }, (_, i) => `tag-${String(i)}`)],
    });
    const result = await buildContext({
      messages: [userText("hi")],
      memoryEntries: [entry],
      maxContextBytes: 40_000,
    });
    expect(result.compressed).toBe(false);
    expect(result.includedMemoryIds).toEqual(["a".repeat(64)]);
  });
});
