import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentSessionStatus,
  LocalAgentSessionStore,
} from "./types.js";

interface SessionRecord {
  id: string;
  status: LocalAgentSessionStatus;
  createdAt: number;
  updatedAt: number;
  activeTurnId?: string;
  events: AgentEvent[];
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

/**
 * Purely in-memory session store. Sessions are never written to disk and
 * never shared across server instances.
 */
export class InMemoryLocalAgentSessionStore implements LocalAgentSessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  create(): LocalAgentSession {
    const now = Date.now();
    const record: SessionRecord = {
      id: randomUUID(),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.#sessions.set(record.id, record);
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
    record.events.push(structuredClone(event));
    record.updatedAt = Date.now();
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
    record.status = status;
    record.activeTurnId = activeTurnId;
    record.updatedAt = Date.now();
  }
}
