import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFileLocalAgentSessionStore,
} from "../packages/session-persistence/src/index.js";
import {
  makeKey,
  userEvent,
  withTempDir,
} from "./helpers/session-persistence-fixtures.js";

const pkgRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "session-persistence",
);

const MARKER = "PLAINTEXT_MARKER_DO_NOT_LEAK";

describe("task 11 session persistence security", () => {
  it("source avoids forbidden runtime APIs", () => {
    const files = [
      "src/types.ts",
      "src/errors.ts",
      "src/crypto.ts",
      "src/validation.ts",
      "src/file-session-store.ts",
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
      expect(text).not.toMatch(/WebSocket/);
      expect(text).not.toMatch(/node:child_process/);
      expect(text).not.toMatch(/sqlite/);
      expect(text).not.toMatch(/keytar/);
      expect(text).not.toMatch(/console\.(log|error)/);
    }
  });

  it("package depends only on agent-core and local-agent-api", () => {
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@agent-workbench/agent-core",
      "@agent-workbench/local-agent-api",
    ]);
  });

  it("does not use cross-package src path imports", () => {
    const files = [
      "src/types.ts",
      "src/errors.ts",
      "src/crypto.ts",
      "src/validation.ts",
      "src/file-session-store.ts",
      "src/index.ts",
    ];
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, file), "utf8");
      expect(text).not.toMatch(
        /\.\.\/\.\.\/(local-agent-api|agent-core|local-persistence)\/src/,
      );
    }
  });

  it("never calls global fetch", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error("network disabled");
    }) as typeof fetch;
    try {
      await withTempDir(async (dir) => {
        const store = createFileLocalAgentSessionStore({
          filePath: join(dir, "s.json"),
          encryptionKey: makeKey(),
        });
        const session = store.create();
        store.appendEvent(session.id, userEvent("hello"));
        store.get(session.id);
        expect(calls).toEqual([]);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not write the encryption key into the file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const keyBase64 = Buffer.from(key).toString("base64");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = store.create();
      store.appendEvent(session.id, userEvent("secret-ish"));
      const raw = readFileSync(filePath, "utf8");
      expect(raw).not.toContain(keyBase64);
      expect(raw).not.toContain(Buffer.from(key).toString("hex"));
    });
  });

  it("does not write plaintext event content", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: makeKey(),
      });
      const session = store.create();
      store.appendEvent(session.id, userEvent(MARKER));
      store.appendEvent(session.id, {
        type: "error",
        requestId: "req-1",
        code: "runner_error",
        message: MARKER,
        retryable: false,
      });
      const raw = readFileSync(filePath, "utf8");
      expect(raw).not.toContain(MARKER);
      expect(raw).not.toContain("runner_error");
      expect(raw).not.toContain(session.id);
    });
  });

  it("does not echo the file path in errors", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: makeKey(),
      });
      store.create();
      let message = "";
      try {
        // Re-open with a wrong key to trigger decrypt failure on next create.
        const wrong = createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: makeKey(),
        });
        wrong.create();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // Decrypt failure may or may not throw depending on implementation;
      // if it does, the message must not leak the path.
      if (message.length > 0) {
        expect(message).not.toContain(dir);
        expect(message).not.toContain("s.json");
      }
    });
  });

  it("rejects a corrupted ciphertext without leaking contents", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      store.create();
      const raw = readFileSync(filePath, "utf8");
      const envelope = JSON.parse(raw) as { ciphertext: string };
      const bytes = Buffer.from(envelope.ciphertext, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      const tampered = JSON.stringify({
        ...envelope,
        ciphertext: bytes.toString("base64"),
      });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filePath, tampered, "utf8");

      let message = "";
      try {
        createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: key,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(dir);
      expect(message).not.toContain("ciphertext");
      expect(message).not.toMatch(/stack/i);
    });
  });

  it("rejects an empty file", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filePath, "", "utf8");
      expect(() =>
        createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: makeKey(),
        }),
      ).toThrow(/file is invalid/);
    });
  });

  it("rejects malformed JSON envelope", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filePath, "{not-json", "utf8");
      expect(() =>
        createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: makeKey(),
        }),
      ).toThrow(/file is invalid/);
    });
  });

  it("rejects an envelope with unknown fields", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          algorithm: "aes-256-gcm",
          iv: "AAAAAAAAAAAAAAAA",
          authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
          ciphertext: "AAAA",
          extra: "nope",
        }),
        "utf8",
      );
      expect(() =>
        createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: makeKey(),
        }),
      ).toThrow(/file is invalid/);
    });
  });

  it("rejects a wrong algorithm", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: makeKey(),
      });
      store.create();
      const raw = readFileSync(filePath, "utf8");
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      envelope.algorithm = "aes-128-gcm";
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filePath, JSON.stringify(envelope), "utf8");
      expect(() =>
        createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: makeKey(),
        }),
      ).toThrow(/file is invalid/);
    });
  });
});
