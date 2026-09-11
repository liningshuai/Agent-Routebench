import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileLocalAgentSessionStore,
  DEFAULT_MAX_EVENTS_PER_SESSION,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_SESSION_FILE_BYTES,
  MAX_EVENTS_PER_SESSION_LIMIT,
  MAX_EVENT_BYTES_LIMIT,
  MAX_SESSIONS_LIMIT,
  MAX_SESSION_FILE_BYTES_LIMIT,
} from "../packages/session-persistence/src/index.js";
import {
  completedEvent,
  makeKey,
  toolCallEvent,
  usageEvent,
  userEvent,
  withTempDir,
} from "./helpers/session-persistence-fixtures.js";

describe("task 11 session persistence basics", () => {
  it("rejects null options", () => {
    expect(() =>
      createFileLocalAgentSessionStore(null as never),
    ).toThrow(/options are invalid/);
  });

  it("rejects array options", () => {
    expect(() =>
      createFileLocalAgentSessionStore([] as never),
    ).toThrow(/options are invalid/);
  });

  it("rejects string options", () => {
    expect(() =>
      createFileLocalAgentSessionStore("nope" as never),
    ).toThrow(/options are invalid/);
  });

  it("rejects a non-absolute filePath", () => {
    expect(() =>
      createFileLocalAgentSessionStore({
        filePath: "relative.json",
        encryptionKey: makeKey(),
      }),
    ).toThrow(/options are invalid/);
  });

  it("rejects a non-Uint8Array encryptionKey", () => {
    expect(() =>
      createFileLocalAgentSessionStore({
        filePath: "/tmp/x.json",
        encryptionKey: "string-key" as never,
      }),
    ).toThrow(/options are invalid/);
  });

  it("rejects a short encryptionKey", () => {
    expect(() =>
      createFileLocalAgentSessionStore({
        filePath: "/tmp/x.json",
        encryptionKey: new Uint8Array(16),
      }),
    ).toThrow(/options are invalid/);
  });

  it("rejects a long encryptionKey", () => {
    expect(() =>
      createFileLocalAgentSessionStore({
        filePath: "/tmp/x.json",
        encryptionKey: new Uint8Array(64),
      }),
    ).toThrow(/options are invalid/);
  });

  it("creates an empty store when the file is missing", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "missing.json"),
        encryptionKey: makeKey(),
      });
      expect(store.create()).toMatchObject({ status: "idle" });
    });
  });

  it("creates a session with idle status and empty events", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.status).toBe("idle");
      expect(typeof session.createdAt).toBe("number");
      expect(typeof session.updatedAt).toBe("number");
      expect(store.listEvents(session.id)).toEqual([]);
    });
  });

  it("persists session metadata across store instances", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      expect(storeB.get(session.id)).toMatchObject({
        id: session.id,
        status: "idle",
      });
    });
  });

  it("persists events across store instances", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      storeA.appendEvent(session.id, userEvent("hello"));
      storeA.appendEvent(session.id, completedEvent());

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const events = storeB.listEvents(session.id);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "text_delta", text: "hello" });
      expect(events[1]).toMatchObject({ type: "completed" });
    });
  });

  it("persists tool_call and usage events", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const key = makeKey();
      const storeA = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const session = storeA.create();
      storeA.appendEvent(session.id, toolCallEvent());
      storeA.appendEvent(session.id, usageEvent(10, 20));

      const storeB = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: key,
      });
      const events = storeB.listEvents(session.id);
      expect(events[0]).toMatchObject({
        type: "tool_call",
        id: "call-1",
        name: "read_file",
      });
      expect(events[1]).toMatchObject({
        type: "usage",
        inputTokens: 10,
        outputTokens: 20,
      });
    });
  });

  it("returns undefined for unknown session ids", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      expect(store.get("nope")).toBeUndefined();
      expect(store.listEvents("nope")).toEqual([]);
    });
  });

  it("returns a defensive copy from get()", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      const copy = store.get(session.id) as { status: string };
      copy.status = "failed";
      expect(store.get(session.id)?.status).toBe("idle");
    });
  });

  it("returns a defensive copy from listEvents()", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      store.appendEvent(session.id, userEvent("keep"));
      const events = store.listEvents(session.id) as unknown as { text: string }[];
      (events[0] as { text: string }).text = "mutated";
      expect(store.listEvents(session.id)[0]).toMatchObject({ text: "keep" });
    });
  });

  it("does not keep a reference to the caller-supplied event", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      const event = userEvent("original");
      store.appendEvent(session.id, event);
      (event as { text: string }).text = "mutated";
      expect(store.listEvents(session.id)[0]).toMatchObject({
        text: "original",
      });
    });
  });

  it("updates updatedAt on appendEvent", async () => {
    await withTempDir(async (dir) => {
      let now = 1000;
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
        clock: () => {
          now += 10;
          return now;
        },
      });
      const session = store.create();
      const before = store.get(session.id)?.updatedAt;
      store.appendEvent(session.id, userEvent("x"));
      expect(store.get(session.id)?.updatedAt).toBeGreaterThan(before ?? 0);
    });
  });

  it("updates status and activeTurnId", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      store.setStatus(session.id, "running", "turn-1");
      expect(store.get(session.id)).toMatchObject({
        status: "running",
        activeTurnId: "turn-1",
      });
    });
  });

  it("does not create a session for unknown setStatus ids", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      store.setStatus("ghost", "running");
      expect(store.get("ghost")).toBeUndefined();
    });
  });

  it("rejects invalid session status values", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      expect(() =>
        store.setStatus(session.id, "bogus" as never),
      ).toThrow(/status is invalid/);
    });
  });

  it("rejects invalid event schemas", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      });
      const session = store.create();
      expect(() =>
        store.appendEvent(session.id, { type: "unknown" } as never),
      ).toThrow(/event is invalid/);
      expect(() =>
        store.appendEvent(session.id, {
          type: "text_delta",
          requestId: "",
          text: "x",
        } as never),
      ).toThrow(/event is invalid/);
    });
  });

  it("exposes public default limits", () => {
    expect(DEFAULT_MAX_SESSION_FILE_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_SESSION_FILE_BYTES_LIMIT).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MAX_SESSIONS).toBe(256);
    expect(MAX_SESSIONS_LIMIT).toBe(4096);
    expect(DEFAULT_MAX_EVENTS_PER_SESSION).toBe(10000);
    expect(MAX_EVENTS_PER_SESSION_LIMIT).toBe(100000);
    expect(DEFAULT_MAX_EVENT_BYTES).toBe(256 * 1024);
    expect(MAX_EVENT_BYTES_LIMIT).toBe(1024 * 1024);
  });

  it("rejects invalid limit overrides", async () => {
    await withTempDir(async (dir) => {
      const base = {
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
      };
      expect(() =>
        createFileLocalAgentSessionStore({ ...base, maxSessions: 0 }),
      ).toThrow(/options are invalid/);
      expect(() =>
        createFileLocalAgentSessionStore({ ...base, maxSessions: 1.5 }),
      ).toThrow(/options are invalid/);
      expect(() =>
        createFileLocalAgentSessionStore({
          ...base,
          maxEventsPerSession: MAX_EVENTS_PER_SESSION_LIMIT + 1,
        }),
      ).toThrow(/options are invalid/);
    });
  });

  it("rejects an event exceeding maxEventBytes", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
        maxEventBytes: 32,
      });
      const session = store.create();
      expect(() =>
        store.appendEvent(session.id, userEvent("x".repeat(200))),
      ).toThrow(/size limit/);
    });
  });

  it("rejects appending when maxSessions is exceeded", async () => {
    await withTempDir(async (dir) => {
      const store = createFileLocalAgentSessionStore({
        filePath: join(dir, "s.json"),
        encryptionKey: makeKey(),
        maxSessions: 1,
      });
      store.create();
      expect(() => store.create()).toThrow(/Session count/);
    });
  });

  it("does not write plaintext session content to disk", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "s.json");
      const store = createFileLocalAgentSessionStore({
        filePath,
        encryptionKey: makeKey(),
      });
      const session = store.create();
      const secretText = "PLAINTEXT_MARKER_DO_NOT_LEAK";
      store.appendEvent(session.id, userEvent(secretText));
      const raw = readFileSync(filePath, "utf8");
      expect(raw).not.toContain(secretText);
      expect(raw).toContain("aes-256-gcm");
      expect(raw).toContain("ciphertext");
    });
  });
});
