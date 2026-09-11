import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLocalAgentSessionStore } from "../packages/session-persistence/src/index.js";
import {
  makeKey,
  userEvent,
  withTempDir,
} from "./helpers/session-persistence-fixtures.js";

describe("task 11 session persistence concurrency", () => {
  it("serializes rapid appends on one store", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = store.create();
      for (let i = 0; i < 20; i += 1) {
        store.appendEvent(session.id, userEvent(`e-${String(i)}`));
      }
      expect(store.listEvents(session.id)).toHaveLength(20);

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      expect(storeB.listEvents(session.id)).toHaveLength(20);
      const events = storeB.listEvents(session.id) as unknown as { text: string }[];
      expect(events[0]?.text).toBe("e-0");
      expect(events[19]?.text).toBe("e-19");
    });
  });

  it("keeps two stores on different files isolated", async () => {
    await withTempDir(async (dir) => {
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath: join(dir, "a.json"),
        encryptionKey: key,
      });
      const storeB = createFileLocalAgentSessionStore({
        filePath: join(dir, "b.json"),
        encryptionKey: key,
      });
      const a = storeA.create();
      const b = storeB.create();
      storeA.appendEvent(a.id, userEvent("from-a"));
      storeB.appendEvent(b.id, userEvent("from-b"));

      expect(storeA.listEvents(a.id)[0]).toMatchObject({ text: "from-a" });
      expect(storeA.listEvents(b.id)).toEqual([]);
      expect(storeB.listEvents(b.id)[0]).toMatchObject({ text: "from-b" });
      expect(storeB.listEvents(a.id)).toEqual([]);
    });
  });

  it("keeps two stores on the same file consistent after sequential writes", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      storeA.appendEvent(session.id, userEvent("one"));

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      // storeB loaded the state after "one".
      expect(storeB.listEvents(session.id)).toHaveLength(1);
      storeB.appendEvent(session.id, userEvent("two"));
      expect(storeB.listEvents(session.id)).toHaveLength(2);

      const storeC = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      expect(storeC.listEvents(session.id)).toHaveLength(2);
    });
  });

  it("preserves event order under interleaved create/append", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const s1 = store.create();
      const s2 = store.create();
      store.appendEvent(s1.id, userEvent("s1-a"));
      store.appendEvent(s2.id, userEvent("s2-a"));
      store.appendEvent(s1.id, userEvent("s1-b"));
      store.appendEvent(s2.id, userEvent("s2-b"));

      expect(
        store.listEvents(s1.id).map((e) => (e as { text: string }).text),
      ).toEqual(["s1-a", "s1-b"]);
      expect(
        store.listEvents(s2.id).map((e) => (e as { text: string }).text),
      ).toEqual(["s2-a", "s2-b"]);

      const raw = readFileSync(filePath, "utf8");
      expect(raw).toContain("aes-256-gcm");
      expect(raw).not.toContain("s1-a");
      expect(raw).not.toContain("s2-a");
    });
  });

  it("does not mix ciphertext from concurrent-looking sequential saves", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = store.create();
      for (let i = 0; i < 10; i += 1) {
        store.appendEvent(session.id, userEvent(`n-${String(i)}`));
      }
      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const texts = storeB
        .listEvents(session.id)
        .map((e) => (e as { text: string }).text);
      expect(texts).toEqual([
        "n-0",
        "n-1",
        "n-2",
        "n-3",
        "n-4",
        "n-5",
        "n-6",
        "n-7",
        "n-8",
        "n-9",
      ]);
    });
  });
});
