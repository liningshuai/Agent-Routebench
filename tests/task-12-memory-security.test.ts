import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryStore,
  buildContext,
} from "../packages/agent-memory/src/index.js";
import { makeMemoryStore, userText } from "./helpers/memory-fixtures.js";

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
