import { describe, expect, it } from "vitest";
import {
  AdapterError,
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter,
} from "../packages/model-gateway/src/index.js";
import {
  assistantMessage,
  makeRequest,
  systemMessage,
  textBlock,
  toolCallBlock,
  toolDefinition,
  toolMessage,
  toolResultBlock,
  userMessage,
} from "./helpers/adapter-fixtures.js";

const anthropic = createAnthropicMessagesAdapter();

function openai(tokenLimitField?: "max_tokens" | "max_completion_tokens") {
  return tokenLimitField === undefined
    ? createOpenAIChatCompletionsAdapter()
    : createOpenAIChatCompletionsAdapter({ tokenLimitField });
}

function expectAdapterError(run: () => unknown, code: string): AdapterError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected AdapterError(${code})`).toBeInstanceOf(AdapterError);
  const adapterError = caught as AdapterError;
  expect(adapterError.code).toBe(code);
  return adapterError;
}

describe("task 3 adapter requests — Anthropic Messages encoding", () => {
  it("encodes a plain text request into the exact Anthropic body", () => {
    const encoded = anthropic.encode(makeRequest());

    expect(encoded.body).toEqual({
      model: "offline-model",
      max_tokens: 256,
      stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
  });

  it("lifts the leading system message to the top level and omits it when absent", () => {
    const withSystem = anthropic.encode(
      makeRequest({
        messages: [systemMessage("You are terse."), userMessage(textBlock("hi"))],
      }),
    );

    expect(withSystem.body).toEqual({
      model: "offline-model",
      max_tokens: 256,
      stream: true,
      system: "You are terse.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    const withoutSystem = anthropic.encode(makeRequest());
    expect(Object.keys(withoutSystem.body)).not.toContain("system");
  });

  it("joins adjacent text blocks in order without inserting text", () => {
    const encoded = anthropic.encode(
      makeRequest({
        messages: [userMessage(textBlock("alpha"), textBlock("beta"), textBlock("gamma"))],
      }),
    );

    expect(encoded.body).toEqual({
      model: "offline-model",
      max_tokens: 256,
      stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "alphabetagamma" }] },
      ],
    });
  });

  it("maps tool definitions to name, description and input_schema", () => {
    const encoded = anthropic.encode(
      makeRequest({
        tools: [
          toolDefinition("read_file", "Read a file", {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          }),
        ],
      }),
    );

    expect(encoded.body).toEqual({
      model: "offline-model",
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });
  });

  it("omits tools when the request declares none", () => {
    const encoded = anthropic.encode(makeRequest({ tools: [] }));
    expect(Object.keys(encoded.body)).not.toContain("tools");
  });

  it("encodes the full tool history with tool_use and tool_result blocks", () => {
    const encoded = anthropic.encode(
      makeRequest({
        messages: [
          systemMessage("Be careful."),
          userMessage(textBlock("read the file")),
          assistantMessage(
            textBlock("sure"),
            toolCallBlock("call-1", "read_file", { path: "a.txt" }),
          ),
          toolMessage(toolResultBlock("call-1", "file contents")),
        ],
        tools: [toolDefinition("read_file", "Read", { type: "object" })],
      }),
    );

    expect(encoded.body).toEqual({
      model: "offline-model",
      max_tokens: 256,
      stream: true,
      system: "Be careful.",
      messages: [
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: { path: "a.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "file contents",
            },
          ],
        },
      ],
      tools: [
        { name: "read_file", description: "Read", input_schema: { type: "object" } },
      ],
    });
  });

  it("keeps is_error when the tool result is an error", () => {
    const encoded = anthropic.encode(
      makeRequest({
        messages: [
          assistantMessage(toolCallBlock("call-1", "read_file", { path: "a.txt" })),
          toolMessage(toolResultBlock("call-1", "boom", true)),
        ],
      }),
    );

    const messages = encoded.body.messages as readonly Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "boom",
          is_error: true,
        },
      ],
    });
  });

  it("merges consecutive same-role messages into one content array", () => {
    const encoded = anthropic.encode(
      makeRequest({
        messages: [
          userMessage(textBlock("read it")),
          assistantMessage(toolCallBlock("call-1", "alpha", {})),
          toolMessage(toolResultBlock("call-1", "r1")),
          userMessage(textBlock("and the second file")),
          assistantMessage(textBlock("ok"), toolCallBlock("call-2", "beta", { n: 1 })),
          toolMessage(toolResultBlock("call-2", "r2")),
        ],
      }),
    );

    expect(encoded.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "alpha", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "r1" },
          { type: "text", text: "and the second file" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "call-2", name: "beta", input: { n: 1 } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-2", content: "r2" }],
      },
    ]);
  });

  it("merges two tool results from one assistant turn into a single user message", () => {
    const encoded = anthropic.encode(
      makeRequest({
        messages: [
          assistantMessage(
            toolCallBlock("call-1", "alpha", {}),
            toolCallBlock("call-2", "beta", {}),
          ),
          toolMessage(toolResultBlock("call-1", "r1"), toolResultBlock("call-2", "r2")),
        ],
      }),
    );

    expect(encoded.body.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "alpha", input: {} },
          { type: "tool_use", id: "call-2", name: "beta", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "r1" },
          { type: "tool_result", tool_use_id: "call-2", content: "r2" },
        ],
      },
    ]);
  });

  it("never sends request identity or credential shaped fields", () => {
    const encoded = anthropic.encode(
      makeRequest({
        requestId: "req-should-not-travel",
        routeId: "route-should-not-travel",
      }),
    );

    const keys = Object.keys(encoded.body);
    expect(keys).toEqual(["model", "max_tokens", "stream", "messages"]);
    const serialized = JSON.stringify(encoded.body);
    expect(serialized).not.toContain("req-should-not-travel");
    expect(serialized).not.toContain("route-should-not-travel");
    for (const forbidden of [
      "apiKey",
      "api_key",
      "token",
      "authorization",
      "headers",
      "credentialRef",
      "baseUrl",
      "url",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("task 3 adapter requests — OpenAI Chat Completions encoding", () => {
  it("encodes a plain text request into the exact Chat Completions body", () => {
    const encoded = openai().encode(makeRequest());

    expect(encoded.body).toEqual({
      model: "offline-model",
      stream: true,
      n: 1,
      stream_options: { include_usage: true },
      max_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("omits system when absent and maps it to a system message when present", () => {
    const encoded = openai().encode(
      makeRequest({
        messages: [systemMessage("Be terse."), userMessage(textBlock("hi"))],
      }),
    );

    expect(encoded.body.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ]);

    const withoutSystem = openai().encode(makeRequest());
    expect(withoutSystem.body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("switches the token limit field when configured and never emits both", () => {
    const withMaxTokens = openai("max_tokens").encode(makeRequest());
    expect(Object.keys(withMaxTokens.body)).toContain("max_tokens");
    expect(Object.keys(withMaxTokens.body)).not.toContain("max_completion_tokens");
    expect(withMaxTokens.body.max_tokens).toBe(256);

    const withMaxCompletion = openai("max_completion_tokens").encode(makeRequest());
    expect(Object.keys(withMaxCompletion.body)).toContain("max_completion_tokens");
    expect(Object.keys(withMaxCompletion.body)).not.toContain("max_tokens");
    expect(withMaxCompletion.body.max_completion_tokens).toBe(256);
  });

  it("rejects an unsupported token limit field at runtime", () => {
    expectAdapterError(
      () =>
        createOpenAIChatCompletionsAdapter({
          tokenLimitField: "max_output_tokens" as unknown as "max_tokens",
        }),
      "invalid_adapter_options",
    );
  });

  it("maps tool definitions to type function with a parameters schema", () => {
    const encoded = openai().encode(
      makeRequest({
        tools: [
          toolDefinition("read_file", "Read a file", {
            type: "object",
            properties: { path: { type: "string" } },
          }),
        ],
      }),
    );

    expect(encoded.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("omits tools when the request declares none", () => {
    const encoded = openai().encode(makeRequest({ tools: [] }));
    expect(Object.keys(encoded.body)).not.toContain("tools");
  });

  it("encodes assistant tool calls and wraps tool results in the JSON envelope", () => {
    const encoded = openai().encode(
      makeRequest({
        messages: [
          userMessage(textBlock("read it")),
          assistantMessage(
            textBlock("on it"),
            toolCallBlock("call-1", "read_file", { path: "a.txt" }),
          ),
          toolMessage(toolResultBlock("call-1", "contents")),
        ],
        tools: [toolDefinition("read_file", "Read", { type: "object" })],
      }),
    );

    expect(encoded.body.messages).toEqual([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "a.txt" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: JSON.stringify({ content: "contents", isError: false }),
      },
    ]);
  });

  it("uses a null content for assistant messages that only call tools", () => {
    const encoded = openai().encode(
      makeRequest({
        messages: [
          assistantMessage(toolCallBlock("call-1", "ping", {})),
          toolMessage(toolResultBlock("call-1", "pong")),
        ],
      }),
    );

    expect(encoded.body.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "ping", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: JSON.stringify({ content: "pong", isError: false }),
      },
    ]);
  });

  it("stamps isError true inside the tool result envelope", () => {
    const encoded = openai().encode(
      makeRequest({
        messages: [
          assistantMessage(toolCallBlock("call-1", "read_file", { path: "a.txt" })),
          toolMessage(toolResultBlock("call-1", "denied", true)),
        ],
      }),
    );

    const messages = encoded.body.messages as readonly Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: JSON.stringify({ content: "denied", isError: true }),
    });
    expect(messages[1].content).toBe('{"content":"denied","isError":true}');
  });

  it("emits one tool message per tool result block and preserves order", () => {
    const encoded = openai().encode(
      makeRequest({
        messages: [
          assistantMessage(
            toolCallBlock("call-1", "alpha", {}),
            toolCallBlock("call-2", "beta", {}),
          ),
          toolMessage(toolResultBlock("call-1", "r1"), toolResultBlock("call-2", "r2")),
        ],
      }),
    );

    const messages = encoded.body.messages as readonly Record<string, unknown>[];
    expect(messages).toHaveLength(3);
    expect(messages[1].tool_call_id).toBe("call-1");
    expect(messages[2].tool_call_id).toBe("call-2");
  });

  it("never sends request identity or credential shaped fields", () => {
    const encoded = openai().encode(
      makeRequest({ requestId: "req-should-not-travel", routeId: "route-nope" }),
    );

    const keys = Object.keys(encoded.body);
    expect(keys).toEqual([
      "model",
      "stream",
      "n",
      "stream_options",
      "max_tokens",
      "messages",
    ]);
    expect(JSON.stringify(encoded.body)).not.toContain("req-should-not-travel");
    expect(JSON.stringify(encoded.body)).not.toContain("route-nope");
  });
});

describe("task 3 adapter requests — shared history validation", () => {
  it("rejects a system message that is not at the very beginning", () => {
    for (const adapter of [anthropic, openai()]) {
      expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({
              messages: [userMessage(textBlock("hi")), systemMessage("late")],
            }),
          ),
        "invalid_adapter_request",
      );
    }
  });

  it("rejects block types that the protocol subset cannot express", () => {
    const rejectCases: Array<[string, () => unknown]> = [
      [
        "system with tool_call",
        () =>
          anthropic.encode(
            makeRequest({
              messages: [
                {
                  role: "system",
                  content: [toolCallBlock("call-1", "t", {})],
                },
              ],
            }),
          ),
      ],
      [
        "user with tool_call",
        () =>
          anthropic.encode(
            makeRequest({ messages: [userMessage(toolCallBlock("call-1", "t", {}))] }),
          ),
      ],
      [
        "user with tool_result",
        () =>
          anthropic.encode(
            makeRequest({
              messages: [
                assistantMessage(toolCallBlock("call-1", "t", {})),
                toolMessage(toolResultBlock("call-1", "x")),
                userMessage(toolResultBlock("call-1", "x")),
              ],
            }),
          ),
      ],
      [
        "assistant with tool_result",
        () =>
          anthropic.encode(
            makeRequest({
              messages: [
                assistantMessage(toolCallBlock("call-1", "t", {})),
                toolMessage(toolResultBlock("call-1", "x")),
                assistantMessage(toolResultBlock("call-1", "x")),
              ],
            }),
          ),
      ],
      [
        "tool with text",
        () =>
          anthropic.encode(
            makeRequest({ messages: [toolMessage(textBlock("plain text"))] }),
          ),
      ],
      [
        "openai user with tool_call",
        () =>
          openai().encode(
            makeRequest({ messages: [userMessage(toolCallBlock("call-1", "t", {}))] }),
          ),
      ],
      [
        "openai tool with text",
        () =>
          openai().encode(
            makeRequest({ messages: [toolMessage(textBlock("plain text"))] }),
          ),
      ],
    ];

    for (const [label, run] of rejectCases) {
      expectAdapterError(run, "invalid_adapter_request");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("rejects an orphan tool result that references nothing", () => {
    for (const adapter of [anthropic, openai()]) {
      expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({ messages: [toolMessage(toolResultBlock("call-ghost", "x"))] }),
          ),
        "invalid_adapter_request",
      );
    }
  });

  it("rejects a duplicated tool result for the same call", () => {
    for (const adapter of [anthropic, openai()]) {
      expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({
              messages: [
                assistantMessage(toolCallBlock("call-1", "t", {})),
                toolMessage(toolResultBlock("call-1", "first")),
                toolMessage(toolResultBlock("call-1", "second")),
              ],
            }),
          ),
        "invalid_adapter_request",
      );
    }
  });

  it("rejects a tool call that never receives a result", () => {
    for (const adapter of [anthropic, openai()]) {
      expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({
              messages: [
                userMessage(textBlock("go")),
                assistantMessage(toolCallBlock("call-1", "t", {})),
              ],
            }),
          ),
        "invalid_adapter_request",
      );
    }
  });

  it("rejects continuing the conversation before tool results arrive", () => {
    for (const adapter of [anthropic, openai()]) {
      expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({
              messages: [
                assistantMessage(toolCallBlock("call-1", "t", {})),
                userMessage(textBlock("next turn")),
              ],
            }),
          ),
        "invalid_adapter_request",
      );
    }
  });

  it("rejects tool inputs that are not plain JSON objects", () => {
    for (const input of ["a string", 42, true, null, ["array"]]) {
      for (const adapter of [anthropic, openai()]) {
        expectAdapterError(
          () =>
            adapter.encode(
              makeRequest({
                messages: [
                  assistantMessage(
                    toolCallBlock("call-1", "t", input as unknown as Record<string, unknown>),
                  ),
                  toolMessage(toolResultBlock("call-1", "ok")),
                ],
              }),
            ),
          "unsupported_adapter_input",
        );
      }
    }
  });

  it("rejects tool schemas that are not object schemas", () => {
    for (const schema of ["string", [{}, {}]]) {
      for (const adapter of [anthropic, openai()]) {
        expectAdapterError(
          () =>
            adapter.encode(
              makeRequest({
                tools: [
                  {
                    name: "t",
                    description: "d",
                    inputSchema: schema as unknown as never,
                  },
                ],
              }),
            ),
          "unsupported_adapter_input",
        );
      }
    }

    for (const adapter of [anthropic, openai()]) {
      expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({
              tools: [
                {
                  name: "t",
                  description: "d",
                  inputSchema: { type: "array" } as unknown as never,
                },
              ],
            }),
          ),
        "unsupported_adapter_input",
      );
    }
  });

  it("rejects cyclic JSON without leaking a stack overflow", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    for (const adapter of [anthropic, openai()]) {
      const error = expectAdapterError(
        () =>
          adapter.encode(
            makeRequest({
              messages: [
                assistantMessage(toolCallBlock("call-1", "loop_tool", cyclic)),
                toolMessage(toolResultBlock("call-1", "ok")),
              ],
            }),
          ),
        "unsupported_adapter_input",
      );
      expect(error.message).not.toContain("call stack");
      expect(error.message).not.toContain("RangeError");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("rejects a non boolean isError flag", () => {
    expectAdapterError(
      () =>
        anthropic.encode(
          makeRequest({
            messages: [
              assistantMessage(toolCallBlock("call-1", "t", {})),
              {
                role: "tool",
                content: [
                  {
                    type: "tool_result",
                    toolCallId: "call-1",
                    content: "ok",
                    isError: "yes" as unknown as boolean,
                  },
                ],
              },
            ],
          }),
        ),
      "invalid_adapter_request",
    );
  });

  it("propagates shared contract validation failures as adapter errors", () => {
    const request = makeRequest({
      messages: [
        { role: "user", content: [{ type: "text", text: "x" }] },
      ],
      maxTokens: 0,
    });

    expectAdapterError(() => anthropic.encode(request), "invalid_adapter_request");
    expectAdapterError(() => openai().encode(request), "invalid_adapter_request");
  });

  it("uses fixed, non leaking adapter error messages", () => {
    const error = expectAdapterError(
      () =>
        anthropic.encode(
          makeRequest({
            messages: [toolMessage(toolResultBlock("call-ghost", "TOP_SECRET_FIXTURE"))],
          }),
        ),
      "invalid_adapter_request",
    );

    expect(error.message).not.toContain("TOP_SECRET_FIXTURE");
    expect(error.message).not.toContain("call-ghost");
    expect(error.message).not.toMatch(/authorization/i);
    expect(error.message).not.toMatch(/toolCallId/i);
  });
});

describe("task 3 adapter requests — copy isolation", () => {
  it("does not mutate the caller request", () => {
    const request = makeRequest({
      messages: [
        systemMessage("sys"),
        assistantMessage(toolCallBlock("call-1", "t", { path: "a.txt" })),
        toolMessage(toolResultBlock("call-1", "ok")),
      ],
      tools: [toolDefinition("t", "d", { type: "object", properties: {} })],
    });
    const snapshot = JSON.stringify(request);

    const anthropicBody = anthropic.encode(request).body;
    const openaiBody = openai().encode(request).body;

    expect(JSON.stringify(request)).toBe(snapshot);
    expect(anthropicBody).toBeDefined();
    expect(openaiBody).toBeDefined();
  });

  it("does not share mutable nested objects with the request", () => {
    const schema = { type: "object", properties: { nested: { type: "string" } } };
    const toolInput = { path: "a.txt", options: { deep: true } };
    const request = makeRequest({
      messages: [
        assistantMessage(toolCallBlock("call-1", "t", toolInput)),
        toolMessage(toolResultBlock("call-1", "ok")),
      ],
      tools: [toolDefinition("t", "d", schema)],
    });

    const encoded = anthropic.encode(request);
    const openaiEncoded = openai().encode(request);

    toolInput.options.deep = false;
    (schema.properties.nested as { type: string }).type = "number";

    expect(encoded.body.tools).toEqual([
      {
        name: "t",
        description: "d",
        input_schema: { type: "object", properties: { nested: { type: "string" } } },
      },
    ]);
    const messages = encoded.body.messages as readonly Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "t",
          input: { path: "a.txt", options: { deep: true } },
        },
      ],
    });
    expect(openaiEncoded.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "t",
          description: "d",
          parameters: { type: "object", properties: { nested: { type: "string" } } },
        },
      },
    ]);
  });

  it("does not let callers pollute the encoded body back into the request shape", () => {
    const request = makeRequest();
    const encoded = anthropic.encode(request);

    const mutableBody = encoded.body as Record<string, unknown>;
    mutableBody.model = "hacked-model";
    const messages = mutableBody.messages as Array<{ content: Array<{ text?: string }> }>;
    messages[0].content[0].text = "hacked";

    expect(request.model).toBe("offline-model");
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });
});
