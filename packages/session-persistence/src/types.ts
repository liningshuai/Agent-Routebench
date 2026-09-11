import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentSessionStatus,
} from "@agent-workbench/local-agent-api";

export interface FileSessionStoreOptions {
  readonly filePath: string;
  readonly encryptionKey: Uint8Array;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly maxFileBytes?: number;
  readonly maxSessions?: number;
  readonly maxEventsPerSession?: number;
  readonly maxEventBytes?: number;
}

export interface PersistedSessionStoreLimits {
  readonly maxFileBytes: number;
  readonly maxSessions: number;
  readonly maxEventsPerSession: number;
  readonly maxEventBytes: number;
}

export const DEFAULT_MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_FILE_BYTES_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_MAX_SESSIONS = 256;
export const MAX_SESSIONS_LIMIT = 4096;
export const DEFAULT_MAX_EVENTS_PER_SESSION = 10000;
export const MAX_EVENTS_PER_SESSION_LIMIT = 100000;
export const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
export const MAX_EVENT_BYTES_LIMIT = 1024 * 1024;

export type SessionStatus = LocalAgentSessionStatus;
export type { AgentEvent, LocalAgentSession };

export interface PersistedSessionRecord {
  readonly id: string;
  readonly status: SessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly activeTurnId?: string;
  readonly events: AgentEvent[];
}

export interface PersistedSessionFile {
  readonly version: 1;
  readonly sessions: PersistedSessionRecord[];
}

export interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}
