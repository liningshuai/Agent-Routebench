import { DesktopController } from "./controller.js";
import type { DesktopApiClient } from "./types.js";
import type { DesktopState } from "./types.js";

/**
 * Desktop UI interface for interactive renderer.
 */
export interface DesktopUi {
  unmount(): void;
  getState(): Readonly<DesktopState>;
  subscribe(callback: (state: Readonly<DesktopState>) => void): () => void;
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Mount interactive Desktop UI to a DOM container.
 */
export function mountDesktopUi(
  container: HTMLElement,
  client: DesktopApiClient,
): DesktopUi {
  if (!container) {
    throw new Error("Container element is required.");
  }
  if (!client) {
    throw new Error("DesktopApiClient is required.");
  }

  const controller = new DesktopController(client);
  let unmounted = false;

  function render(): void {
    if (unmounted) {
      return;
    }
    const state = controller.getState();
    const html = renderHtml(state);
    container.innerHTML = html;
    attachEventListeners();
  }

  // Subscribe to controller state changes
  const unsubscribeController = controller.subscribe(() => {
    render();
  });

  function renderHtml(state: DesktopState): string {
    let html = '<div class="desktop-ui">';

    // Error message
    if (state.error) {
      html += `<div class="error">${escapeHtml(state.error)}</div>`;
    }

    // Connection section - map "idle" to same UI as disconnected
    if (state.connection === "idle" || state.connection === "failed") {
      html += '<button class="connect-btn">Connect</button>';
    } else if (state.connection === "loading") {
      html += '<button class="connect-btn" disabled>Connecting...</button>';
    } else if (state.connection === "ready") {
      html += '<div class="connection-status">Connected</div>';
      html += renderSessionSection(state);
    }

    html += "</div>";
    return html;
  }

  function renderSessionSection(state: DesktopState): string {
    let html = '<div class="session-section">';

    // New session button
    html += '<button class="new-session-btn">New Session</button>';

    // Session list - always render the list element
    html += '<ul class="session-list">';
    for (const session of state.sessions) {
      const activeClass =
        state.activeSessionId === session.id ? " active" : "";
      html += `<li class="session-item${activeClass}" data-session-id="${escapeHtml(session.id)}">${escapeHtml(session.id)}</li>`;
    }
    html += "</ul>";

    // Draft and streaming section for active session
    if (state.activeSessionId) {
      html += '<div class="draft-section">';
      html += `<textarea class="draft-input" placeholder="Enter message...">${escapeHtml(state.draft)}</textarea>`;

      if (state.isSubmitting) {
        html += '<button class="cancel-btn">Cancel</button>';
      } else {
        const disabled = state.draft.trim() === "" ? " disabled" : "";
        html += `<button class="send-btn"${disabled}>Send</button>`;
      }

      html += "</div>";

      // Streaming events
      if (state.events.length > 0) {
        html += '<div class="streaming-events">';
        let accumulatedText = "";
        for (const event of state.events) {
          if (event.type === "text_delta") {
            accumulatedText += event.text;
          }
        }
        if (accumulatedText) {
          html += `<div class="streaming-text">${escapeHtml(accumulatedText)}</div>`;
        }
        html += "</div>";
      }
    }

    html += "</div>";
    return html;
  }

  function attachEventListeners(): void {
    const connectBtn = container.querySelector(".connect-btn");
    if (connectBtn) {
      connectBtn.addEventListener("click", handleConnect);
    }

    const newSessionBtn = container.querySelector(".new-session-btn");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", handleNewSession);
    }

    const sessionItems = container.querySelectorAll(".session-item");
    for (const item of sessionItems) {
      item.addEventListener("click", handleSessionClick);
    }

    const draftInput = container.querySelector(".draft-input");
    if (draftInput) {
      draftInput.addEventListener("input", handleDraftInput);
    }

    const sendBtn = container.querySelector(".send-btn");
    if (sendBtn) {
      sendBtn.addEventListener("click", handleSend);
    }

    const cancelBtn = container.querySelector(".cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", handleCancel);
    }
  }

  async function handleConnect(): Promise<void> {
    await controller.connect();
  }

  async function handleNewSession(): Promise<void> {
    try {
      await controller.newSession();
    } catch (err) {
      // Error already set in controller state
    }
  }

  function handleSessionClick(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    const sessionId = target.dataset.sessionId;
    if (sessionId) {
      try {
        controller.setActiveSession(sessionId);
      } catch (_err: unknown) {
        // The session was removed between render and click; keep the UI stable.
      }
    }
  }

  function handleDraftInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    controller.updateDraft(target.value);
  }

  async function handleSend(): Promise<void> {
    const state = controller.getState();
    if (!state.activeSessionId || !state.draft.trim()) {
      return;
    }

    try {
      await controller.submitTurn(state.activeSessionId, {
        messages: [{ role: "user", content: [{ type: "text", text: state.draft }] }],
      });
    } catch (err: unknown) {
      // Error already set in controller state
    }
  }

  async function handleCancel(): Promise<void> {
    const state = controller.getState();
    if (!state.activeSessionId) {
      return;
    }

    try {
      await controller.cancelTurn(state.activeSessionId);
    } catch (err: unknown) {
      // Error already set in controller state
    }
  }

  // Initial render
  render();

  return {
    unmount(): void {
      if (unmounted) {
        return;
      }
      unmounted = true;
      unsubscribeController();
      controller.dispose();
      container.replaceChildren();
    },

    getState(): Readonly<DesktopState> {
      return controller.getState();
    },

    subscribe(callback: (state: Readonly<DesktopState>) => void): () => void {
      if (unmounted) {
        return () => undefined;
      }
      return controller.subscribe(callback);
    },
  };
}
