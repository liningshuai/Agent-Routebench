// Public surface of the bounded agent runtime.
//
// The runtime is deliberately thin: it re-exports the shared contracts and the
// Agent Core entry point it orchestrates rather than restating them, so there is
// exactly one implementation of the contracts and of the gateway error cleanup.
export type {
  AgentContentBlock,
  AgentMessage,
  AgentRole,
  AgentToolDefinition,
  JsonPrimitive,
  JsonValue,
  ModelRequest,
} from "@agent-workbench/agent-contracts";
export type { ModelGateway, ModelStreamEvent } from "@agent-workbench/agent-contracts";
export type { AgentCore, AgentEvent } from "@agent-workbench/agent-core";
export {
  AgentValidationError,
  createAgentCore,
  isJsonValue,
  validateAgentMessages,
  validateModelRequest,
} from "@agent-workbench/agent-core";

export type {
  AgentLoop,
  AgentLoopEvent,
  AgentLoopOptions,
  GovernedToolExecutorOptions,
  ResolvedAgentLoopOptions,
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalRequest,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
  ToolPolicy,
  ToolPolicyDecision,
} from "./types.js";
export { DEFAULT_AGENT_LOOP_LIMITS } from "./types.js";
export type { AgentLoopErrorCode, AgentLoopErrorKey } from "./errors.js";
export {
  AGENT_LOOP_ERROR_CODES,
  AgentLoopError,
  TOOL_FAILURE_CONTENT,
  agentLoopError,
  agentLoopMessage,
} from "./errors.js";
export { createAgentLoop, resolveAgentLoopOptions } from "./agent-loop.js";

// Task 7: the injected tool policy and approval gate.
export type { ToolPolicyErrorCode, ToolPolicyErrorKey } from "./tool-policy.js";
export {
  TOOL_APPROVAL_DENIED_CONTENT,
  TOOL_APPROVAL_FAILED_CONTENT,
  TOOL_APPROVAL_UNAVAILABLE_CONTENT,
  TOOL_POLICY_DENIED_CONTENT,
  TOOL_POLICY_ERROR_CODES,
  TOOL_POLICY_FAILED_CONTENT,
  ToolPolicyError,
  createGovernedToolExecutor,
} from "./tool-policy.js";
