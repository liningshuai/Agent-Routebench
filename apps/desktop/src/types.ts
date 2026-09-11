import type { AgentEvent } from "@agent-workbench/agent-core";
import type { LocalAgentSession } from "@agent-workbench/local-agent-api";

export type DesktopConnectionStatus = "idle" | "loading" | "ready" | "failed";

export interface DesktopState {
  readonly connection: DesktopConnectionStatus;
  readonly sessions: readonly LocalAgentSession[];
  readonly activeSessionId: string | null;
  readonly events: readonly AgentEvent[];
  readonly draft: string;
  readonly error: string | null;
}

export interface DesktopApiClient {
  load(): Promise<void>;
  createSession(): Promise<LocalAgentSession>;
  submitTurn(
    sessionId: string,
    request: {
      readonly messages: readonly unknown[];
      readonly tools?: readonly unknown[];
      readonly routeId?: string;
      readonly model?: string;
      readonly maxTokens?: number;
    },
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
}
