// Compatibility re-export layer.
//
// The single real implementation of these contracts lives in
// `@agent-workbench/agent-contracts`. This file exists only so that existing
// relative imports keep working; it must never define its own implementation.
export type {
  AgentContentBlock,
  AgentMessage,
  AgentRole,
  AgentToolDefinition,
  JsonPrimitive,
  JsonValue,
  ModelRequest,
} from "@agent-workbench/agent-contracts";
export {
  AgentValidationError,
  isJsonValue,
  validateAgentMessages,
  validateAgentToolDefinitions,
  validateModelRequest,
} from "@agent-workbench/agent-contracts";
