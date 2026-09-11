import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";

/**
 * Fake DesktopApiClient for testing Desktop state and controller.
 * Must be a class instance to satisfy structural validation.
 */
export class FakeDesktopApiClient {
  public loadCalled = false;
  public loadShouldFail = false;
  public loadError = "Failed to connect to Local Agent API.";

  public createSessionCalled = false;
  public createSessionShouldFail = false;
  public createSessionError = "Failed to create session.";
  public createdSessions: LocalAgentSession[] = [];

  public submitTurnCalled = false;
  public submitTurnRequests: Array<{
    sessionId: string;
    request: LocalAgentTurnRequest;
  }> = [];
  public submitTurnEvents: AgentEvent[] = [];
  public submitTurnShouldFail = false;

  public cancelTurnCalled = false;
  public cancelledTurns: Array<{ sessionId: string; turnId: string }> = [];

  public loadDelay = 0;
  public submitTurnDelay = 0;

  async load(): Promise<void> {
    this.loadCalled = true;
    if (this.loadDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.loadDelay));
    }
    if (this.loadShouldFail) {
      throw new Error(this.loadError);
    }
  }

  async createSession(): Promise<LocalAgentSession> {
    this.createSessionCalled = true;
    if (this.createSessionShouldFail) {
      throw new Error(this.createSessionError);
    }
    const session: LocalAgentSession = {
      id: `sess_${Date.now()}`,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.createdSessions.push(session);
    return session;
  }

  async *submitTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    this.submitTurnCalled = true;
    this.submitTurnRequests.push({ sessionId, request });

    if (this.submitTurnShouldFail) {
      throw new Error("Failed to submit turn.");
    }

    if (this.submitTurnDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.submitTurnDelay));
      if (signal?.aborted) {
        throw new Error("Request aborted.");
      }
    }

    for (const event of this.submitTurnEvents) {
      if (signal?.aborted) {
        throw new Error("Request aborted.");
      }
      yield event;
    }
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    this.cancelTurnCalled = true;
    this.cancelledTurns.push({ sessionId, turnId });
  }
}
