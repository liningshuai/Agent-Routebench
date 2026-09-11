import type { DesktopState } from "./types.js";
import { escapeHtml, createEventViewModel } from "./view-model.js";

/**
 * Renders the complete Desktop page from a DesktopState.
 * 
 * Security requirements:
 * - All user text, model text, and error text MUST be HTML escaped
 * - tool_call.input MUST NOT appear in output
 * - Provider URLs, credentialRef, Authorization, Bearer, token, secret MUST NOT appear
 * - No external URLs or CDN references
 * - No javascript: URLs
 * - No event attributes (onclick, onerror, etc.)
 * - Deterministic output for same input
 * - Must not mutate input state
 */
export function renderDesktopPage(state: DesktopState): string {
  const connectionStatus = renderConnectionStatus(state.connection);
  const errorDisplay = state.error ? renderError(state.error) : "";
  const sessionList = renderSessionList(state.sessions, state.activeSessionId);
  const transcript = renderTranscript(state.events);
  const draftInput = renderDraftInput(state.draft);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Workbench Desktop</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <div id="app">
    <header class="desktop-header">
      <h1>Agent Workbench Desktop</h1>
      ${connectionStatus}
    </header>
    ${errorDisplay}
    <div class="desktop-main">
      <aside class="desktop-sidebar">
        <h2>Sessions</h2>
        ${sessionList}
      </aside>
      <main class="desktop-content">
        <div class="desktop-transcript">
          ${transcript}
        </div>
        <div class="desktop-composer">
          ${draftInput}
        </div>
      </main>
    </div>
  </div>
</body>
</html>
  `.trim();
}

function renderConnectionStatus(status: string): string {
  const escapedStatus = escapeHtml(status);
  return `<div class="connection-status connection-${escapedStatus}">${escapedStatus}</div>`;
}

function renderError(error: string): string {
  const escapedError = escapeHtml(error);
  return `<div class="desktop-error">${escapedError}</div>`;
}

function renderSessionList(
  sessions: readonly { readonly id: string; readonly createdAt: number }[],
  activeSessionId: string | null,
): string {
  if (sessions.length === 0) {
    return '<div class="session-list-empty">No sessions yet</div>';
  }

  const items = sessions.map((session) => {
    const isActive = session.id === activeSessionId;
    const activeClass = isActive ? " session-active" : "";
    const escapedId = escapeHtml(session.id);
    return `<div class="session-item${activeClass}" data-session-id="${escapedId}">${escapedId}</div>`;
  });

  return `<div class="session-list">${items.join("")}</div>`;
}

function renderTranscript(events: readonly unknown[]): string {
  if (events.length === 0) {
    return '<div class="transcript-empty">No events yet</div>';
  }

  const eventHtmls = events.map((event) => {
    const viewModel = createEventViewModel(event as any);
    return renderEvent(viewModel);
  });

  return `<div class="transcript-events">${eventHtmls.join("")}</div>`;
}

function renderEvent(viewModel: {
  readonly type: string;
  readonly name?: string;
  readonly text?: string;
  readonly message?: string;
  readonly code?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly retryable?: boolean;
}): string {
  const escapedType = escapeHtml(viewModel.type);

  switch (viewModel.type) {
    case "text_delta":
      if (viewModel.text) {
        const escapedText = escapeHtml(viewModel.text);
        return `<div class="event event-text-delta">${escapedText}</div>`;
      }
      return "";

    case "tool_call":
      if (viewModel.name) {
        const escapedName = escapeHtml(viewModel.name);
        // tool_call.input is deliberately excluded by createEventViewModel
        return `<div class="event event-tool-call">Tool: ${escapedName}</div>`;
      }
      return "";

    case "usage":
      if (viewModel.inputTokens !== undefined && viewModel.outputTokens !== undefined) {
        return `<div class="event event-usage">Usage: ${viewModel.inputTokens} in, ${viewModel.outputTokens} out</div>`;
      }
      return "";

    case "completed":
      return '<div class="event event-completed">Completed</div>';

    case "error":
      if (viewModel.message) {
        const escapedMessage = escapeHtml(viewModel.message);
        const escapedCode = viewModel.code ? escapeHtml(viewModel.code) : "";
        return `<div class="event event-error">Error: ${escapedMessage}${escapedCode ? ` (${escapedCode})` : ""}</div>`;
      }
      return "";

    case "route_selected":
      // routeId and model are deliberately excluded by createEventViewModel
      return '<div class="event event-route-selected">Route selected</div>';

    default:
      return `<div class="event event-unknown">Unknown event: ${escapedType}</div>`;
  }
}

function renderDraftInput(draft: string): string {
  const escapedDraft = escapeHtml(draft);
  return `
    <div class="draft-container">
      <div class="draft-input">${escapedDraft}</div>
      <div class="draft-controls">
        <button class="draft-send">Send</button>
        <button class="draft-cancel">Cancel</button>
      </div>
    </div>
  `;
}
