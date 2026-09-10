import { describe, expect, it } from "vitest";
import {
  AgentValidationError,
  validateAgentMessages,
  validateAgentToolDefinitions,
  validateModelRequest,
  type AgentMessage,
  type AgentToolDefinition,
  type ModelRequest,
} from "../packages/agent-core/src/index.js";

function textMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("agent contracts", () => {
  it("accepts a valid assistant tool call and matching tool result", () => {
    const messages: AgentMessage[] = [
      textMessage("run the tool"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "call-1", content: "ok" },
        ],
      },
    ];
    expect(() => validateAgentMessages(messages)).not.toThrow();
  });

  it("rejects a tool result that references an unknown toolCallId", () => {
    const messages: AgentMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "missing", content: "ok" },
        ],
      },
    ];
    expect(() => validateAgentMessages(messages)).toThrow(AgentValidationError);
  });

  it("rejects duplicate toolCallId values", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "a", input: {} },
          { type: "tool_call", id: "call-1", name: "b", input: {} },
        ],
      },
    ];
    expect(() => validateAgentMessages(messages)).toThrow(AgentValidationError);
  });

  it("rejects an empty tool name", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "", input: {} },
        ],
      },
    ];
    expect(() => validateAgentMessages(messages)).toThrow(AgentValidationError);
  });

  it("preserves nested JSON objects and arrays in tool input", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "search",
            input: {
              query: "nested",
              filters: { tags: ["a", "b"], limit: 3 },
              flags: [true, null, 1.5],
            },
          },
        ],
      },
    ];
    expect(() => validateAgentMessages(messages)).not.toThrow();
  });

  it("rejects ModelRequest fields that look like credentials", () => {
    const request = {
      requestId: "req-1",
      routeId: "route-1",
      model: "model-1",
      messages: [textMessage("hi")],
      tools: [],
      maxTokens: 128,
      apiKey: "sk-secret",
      authorization: "Bearer nope",
      headers: { Authorization: "Bearer nope" },
      baseUrl: "https://example.invalid",
      endpoint: "https://example.invalid/v1",
      providerSecret: "nope",
    } as unknown as ModelRequest;

    expect(() => validateModelRequest(request)).toThrow(AgentValidationError);
  });

  it("rejects invalid maxTokens", () => {
    const base: ModelRequest = {
      requestId: "req-1",
      routeId: "route-1",
      model: "model-1",
      messages: [textMessage("hi")],
      tools: [],
      maxTokens: 128,
    };

    for (const maxTokens of [0, -1, 1.5, Number.NaN]) {
      expect(() => validateModelRequest({ ...base, maxTokens })).toThrow(
        AgentValidationError,
      );
    }
  });

  it("does not leak secrets in validation errors", () => {
    const secret = "TOP_SECRET_DO_NOT_LEAK_VALUE_9f3a";
    const messages: AgentMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "missing", content: secret },
        ],
      },
    ];

    let message = "";
    try {
      validateAgentMessages(messages);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(secret);
    expect(message).not.toMatch(/Authorization/i);
    expect(message).not.toMatch(/https?:\/\//i);
    expect(message).not.toMatch(/api[_-]?key/i);
  });

  it("rejects duplicate tool definition names", () => {
    const tools: AgentToolDefinition[] = [
      { name: "read_file", description: "read", inputSchema: { type: "object" } },
      { name: "read_file", description: "read again", inputSchema: { type: "object" } },
    ];
    expect(() => validateAgentToolDefinitions(tools)).toThrow(AgentValidationError);
  });

  it("accepts valid tool definitions", () => {
    const tools: AgentToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];
    expect(() => validateAgentToolDefinitions(tools)).not.toThrow();
  });
});
