export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type AgentContentBlock =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_result";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  readonly role: AgentRole;
  readonly content: readonly AgentContentBlock[];
}

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface ModelRequest {
  readonly requestId: string;
  readonly routeId: string;
  readonly model: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentToolDefinition[];
  readonly maxTokens: number;
}

export class AgentValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentValidationError";
    this.code = code;
  }
}

const FORBIDDEN_REQUEST_FIELDS = new Set([
  "apikey",
  "api_key",
  "token",
  "authorization",
  "headers",
  "baseurl",
  "base_url",
  "endpoint",
  "providersecret",
  "provider_secret",
  "refreshtoken",
  "refresh_token",
  "oauth",
]);

const ALLOWED_AGENT_ROLES: ReadonlySet<string> = new Set<AgentRole>([
  "system",
  "user",
  "assistant",
  "tool",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return typeof value === "number" && Number.isFinite(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (isPlainObject(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }
  return false;
}

function assertNonEmptyString(value: unknown, code: string, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentValidationError(code, `${label} must be a non-empty string.`);
  }
}

function assertJsonValue(value: unknown, code: string, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new AgentValidationError(
      code,
      `${label} must be a JSON-serializable value.`,
    );
  }
}

/**
 * Runtime role validation. The rejected value is never echoed into the error
 * message so that untrusted provider payloads cannot leak through validation.
 */
function assertAgentRole(value: unknown): asserts value is AgentRole {
  if (typeof value !== "string" || !ALLOWED_AGENT_ROLES.has(value)) {
    throw new AgentValidationError(
      "invalid_role",
      "Each message role must be one of: system, user, assistant, tool.",
    );
  }
}

export function validateAgentMessages(messages: readonly AgentMessage[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AgentValidationError(
      "empty_messages",
      "messages must be a non-empty array.",
    );
  }

  const seenToolCallIds = new Set<string>();

  for (const message of messages) {
    if (!isPlainObject(message)) {
      throw new AgentValidationError(
        "invalid_message",
        "Each message must be an object.",
      );
    }

    assertAgentRole(message.role);

    if (!Array.isArray(message.content) || message.content.length === 0) {
      throw new AgentValidationError(
        "empty_content",
        "Each message must contain at least one content block.",
      );
    }

    for (const block of message.content) {
      if (!isPlainObject(block)) {
        throw new AgentValidationError(
          "invalid_content_block",
          "Each content block must be an object.",
        );
      }

      if (block.type === "text") {
        if (typeof block.text !== "string") {
          throw new AgentValidationError(
            "invalid_text",
            "Text content must be a string.",
          );
        }
        continue;
      }

      if (block.type === "tool_call") {
        assertNonEmptyString(block.id, "empty_tool_call_id", "tool_call.id");
        assertNonEmptyString(block.name, "empty_tool_name", "tool_call.name");
        if (seenToolCallIds.has(block.id)) {
          throw new AgentValidationError(
            "duplicate_tool_call_id",
            "tool_call.id values must be unique within a request.",
          );
        }
        seenToolCallIds.add(block.id);
        assertJsonValue(block.input, "invalid_tool_input", "tool_call.input");
        continue;
      }

      if (block.type === "tool_result") {
        assertNonEmptyString(
          block.toolCallId,
          "empty_tool_result_id",
          "tool_result.toolCallId",
        );
        if (typeof block.content !== "string") {
          throw new AgentValidationError(
            "invalid_tool_result_content",
            "tool_result.content must be a string.",
          );
        }
        if (!seenToolCallIds.has(block.toolCallId)) {
          throw new AgentValidationError(
            "unknown_tool_call_ref",
            "tool_result.toolCallId must reference a prior tool_call.id.",
          );
        }
        continue;
      }

      throw new AgentValidationError(
        "unknown_content_block",
        "Unsupported content block type.",
      );
    }
  }
}

export function validateAgentToolDefinitions(
  tools: readonly AgentToolDefinition[],
): void {
  if (!Array.isArray(tools)) {
    throw new AgentValidationError(
      "invalid_tools",
      "tools must be an array.",
    );
  }

  const seenNames = new Set<string>();

  for (const tool of tools) {
    if (!isPlainObject(tool)) {
      throw new AgentValidationError(
        "invalid_tool_definition",
        "Each tool definition must be an object.",
      );
    }

    assertNonEmptyString(tool.name, "empty_tool_name", "tool.name");
    if (seenNames.has(tool.name)) {
      throw new AgentValidationError(
        "duplicate_tool_name",
        "tool.name values must be unique within a request.",
      );
    }
    seenNames.add(tool.name);

    if (typeof tool.description !== "string") {
      throw new AgentValidationError(
        "invalid_tool_description",
        "tool.description must be a string.",
      );
    }

    assertJsonValue(
      tool.inputSchema,
      "invalid_tool_input_schema",
      "tool.inputSchema",
    );
  }
}

export function validateModelRequest(request: ModelRequest): void {
  if (!isPlainObject(request)) {
    throw new AgentValidationError(
      "invalid_request",
      "Model request must be an object.",
    );
  }

  for (const key of Object.keys(request)) {
    if (FORBIDDEN_REQUEST_FIELDS.has(key.toLowerCase())) {
      throw new AgentValidationError(
        "forbidden_request_field",
        "Model request contains a field that is not allowed on Agent Core requests.",
      );
    }
  }

  assertNonEmptyString(request.requestId, "empty_request_id", "requestId");
  assertNonEmptyString(request.routeId, "empty_route_id", "routeId");
  assertNonEmptyString(request.model, "empty_model", "model");

  if (
    typeof request.maxTokens !== "number" ||
    !Number.isInteger(request.maxTokens) ||
    request.maxTokens <= 0
  ) {
    throw new AgentValidationError(
      "invalid_max_tokens",
      "maxTokens must be a positive integer.",
    );
  }

  if (!Array.isArray(request.messages)) {
    throw new AgentValidationError(
      "invalid_messages",
      "messages must be an array.",
    );
  }
  validateAgentMessages(request.messages);

  if (!Array.isArray(request.tools)) {
    throw new AgentValidationError(
      "invalid_tools",
      "tools must be an array.",
    );
  }
  validateAgentToolDefinitions(request.tools);
}
