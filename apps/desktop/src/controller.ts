import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";
import type {
  DesktopState,
  DesktopApiClient,
  DesktopConnectionStatus,
} from "./types.js";
import { createDesktopError } from "./errors.js";

export class DesktopController {
  private state: DesktopState;
  private apiClient: DesktopApiClient;
  private loadPromise: Promise<void> | null = null;
  private abortControllers = new Map<string, AbortController>();

  constructor(apiClient: DesktopApiClient) {
    this.apiClient = apiClient;
    this.state = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
  }

  public getState(): DesktopState {
    return {
      connection: this.state.connection,
      sessions: [...this.state.sessions],
      activeSessionId: this.state.activeSessionId,
      events: [...this.state.events],
      draft: this.state.draft,
      error: this.state.error,
    };
  }

  public async connect(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.setState({ connection: "loading" });

    this.loadPromise = this.apiClient
      .load()
      .then(() => {
        this.setState({ connection: "ready", error: null });
      })
      .catch((_err: unknown) => {
        this.setState({ connection: "failed", error: "Failed to connect to Desktop API." });
      })
      .finally(() => {
        this.loadPromise = null;
      });

    return this.loadPromise;
  }

  public async newSession(): Promise<void> {
    if (this.state.connection !== "ready") {
      throw createDesktopError("NOT_CONNECTED");
    }

    try {
      const session = await this.apiClient.createSession();
      this.setState({
        sessions: [...this.state.sessions, session],
        activeSessionId: session.id,
      });
    } catch (_err: unknown) {
      this.setState({ error: "Failed to create session." });
      throw _err;
    }
  }

  public async submitTurn(
    sessionId: string,
    request: LocalAgentTurnRequest,
  ): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw createDesktopError("SESSION_NOT_FOUND");
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);

    try {
      const events = this.apiClient.submitTurn(
        sessionId,
        request,
        abortController.signal,
      );

      for await (const event of events) {
        this.setState({
          events: [...this.state.events, event],
        });
      }
    } catch (_err: unknown) {
      if (abortController.signal.aborted) {
        throw new Error("Request aborted.");
      }
      this.setState({ error: "Failed to submit turn." });
      throw _err;
    } finally {
      this.abortControllers.delete(sessionId);
    }
  }

  public async cancelTurn(sessionId: string): Promise<void> {
    const abortController = this.abortControllers.get(sessionId);
    if (abortController) {
      abortController.abort();
    }

    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (session?.activeTurnId) {
      await this.apiClient.cancelTurn(sessionId, session.activeTurnId);
    }
  }

  public updateDraft(draft: string): void {
    this.setState({ draft });
  }

  public clearError(): void {
    this.setState({ error: null });
  }

  private setState(partial: Partial<DesktopState>): void {
    this.state = {
      ...this.state,
      ...partial,
    };
  }
}
