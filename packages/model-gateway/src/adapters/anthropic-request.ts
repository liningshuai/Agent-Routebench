import type {
  AgentContentBlock,
  JsonValue,
  ModelRequest,
} from "@agent-workbench/agent-contracts";
import { assertAdapterRequest } from "./request-validation.js";
import type { EncodedModelRequest } from "./types.js";

type BlockRecord = { readonly [key: string]: JsonValue };

interface RoleGroup {
  readonly role: "assistant" | "user";
  readonly content: JsonValue[];
}

/**
 * Deep copy so the encoded body never shares a mutable nested object with the
 * caller's request. Inputs were already validated as JSON.
 */
function cloneJson(value: JsonValue): JsonValue {
  return structuredClone(value) as JsonValue;
}

/** Merges a run of adjacent text blocks, preserving order and inserting nothing. */
function contentBlocks(content: readonly AgentContentBlock[]): JsonValue[] {
  const out: JsonValue[] = [];
  let pendingText: string[] = [];

  const flushText = (): void => {
    if (pendingText.length === 0) {
      return;
    }
    out.push({ type: "text", text: pendingText.join("") } as unknown as JsonValue);
    pendingText = [];
  };

  for (const block of content) {
    if (block.type === "text") {
      pendingText.push(block.text);
      continue;
    }
    flushText();
    if (block.type === "tool_call") {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: cloneJson(block.input),
      } as unknown as JsonValue);
    }
  }

  flushText();
  return out;
}

function toolResultBlocks(content: readonly AgentContentBlock[]): JsonValue[] {
  const out: JsonValue[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") {
      continue;
    }
    const encoded: BlockRecord = {
      type: "tool_result",
      tool_use_id: block.toolCallId,
      content: block.content,
    };
    if (block.isError !== undefined) {
      (encoded as Record<string, JsonValue>).is_error = block.isError;
    }
    out.push(encoded as unknown as JsonValue);
  }
  return out;
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

function encodeTools(request: ModelRequest): JsonValue[] {
  return request.tools.map(
    (tool) =>
      ({
        name: tool.name,
        description: tool.description,
        input_schema: cloneJson(tool.inputSchema),
      }) as unknown as JsonValue,
  );
}

/**
 * Encodes a ModelRequest into an Anthropic Messages request body.
 *
 * Streaming only (`stream: true`), text plus client side tool use, no prompt
 * caching, no server tools and no thinking configuration.
 */
export function encodeAnthropicMessagesRequest(
  request: ModelRequest,
): EncodedModelRequest {
  assertAdapterRequest(request);

  let systemText: string | null = null;
  const groups: RoleGroup[] = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      systemText = textOf(message.content);
      continue;
    }

    const role: "assistant" | "user" =
      message.role === "assistant" ? "assistant" : "user";
    const encoded =
      message.role === "tool"
        ? toolResultBlocks(message.content)
        : contentBlocks(message.content);

    const last = groups[groups.length - 1];
    if (last !== undefined && last.role === role) {
      last.content.push(...encoded);
    } else {
      groups.push({ role, content: encoded });
    }
  }

  const body: Record<string, JsonValue> = {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    messages: groups.map(
      (group) =>
        ({
          role: group.role,
          content: group.content,
        }) as unknown as JsonValue,
    ),
  };

  if (systemText !== null) {
    body.system = systemText;
  }

  if (request.tools.length > 0) {
    body.tools = encodeTools(request);
  }

  return { body: body as EncodedModelRequest["body"] };
}
