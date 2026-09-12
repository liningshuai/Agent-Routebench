/** Fixed, stable error codes of the Local Agent host. */
export type LocalAgentHostErrorCode =
  | "invalid_options"
  | "host_not_loopback"
  | "invalid_port"
  | "already_started"
  | "start_failed"
  | "close_failed"
  | "runner_not_ready";

/**
 * Fixed messages, one per code. They never embed the underlying exception,
 * stack, paths, URLs, host or port values.
 */
export const LOCAL_AGENT_HOST_ERROR_MESSAGES = {
  invalid_options: "Local agent host options are invalid.",
  host_not_loopback: "Local agent host must listen on loopback only.",
  invalid_port: "Local agent host port is invalid.",
  already_started: "Local agent host is already started.",
  start_failed: "Local agent host failed to start.",
  close_failed: "Local agent host failed to close.",
  runner_not_ready: "Local agent runner is not ready.",
} as const satisfies Record<LocalAgentHostErrorCode, string>;

/** The single error type thrown across the host boundary. */
export class LocalAgentHostError extends Error {
  readonly code: LocalAgentHostErrorCode;

  constructor(code: LocalAgentHostErrorCode) {
    super(LOCAL_AGENT_HOST_ERROR_MESSAGES[code]);
    this.name = "LocalAgentHostError";
    this.code = code;
  }
}
