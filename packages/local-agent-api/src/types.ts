import type {
  AgentEvent,
  AgentMessage,
  AgentToolDefinition,
} from "@agent-workbench/agent-core";

export type LocalAgentSessionStatus =
  | "idle"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface LocalAgentSession {
  readonly id: string;
  readonly status: LocalAgentSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly activeTurnId?: string;
}

export interface LocalAgentTurnRequest {
  readonly messages: readonly AgentMessage[];
  readonly tools?: readonly AgentToolDefinition[];
  readonly routeId?: string;
  readonly model?: string;
  readonly maxTokens?: number;
}

export interface LocalAgentRunnerRequest extends LocalAgentTurnRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface LocalAgentRunner {
  run(
    request: LocalAgentRunnerRequest,
  ): AsyncIterable<AgentEvent> | Promise<AsyncIterable<AgentEvent>>;
}

export interface LocalAgentSessionStore {
  create(): LocalAgentSession;
  get(id: string): LocalAgentSession | undefined;
  listEvents(id: string): readonly AgentEvent[];
  appendEvent(id: string, event: AgentEvent): void;
  setStatus(
    id: string,
    status: LocalAgentSessionStatus,
    activeTurnId?: string,
  ): void;
}

/**
 * Optional configuration boundary owned by the embedding host.
 *
 * The API package deliberately keeps the values opaque so it does not depend
 * on the provider registry or persistence packages. The concrete manager is
 * responsible for validation, persistence and returning secret-free copies.
 */
export interface LocalAgentConfigManager {
  getSnapshot(): unknown;
  createProvider(input: unknown): Promise<unknown>;
  updateProvider(input: unknown): Promise<unknown>;
  deleteProvider(providerId: string): Promise<void>;
  createRoute(input: unknown): Promise<unknown>;
  updateRoute(input: unknown): Promise<unknown>;
  deleteRoute(routeId: string): Promise<void>;
}

export interface LocalAgentApiServer {
  start(): Promise<void>;
  close(): Promise<void>;
  address(): string | undefined;
}

export type LocalAgentHost = "127.0.0.1" | "localhost";

export interface LocalAgentApiOptions {
  readonly host?: LocalAgentHost;
  readonly port: number;
  readonly runner: LocalAgentRunner;
  readonly store?: LocalAgentSessionStore;
  readonly maxBodyBytes?: number;
  readonly configManager?: LocalAgentConfigManager;
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
