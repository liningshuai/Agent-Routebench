/** Fixed, stable error codes of the backend assembly. */
export type AgentBackendErrorCode = "invalid_options" | "invalid_request";

/**
 * Fixed messages, one per code. They never embed the underlying exception,
 * stack, option values, provider identifiers, routes, URLs or secrets.
 */
export const AGENT_BACKEND_ERROR_MESSAGES = {
  invalid_options: "Agent backend options are invalid.",
  invalid_request: "Agent backend request is invalid.",
} as const satisfies Record<AgentBackendErrorCode, string>;

/** The single error type thrown across the backend assembly boundary. */
export class AgentBackendError extends Error {
  readonly code: AgentBackendErrorCode;

  constructor(code: AgentBackendErrorCode) {
    super(AGENT_BACKEND_ERROR_MESSAGES[code]);
    this.name = "AgentBackendError";
    this.code = code;
  }
}
