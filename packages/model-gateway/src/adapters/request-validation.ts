import {
  AgentValidationError,
  validateModelRequest,
} from "@agent-workbench/agent-contracts";
import type {
  AgentContentBlock,
  AgentMessage,
  AgentToolDefinition,
  ModelRequest,
} from "@agent-workbench/agent-contracts";
import { adapterError } from "./errors.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Runs the shared contract validator first.
 *
 * Anything that is not a normal `AgentValidationError` (for example the
 * `RangeError` produced while walking a cyclic JSON structure) is folded into a
 * stable adapter error so no engine level stack trace can escape.
 */
function runSharedValidation(request: unknown): void {
  try {
    validateModelRequest(request as ModelRequest);
  } catch (error) {
    if (error instanceof AgentValidationError) {
      throw adapterError("invalid_adapter_request");
    }
    throw adapterError("unsupported_adapter_input");
  }
}

/**
 * The protocol subset both adapters can express.
 *
 * - system: only at the very beginning, only text blocks
 * - user: only text blocks
 * - assistant: text and tool_call blocks
 * - tool: only tool_result blocks
 */
function assertRoleBlockShape(messages: readonly AgentMessage[]): void {
  messages.forEach((message, index) => {
    for (const block of message.content) {
      const allowed = isBlockAllowedForRole(message.role, index, block);
      if (!allowed) {
        throw adapterError("invalid_adapter_request");
      }
      if (
        block.type === "tool_result" &&
        block.isError !== undefined &&
        typeof block.isError !== "boolean"
      ) {
        throw adapterError("invalid_adapter_request");
      }
    }
  });
}

function isBlockAllowedForRole(
  role: AgentMessage["role"],
  index: number,
  block: AgentContentBlock,
): boolean {
  switch (role) {
    case "system":
      return index === 0 && block.type === "text";
    case "user":
      return block.type === "text";
    case "assistant":
      return block.type === "text" || block.type === "tool_call";
    case "tool":
      return block.type === "tool_result";
    default: {
      const exhaustive: never = role;
      void exhaustive;
      return false;
    }
  }
}

/** Tool arguments must be plain JSON objects so both protocols can encode them. */
function assertToolArgumentObjects(messages: readonly AgentMessage[]): void {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_call" && !isPlainObject(block.input)) {
        throw adapterError("unsupported_adapter_input");
      }
    }
  }
}

/** Tool schemas must be object schemas; both protocols pass them through as JSON Schema. */
function assertToolSchemas(tools: readonly AgentToolDefinition[]): void {
  for (const tool of tools) {
    if (!isPlainObject(tool.inputSchema)) {
      throw adapterError("unsupported_adapter_input");
    }
    if (tool.inputSchema.type !== "object") {
      throw adapterError("unsupported_adapter_input");
    }
  }
}

/**
 * Tool call / tool result correlation across the whole history.
 *
 * Every result must reference a call that is still pending, one call takes
 * exactly one result, and a turn may not continue while calls are unresolved.
 */
function assertToolCorrelation(messages: readonly AgentMessage[]): void {
  const pending = new Set<string>();
  const settled = new Set<string>();

  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      if (pending.size > 0) {
        throw adapterError("invalid_adapter_request");
      }
    }

    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "tool_call") {
          continue;
        }
        if (pending.has(block.id) || settled.has(block.id)) {
          throw adapterError("invalid_adapter_request");
        }
        pending.add(block.id);
      }
      continue;
    }

    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type !== "tool_result") {
          continue;
        }
        if (!pending.has(block.toolCallId)) {
          throw adapterError("invalid_adapter_request");
        }
        pending.delete(block.toolCallId);
        settled.add(block.toolCallId);
      }
    }
  }

  if (pending.size > 0) {
    throw adapterError("invalid_adapter_request");
  }
}

/**
 * Validates a request against the shared contract and then against the stricter
 * protocol subset this stage supports. Shared validator behaviour is untouched.
 */
export function assertAdapterRequest(request: unknown): void {
  runSharedValidation(request);
  const typed = request as ModelRequest;
  assertRoleBlockShape(typed.messages);
  assertToolArgumentObjects(typed.messages);
  assertToolSchemas(typed.tools);
  assertToolCorrelation(typed.messages);
}
