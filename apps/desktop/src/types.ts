import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";

export type DesktopConnectionStatus = "idle" | "loading" | "ready" | "failed";

export interface DesktopState {
  readonly connection: DesktopConnectionStatus;
  readonly sessions: readonly LocalAgentSession[];
  readonly activeSessionId: string | null;
  readonly events: readonly AgentEvent[];
  readonly draft: string;
  readonly error: string | null;
  readonly isSubmitting?: boolean;
}

export interface DesktopApiClient {
  load(): Promise<void>;
  createSession(): Promise<LocalAgentSession>;
  submitTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
}

export type StateSubscriber = (state: DesktopState) => void;
