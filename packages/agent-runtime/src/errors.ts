/**
 * Stable, documented error codes emitted by the agent runtime.
 *
 * Every runtime failure is reported with one of these codes and a fixed
 * message. Nothing derived from tool input, a tool exception or an upstream
 * payload is ever interpolated into a message.
 */
export const AGENT_LOOP_ERROR_CODES = {
  invalidLoopOptions: "invalid_loop_options",
  aborted: "aborted",
  toolExecutionUnavailable: "tool_execution_unavailable",
  unknownTool: "unknown_tool",
  invalidToolCall: "invalid_tool_call",
  duplicateToolCallId: "duplicate_tool_call_id",
  tooManyToolCalls: "too_many_tool_calls",
  maxTurnsExceeded: "max_turns_exceeded",
  toolExecutionFailed: "tool_execution_failed",
  incompleteModelResponse: "incomplete_model_response",
  gatewayFailure: "gateway_error",
} as const;

export type AgentLoopErrorKey = keyof typeof AGENT_LOOP_ERROR_CODES;

export type AgentLoopErrorCode =
  (typeof AGENT_LOOP_ERROR_CODES)[AgentLoopErrorKey];

const AGENT_LOOP_ERROR_MESSAGES: Readonly<Record<AgentLoopErrorKey, string>> = {
  invalidLoopOptions: "Agent loop options are invalid.",
  aborted: "Request aborted.",
  toolExecutionUnavailable: "Tool execution is unavailable.",
  unknownTool: "The requested tool is not available.",
  invalidToolCall: "The model returned an invalid tool call.",
  duplicateToolCallId: "The model returned a duplicate tool call id.",
  tooManyToolCalls: "The model returned too many tool calls.",
  maxTurnsExceeded: "The agent loop reached its maximum number of turns.",
  toolExecutionFailed: "Tool execution failed.",
  incompleteModelResponse: "The model stream ended before completion.",
  // Raised when a throw escapes Agent Core. The wording matches Agent Core's own
  // gateway failure message so a consumer only ever sees one consistent text.
  gatewayFailure: "Model gateway request failed.",
};

/**
 * The fixed tool-result content used whenever a tool invocation could not be
 * turned into a usable result. The model may recover from it on the next turn.
 */
export const TOOL_FAILURE_CONTENT = AGENT_LOOP_ERROR_MESSAGES.toolExecutionFailed;

export class AgentLoopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
  }
}

/** Builds a runtime error from a fixed code key. */
export function agentLoopError(key: AgentLoopErrorKey): AgentLoopError {
  return new AgentLoopError(
    AGENT_LOOP_ERROR_CODES[key],
    AGENT_LOOP_ERROR_MESSAGES[key],
  );
}

/** The fixed message for a runtime error key. */
export function agentLoopMessage(key: AgentLoopErrorKey): string {
  return AGENT_LOOP_ERROR_MESSAGES[key];
}
