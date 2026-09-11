import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentSessionStatus,
  LocalAgentSessionStore,
} from "@agent-workbench/local-agent-api";
import {
  assertEncryptionKey,
  assertEnvelope,
  decryptEnvelope,
  encryptJson,
} from "./crypto.js";
import { failSession } from "./errors.js";
import type {
  FileSessionStoreOptions,
  PersistedSessionFile,
  PersistedSessionRecord,
} from "./types.js";
import {
  DEFAULT_MAX_EVENTS_PER_SESSION,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_SESSION_FILE_BYTES,
  MAX_EVENTS_PER_SESSION_LIMIT,
  MAX_EVENT_BYTES_LIMIT,
  MAX_SESSIONS_LIMIT,
  MAX_SESSION_FILE_BYTES_LIMIT,
} from "./types.js";
import {
  assertAgentEvent,
  assertPersistedSession,
  assertSessionId,
  assertSessionStatus,
  validatePersistedFile,
} from "./validation.js";

interface SessionRecord {
  id: string;
  status: LocalAgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  activeTurnId?: string;
  events: AgentEvent[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function normalizeLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    failSession("invalidOptions");
  }
  return value;
}

function assertAbsolutePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    failSession("invalidOptions");
  }
  if (
    filePath.includes("\0") ||
    filePath.includes("?") ||
    filePath.includes("#")
  ) {
    failSession("invalidOptions");
  }
  if (!isAbsolute(filePath)) {
    failSession("invalidOptions");
  }
}

function cloneSession(record: SessionRecord): LocalAgentSession {
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.activeTurnId === undefined
      ? {}
      : { activeTurnId: record.activeTurnId }),
  };
}

function cloneRecord(record: SessionRecord): PersistedSessionRecord {
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.activeTurnId === undefined
      ? {}
      : { activeTurnId: record.activeTurnId }),
    events: structuredClone(record.events),
  };
}

class FileLocalAgentSessionStore implements LocalAgentSessionStore {
  readonly #filePath: string;
  readonly #key: Uint8Array;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #maxFileBytes: number;
  readonly #maxSessions: number;
  readonly #maxEventsPerSession: number;
  readonly #maxEventBytes: number;
  #sessions = new Map<string, SessionRecord>();

