import type { AgentEvent } from "@agent-workbench/agent-core";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";
import type {
  DesktopState,
  DesktopApiClient,
  DesktopConnectionStatus,
  StateSubscriber,
} from "./types.js";
import { createDesktopError } from "./errors.js";

export class DesktopController {
  private state: DesktopState;
  private apiClient: DesktopApiClient;
  private loadPromise: Promise<void> | null = null;
  private abortControllers = new Map<string, AbortController>();
  private subscribers: Set<StateSubscriber> = new Set();
  private disposed = false;

  constructor(apiClient: DesktopApiClient) {
    this.apiClient = apiClient;
    this.state = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
      isSubmitting: false,
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
      isSubmitting: this.state.isSubmitting,
    };
  }

  public subscribe(callback: StateSubscriber): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  public async connect(): Promise<void> {
    if (this.disposed) {
      return;
    }
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
    if (this.disposed) {
      throw createDesktopError("NOT_CONNECTED");
    }
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
    if (this.disposed) {
      throw createDesktopError("TURN_FAILED");
    }
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      throw createDesktopError("SESSION_NOT_FOUND");
    }

    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);
    
    // Clear draft and set submitting state
    const draftText = this.state.draft;
    this.setState({ isSubmitting: true, draft: "" });

    try {
      const events = this.apiClient.submitTurn(
        sessionId,
        request,
        abortController.signal,
      );

      for await (const event of events) {
        if (abortController.signal.aborted) {
          break;
        }
        this.setState({
          events: [...this.state.events, event],
        });
      }
      
      // Check abort after iteration completes
      if (abortController.signal.aborted) {
        throw new Error("Request aborted.");
      }
    } catch (_err: unknown) {
      const isAborted = abortController.signal.aborted || 
                       (_err instanceof Error && _err.message === "Request aborted.");
      
      if (isAborted) {
        // Restore draft on cancel and clear isSubmitting in one setState call
        this.setState({ draft: draftText, isSubmitting: false });
        this.abortControllers.delete(sessionId);
        throw new Error("Request aborted.");
      }
      this.setState({ error: "Failed to submit turn." });
      throw _err;
    } finally {
      this.abortControllers.delete(sessionId);
      // Only clear isSubmitting if not already aborted (already cleared in catch block)
      if (!abortController.signal.aborted) {
        this.setState({ isSubmitting: false });
      }
    }
  }

  public async cancelTurn(sessionId: string): Promise<void> {
    const abortController = this.abortControllers.get(sessionId);
    if (abortController) {
      abortController.abort();
    }

    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      // No-op for invalid sessionId (Task 14 edge case requirement)
      return;
    }
    
    // Call API when activeTurnId exists OR when abort controller exists (Task 15 UI requirement)
    if (session.activeTurnId || abortController) {
      const turnId = session.activeTurnId ?? "current";
      await this.apiClient.cancelTurn(sessionId, turnId);
    }
    
    // Note: isSubmitting is cleared in submitTurn's catch block when aborted
  }

  public setActiveSession(sessionId: string): void {
    if (this.disposed) {
      return;
    }
    const session = this.state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw createDesktopError("SESSION_NOT_FOUND");
    }
    if (this.state.isSubmitting || this.state.activeSessionId === sessionId) {
      return;
    }
    this.setState({
      activeSessionId: sessionId,
      events: [],
      draft: "",
      error: null,
    });
  }

  public updateDraft(draft: string): void {
    this.setState({ draft });
  }

  public clearError(): void {
    this.setState({ error: null });
  }

  private setState(partial: Partial<DesktopState>): void {
    if (this.disposed) {
      return;
    }
    this.state = {
      ...this.state,
      ...partial,
    };
    this.notifySubscribers();
  }

  private notifySubscribers(): void {
    const state = this.getState();
    this.subscribers.forEach((callback) => {
      try {
        callback(state);
      } catch (_err) {
        // Ignore subscriber errors to prevent breaking the chain
      }
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.subscribers.clear();
  }
}
