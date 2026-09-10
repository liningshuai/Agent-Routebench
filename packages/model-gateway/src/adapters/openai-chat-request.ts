import type {
  AgentContentBlock,
  JsonValue,
  ModelRequest,
} from "@agent-workbench/agent-contracts";
import { adapterError } from "./errors.js";
import { assertAdapterRequest } from "./request-validation.js";
import { OPENAI_TOKEN_LIMIT_FIELDS, type EncodedModelRequest } from "./types.js";

export type OpenAITokenLimitField = "max_tokens" | "max_completion_tokens";

function cloneJson(value: JsonValue): JsonValue {
  return structuredClone(value) as JsonValue;
}

function textOf(content: readonly AgentContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  return text;
}

function hasText(content: readonly AgentContentBlock[]): boolean {
  return content.some((block) => block.type === "text");
}

/**
 * The project's tool result envelope for Chat Completions.
 *
 * Chat Completions has no unified field equivalent to `tool_result.isError`, so
 * this project encodes the result as a fixed JSON envelope. The envelope is a
 * documented project convention, not an upstream field.
 */
export function encodeToolResultEnvelope(
  content: string,
  isError: boolean,
): string {
  return JSON.stringify({ content, isError });
}

function assistantToolCalls(content: readonly AgentContentBlock[]): JsonValue[] {
  const calls: JsonValue[] = [];
  for (const block of content) {
    if (block.type !== "tool_call") {
      continue;
    }
    calls.push({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(cloneJson(block.input)),
      },
    } as unknown as JsonValue);
  }
  return calls;
}

function toolMessages(content: readonly AgentContentBlock[]): JsonValue[] {
  const messages: JsonValue[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") {
      continue;
    }
    messages.push({
      role: "tool",
      tool_call_id: block.toolCallId,
      content: encodeToolResultEnvelope(block.content, block.isError === true),
    } as unknown as JsonValue);
  }
  return messages;
}

function encodeMessages(request: ModelRequest): JsonValue[] {
  const messages: JsonValue[] = [];

  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push(...toolMessages(message.content));
      continue;
    }

    if (message.role === "assistant") {
      const encoded: Record<string, JsonValue> = {
        role: "assistant",
        content: hasText(message.content) ? textOf(message.content) : null,
      };
      const calls = assistantToolCalls(message.content);
      if (calls.length > 0) {
        encoded.tool_calls = calls;
      }
      messages.push(encoded as unknown as JsonValue);
      continue;
    }

    messages.push({
      role: message.role === "system" ? "system" : "user",
      content: textOf(message.content),
    } as unknown as JsonValue);
  }

  return messages;
}

function encodeTools(request: ModelRequest): JsonValue[] {
  return request.tools.map(
    (tool) =>
      ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: cloneJson(tool.inputSchema),
        },
      }) as unknown as JsonValue,
  );
}

/** Validates the token limit field option and returns it. */
export function normalizeTokenLimitField(
  value: unknown,
): OpenAITokenLimitField {
  if (value === undefined) {
    return "max_tokens";
  }
  if (typeof value !== "string" || !OPENAI_TOKEN_LIMIT_FIELDS.has(value)) {
    throw adapterError("invalid_adapter_options");
  }
  return value as OpenAITokenLimitField;
}

/**
 * Encodes a ModelRequest into an OpenAI Chat Completions request body.
 *
 * Chat Completions only: no Responses API, no Codex or ChatGPT account flows,
 * no server side tools and no reasoning extensions.
 */
export function encodeOpenAIChatRequest(
  request: ModelRequest,
  tokenLimitField: OpenAITokenLimitField,
): EncodedModelRequest {
  assertAdapterRequest(request);

  const body: Record<string, JsonValue> = {
    model: request.model,
    stream: true,
    n: 1,
    stream_options: { include_usage: true },
  };

  // Exactly one token limit field is emitted; never both.
  body[tokenLimitField] = request.maxTokens;

  body.messages = encodeMessages(request);

  if (request.tools.length > 0) {
    body.tools = encodeTools(request);
  }

  return { body: body as EncodedModelRequest["body"] };
}
