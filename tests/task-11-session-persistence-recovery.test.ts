import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalAgentApiServer } from "../packages/local-agent-api/src/index.js";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import {
  createFileLocalAgentSessionStore,
} from "../packages/session-persistence/src/index.js";
import {
  completedEvent,
  getSafeLoopbackPort,
  makeKey,
  userEvent,
  withTempDir,
} from "./helpers/session-persistence-fixtures.js";

describe("task 11 recovery", () => {
  it("rejects a wrong encryption key", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const keyA = makeKey();
      const keyB = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: keyA,
      });
      storeA.create();
      expect(() =>
        createFileLocalAgentSessionStore({
          filePath,
          encryptionKey: keyB,
        }),
      ).toThrow(/file is invalid/);
    });
  });

  it("rejects a tampered authTag", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      store.create();
      const raw = readFileSync(filePath, "utf8");
      const envelope = JSON.parse(raw) as { authTag: string };
      const tag = Buffer.from(envelope.authTag, "base64");
      tag[0] = (tag[0] ?? 0) ^ 0xff;
      envelope.authTag = tag.toString("base64");
      writeFileSync(filePath, JSON.stringify(envelope), "utf8");
      expect(() =>
        createFileLocalAgentSessionStore({ filePath, encryptionKey: key }),
      ).toThrow(/file is invalid/);
    });
  });

  it("recovers sessions and events after a simulated restart", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      storeA.appendEvent(session.id, userEvent("alpha"));
      storeA.appendEvent(session.id, completedEvent());
      storeA.setStatus(session.id, "completed");

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      expect(storeB.get(session.id)).toMatchObject({
        id: session.id,
        status: "completed",
      });
      expect(storeB.listEvents(session.id)).toHaveLength(2);
    });
  });

  it("converts running sessions to failed on load", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      storeA.appendEvent(session.id, userEvent("mid-turn"));
      storeA.setStatus(session.id, "running", "turn-9");

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const recovered = storeB.get(session.id);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.activeTurnId).toBeUndefined();
      expect(storeB.listEvents(session.id)).toHaveLength(1);
    });
  });

  it("does not leave running sessions after recovery save", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      storeA.setStatus(session.id, "running", "turn-1");

      createFileLocalAgentSessionStore({ filePath, encryptionKey: key });

      const storeC = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      expect(storeC.get(session.id)?.status).toBe("failed");
    });
  });

  it("uses a fresh IV when saving identical plaintext", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      // Fixed clock keeps createdAt/updatedAt identical across saves.
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
        clock: () => 1000,
        idFactory: () => "fixed-session-id",
      });
      const session = store.create();
      // First save already happened inside create(); read its envelope.
      const firstEnvelope = JSON.parse(readFileSync(filePath, "utf8")) as {
        iv: string;
      };

      // setStatus("idle") on an already-idle session with a fixed clock
      // produces byte-identical plaintext JSON, so only the IV can differ.
      store.setStatus(session.id, "idle");
      const secondEnvelope = JSON.parse(readFileSync(filePath, "utf8")) as {
        iv: string;
      };

      expect(firstEnvelope.iv).not.toBe(secondEnvelope.iv);
    });
  });

  it("keeps no temp files after successful writes", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: makeKey(),
      });
      const session = store.create();
      store.appendEvent(session.id, userEvent("x"));
      const entries = readdirSync(dir);
      expect(entries).toEqual(["s.json"]);
    });
  });

  it("keeps the previous file when a save fails mid-write", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = store.create();
      store.appendEvent(session.id, userEvent("keep-me"));
      const before = readFileSync(filePath, "utf8");

      // Replace the file with a directory so rename fails.
      const { rmSync, mkdirSync } = await import("node:fs");
      rmSync(filePath, { force: true });
      mkdirSync(filePath);

      expect(() =>
        store.appendEvent(session.id, userEvent("should-fail")),
      ).toThrow(/write failed/);

      // Restore a file for cleanup.
      rmSync(filePath, { recursive: true, force: true });
      writeFileSync(filePath, before, "utf8");
      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      expect(storeB.listEvents(session.id)).toHaveLength(1);
    });
  });

  it("rolls back memory when a save fails", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: makeKey(),
      });
      const session = store.create();
      store.appendEvent(session.id, userEvent("first"));
      expect(store.listEvents(session.id)).toHaveLength(1);

      const { rmSync, mkdirSync } = await import("node:fs");
      rmSync(filePath, { force: true });
      mkdirSync(filePath);

      expect(() =>
        store.appendEvent(session.id, userEvent("second")),
      ).toThrow(/write failed/);
      expect(store.listEvents(session.id)).toHaveLength(1);

      rmSync(filePath, { recursive: true, force: true });
    });
  });

  it("rejects a plaintext file that is not an envelope", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          sessions: [{ id: "x", status: "idle", createdAt: 1, updatedAt: 1, events: [] }],
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
});

describe("task 11 local agent API integration", () => {
  it("restores sessions across API server instances", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "sessions.enc");
      const key = makeKey();

      const runnerEvents: AgentEvent[] = [
        userEvent("hello-from-api"),
        completedEvent(),
      ];

      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const portA = await getSafeLoopbackPort();
      const serverA = createLocalAgentApiServer({
        host: "127.0.0.1",
        port: portA,
        runner: {
          async run() {
            return {
              async *[Symbol.asyncIterator]() {
                for (const event of runnerEvents) {
                  yield event;
                }
              },
            };
          },
        },
        store: storeA,
      });
      await serverA.start();
      const address = serverA.address();
      const port = Number(address?.slice(address.lastIndexOf(":") + 1));

      const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const createdBody = (await created.json()) as {
        session: { id: string };
      };
      const sessionId = createdBody.session.id;

      const turnRes = await fetch(
        `http://127.0.0.1:${port}/v1/sessions/${sessionId}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/x-ndjson",
          },
          body: JSON.stringify({
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }] },
            ],
          }),
        },
      );
      expect(turnRes.status).toBe(200);
      await turnRes.text();
      await serverA.close();

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const configuredPortB = await getSafeLoopbackPort();
      const serverB = createLocalAgentApiServer({
        host: "127.0.0.1",
        port: configuredPortB,
        runner: {
          async run() {
            return {
              async *[Symbol.asyncIterator]() {
                yield completedEvent();
              },
            };
          },
        },
        store: storeB,
      });
      await serverB.start();
      const addressB = serverB.address();
      const portB = Number(addressB?.slice(addressB.lastIndexOf(":") + 1));

      const sessionRes = await fetch(
        `http://127.0.0.1:${portB}/v1/sessions/${sessionId}`,
      );
      expect(sessionRes.status).toBe(200);
      const sessionBody = (await sessionRes.json()) as {
        session: { id: string; status: string };
      };
      expect(sessionBody.session.id).toBe(sessionId);
      expect(sessionBody.session.status).toBe("completed");

      const eventsRes = await fetch(
        `http://127.0.0.1:${portB}/v1/sessions/${sessionId}/events`,
      );
      expect(eventsRes.status).toBe(200);
      const eventsBody = (await eventsRes.json()) as {
        events: { type: string; text?: string }[];
      };
      expect(eventsBody.events.length).toBeGreaterThan(0);
      expect(
        eventsBody.events.some(
          (e) => e.type === "text_delta" && e.text === "hello-from-api",
        ),
      ).toBe(true);

      await serverB.close();
    });
  });
});