  constructor(options: FileSessionStoreOptions) {
    if (
      options === null ||
      options === undefined ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      failSession("invalidOptions");
    }
    const raw = options as Partial<FileSessionStoreOptions>;
    assertAbsolutePath(raw.filePath);
    assertEncryptionKey(raw.encryptionKey);

    const clock = raw.clock ?? Date.now;
    if (typeof clock !== "function") {
      failSession("invalidOptions");
    }
    const idFactory = raw.idFactory ?? randomUUID;
    if (typeof idFactory !== "function") {
      failSession("invalidOptions");
    }

    this.#filePath = raw.filePath;
    this.#key = raw.encryptionKey;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxFileBytes = normalizeLimit(
      raw.maxFileBytes,
      DEFAULT_MAX_SESSION_FILE_BYTES,
      MAX_SESSION_FILE_BYTES_LIMIT,
    );
    this.#maxSessions = normalizeLimit(
      raw.maxSessions,
      DEFAULT_MAX_SESSIONS,
      MAX_SESSIONS_LIMIT,
    );
    this.#maxEventsPerSession = normalizeLimit(
      raw.maxEventsPerSession,
      DEFAULT_MAX_EVENTS_PER_SESSION,
      MAX_EVENTS_PER_SESSION_LIMIT,
    );
    this.#maxEventBytes = normalizeLimit(
      raw.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      MAX_EVENT_BYTES_LIMIT,
    );

    this.#loadFromDisk();
  }

  create(): LocalAgentSession {
    if (this.#sessions.size >= this.#maxSessions) {
      failSession("sessionLimitExceeded");
    }
    const id = this.#idFactory();
    assertSessionId(id);
    if (this.#sessions.has(id)) {
      failSession("invalidOptions");
    }
    const now = this.#clock();
    const record: SessionRecord = {
      id,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    const previous = new Map(this.#sessions);
    this.#sessions.set(id, record);
    try {
      this.#persist();
    } catch (error) {
      this.#sessions = previous;
      throw error;
    }
    return cloneSession(record);
  }

  get(id: string): LocalAgentSession | undefined {
    const record = this.#sessions.get(id);
    return record === undefined ? undefined : cloneSession(record);
  }

  listEvents(id: string): readonly AgentEvent[] {
    const record = this.#sessions.get(id);
    if (record === undefined) {
      return [];
    }
    return structuredClone(record.events);
  }

  appendEvent(id: string, event: AgentEvent): void {
    const record = this.#sessions.get(id);
    if (record === undefined) {
      return;
    }
    if (record.events.length >= this.#maxEventsPerSession) {
      failSession("eventLimitExceeded");
    }
    assertAgentEvent(event, this.#maxEventBytes);
    const previousEvents = record.events;
    const previousUpdated = record.updatedAt;
    record.events = [...previousEvents, structuredClone(event)];
    record.updatedAt = this.#clock();
    try {
      this.#persist();
    } catch (error) {
      record.events = previousEvents;
      record.updatedAt = previousUpdated;
      throw error;
    }
  }

  setStatus(
    id: string,
    status: LocalAgentSessionStatus,
    activeTurnId?: string,
  ): void {
    const record = this.#sessions.get(id);
    if (record === undefined) {
      return;
    }
    assertSessionStatus(status);
    if (activeTurnId !== undefined && (typeof activeTurnId !== "string" || activeTurnId.length === 0)) {
      failSession("invalidStatus");
    }
    const previousStatus = record.status;
    const previousTurn = record.activeTurnId;
    const previousUpdated = record.updatedAt;
    record.status = status;
    record.activeTurnId = activeTurnId;
    record.updatedAt = this.#clock();
    try {
      this.#persist();
    } catch (error) {
      record.status = previousStatus;
      record.activeTurnId = previousTurn;
      record.updatedAt = previousUpdated;
      throw error;
    }
  }

  #loadFromDisk(): void {
    let raw: string;
    try {
      raw = readFileSync(this.#filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return;
      }
      failSession("fileInvalid");
    }

    if (raw.trim().length === 0) {
      failSession("fileInvalid");
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      failSession("fileInvalid");
    }
    assertEnvelope(envelope);

    const plaintext = decryptEnvelope(envelope, this.#key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      failSession("fileInvalid");
    }
    validatePersistedFile(parsed);

    const sessions = new Map<string, SessionRecord>();
    let recovered = false;
    for (const session of parsed.sessions) {
      assertPersistedSession(session);
      const record: SessionRecord = {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        events: structuredClone(session.events),
      };
      if (session.activeTurnId !== undefined) {
        record.activeTurnId = session.activeTurnId;
      }
      if (record.status === "running") {
        record.status = "failed";
        delete record.activeTurnId;
        record.updatedAt = this.#clock();
        recovered = true;
      }
      sessions.set(record.id, record);
    }
    this.#sessions = sessions;

    if (recovered) {
      try {
        this.#persist();
      } catch {
        failSession("recoveryFailed");
      }
    }
  }

  #buildFile(): PersistedSessionFile {
    if (this.#sessions.size > this.#maxSessions) {
      failSession("sessionLimitExceeded");
    }
    const records: PersistedSessionRecord[] = [];
    for (const record of this.#sessions.values()) {
      if (record.events.length > this.#maxEventsPerSession) {
        failSession("eventLimitExceeded");
      }
      const cloned = cloneRecord(record);
      records.push(cloned);
    }
    return { version: 1, sessions: records };
  }

  #persist(): void {
    const file = this.#buildFile();
    const plaintext = JSON.stringify(file);
    const envelope = encryptJson(plaintext, this.#key);
    const payload = `${JSON.stringify(envelope)}\n`;
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > this.#maxFileBytes) {
      failSession("eventTooLarge");
    }

    const directory = dirname(this.#filePath);
    const tempPath = join(
      directory,
      `.${String(Date.now())}.${String(Math.random()).slice(2)}.tmp`,
    );

    try {
      writeFileSync(tempPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
      failSession("fileWriteFailed");
    }

    try {
      renameSync(tempPath, this.#filePath);
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
      failSession("fileWriteFailed");
    }

    // Guard against unexpected file size after write.
    try {
      const size = statSync(this.#filePath).size;
      if (size > this.#maxFileBytes) {
        failSession("eventTooLarge");
      }
    } catch {
      failSession("fileWriteFailed");
    }
  }
}

export function createFileLocalAgentSessionStore(
  options: FileSessionStoreOptions,
): LocalAgentSessionStore {
  return new FileLocalAgentSessionStore(options);
}

export { FileLocalAgentSessionStore };
