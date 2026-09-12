import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";

export type LocalAgentFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface LocalAgentClientOptions {
  readonly baseUrl: string;
  readonly fetch?: LocalAgentFetch;
  readonly maxLineBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxBodyBytes?: number;
}

export interface LocalAgentClient {
  health(signal?: AbortSignal): Promise<unknown>;
  createSession(signal?: AbortSignal): Promise<LocalAgentSession>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<LocalAgentSession>;
  listEvents(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentEvent[]>;
  runTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  cancel(sessionId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface NDJSONLimits {
  readonly maxLineBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_MAX_LINE_BYTES = 256 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
