import type { AgentEvent } from "@agent-workbench/agent-core";

export interface EventViewModel {
  readonly type: string;
  readonly name?: string;
  readonly text?: string;
  readonly message?: string;
  readonly code?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly retryable?: boolean;
}

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * Must be used before inserting user-generated or model-generated text into HTML.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Creates a secure ViewModel from an AgentEvent.
 * 
 * Security boundaries:
 * - tool_call.input is NEVER included (may contain credentials, API keys, secrets)
 * - route_selected.routeId and .model are NEVER included (internal routing details)
 * - error messages are fixed and do not echo user input
 * - No provider URLs, credentialRef, Authorization headers, or tokens
 */
export function createEventViewModel(event: AgentEvent): EventViewModel {
  switch (event.type) {
    case "tool_call":
      return {
        type: event.type,
        name: event.name,
        // input is deliberately excluded for security
      };
    case "text_delta":
      return {
        type: event.type,
        text: event.text,
      };
    case "usage":
      return {
        type: event.type,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case "route_selected":
      return {
        type: event.type,
        // routeId and model are deliberately excluded for security
      };
    case "error":
      return {
        type: event.type,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      };
    case "completed":
      return {
        type: event.type,
      };
    default:
      return { type: "unknown" };
  }
}

/**
 * Renders an EventViewModel to safe HTML.
 * Uses escapeHtml for all user-controlled or model-controlled text.
 */
export function renderEventToHtml(viewModel: EventViewModel): string {
  switch (viewModel.type) {
    case "tool_call":
      return `<div class="event tool-call"><strong>Tool:</strong> ${escapeHtml(viewModel.name || "")}</div>`;
    case "text_delta":
      return `<span class="text-delta">${escapeHtml(viewModel.text || "")}</span>`;
    case "usage":
      return `<div class="event usage">Tokens: ${viewModel.inputTokens ?? 0} in, ${viewModel.outputTokens ?? 0} out</div>`;
    case "route_selected":
      return `<div class="event route-selected">Route selected</div>`;
    case "error":
      return `<div class="event error"><strong>Error:</strong> ${escapeHtml(viewModel.message || "Unknown error")}</div>`;
    case "completed":
      return `<div class="event completed">Completed</div>`;
    default:
      return `<div class="event unknown">Unknown event</div>`;
  }
}
