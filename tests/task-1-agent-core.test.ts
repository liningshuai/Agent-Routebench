import { describe, expect, it, vi } from "vitest";
import { createAgentCore } from "../packages/agent-core/src/index.js";
import { DeterministicFakeModelGateway } from "../packages/model-gateway/src/index.js";
import type {
  AgentEvent,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "../packages/agent-core/src/index.js";

function makeRequest(): ModelRequest {
  return {
    requestId: "req-100",
    routeId: "route-a",
    model: "offline-model",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello agent" }],
      },
    ],
    tools: [],
    maxTokens: 32,
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("agent core", () => {
  it("emits route_selected first for a valid request", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [{ type: "text_delta", text: "hi" }, { type: "completed" }],
    });
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));

    expect(events[0]).toEqual({
      type: "route_selected",
      requestId: "req-100",
      routeId: "route-a",
      model: "offline-model",
    });
  });

  it("keeps text delta order", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        { type: "text_delta", text: "one" },
        { type: "text_delta", text: " two" },
        { type: "text_delta", text: " three" },
        { type: "completed" },
      ],
    });
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));
    const texts = events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.text : ""));

    expect(texts).toEqual(["one", " two", " three"]);
  });

  it("preserves tool call id semantics", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        {
          type: "tool_call",
          id: "call-77",
          name: "list_files",
          input: { directory: "src" },
        },
        { type: "completed" },
      ],
    });
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));
    const toolCall = events.find((event) => event.type === "tool_call");

    expect(toolCall).toEqual({
      type: "tool_call",
      requestId: "req-100",
      id: "call-77",
      name: "list_files",
      input: { directory: "src" },
    });
  });

  it("tags usage and completed with the requestId", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        { type: "usage", inputTokens: 8, outputTokens: 4 },
        { type: "completed" },
      ],
    });
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));

    expect(events).toContainEqual({
      type: "usage",
      requestId: "req-100",
      inputTokens: 8,
      outputTokens: 4,
    });
    expect(events).toContainEqual({
      type: "completed",
      requestId: "req-100",
    });
  });

  it("does not call the gateway for an invalid request", async () => {
    const streamSpy = vi.fn();
    const gateway: ModelGateway = {
      stream: streamSpy,
    };
    const core = createAgentCore(gateway);

    const invalid = {
      requestId: "",
      routeId: "route-a",
      model: "offline-model",
      messages: [],
      tools: [],
      maxTokens: 0,
    } as ModelRequest;

    const events = await collect(core.run(invalid));

    expect(streamSpy).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "route_selected")).toBe(false);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].code).toBe("empty_request_id");
      expect(events[0].requestId).toBe("");
      expect(events[0].retryable).toBe(false);
    }
  });

  it("converts gateway exceptions into a safe gateway_error", async () => {
    const gateway: ModelGateway = {
      stream: async function* stream() {
        throw new Error(
          "connect ECONNREFUSED https://api.example.invalid/v1 Authorization: Bearer sk-secret",
        );
      },
    };
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));
    const errorEvent = events.find((event) => event.type === "error");

    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.code).toBe("gateway_error");
      expect(errorEvent.requestId).toBe("req-100");
      expect(errorEvent.retryable).toBe(false);
      expect(errorEvent.message).not.toContain("ECONNREFUSED");
      expect(errorEvent.message).not.toContain("api.example.invalid");
      expect(errorEvent.message).not.toContain("Bearer");
      expect(errorEvent.message).not.toContain("sk-secret");
      expect(errorEvent.message).not.toContain("at ");
    }
  });

  it("forwards gateway error events without leaking raw transport details", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        {
          type: "error",
          code: "upstream_unavailable",
          message: "Provider unavailable",
          retryable: true,
        },
      ],
    });
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));
    const errorEvent = events.find((event) => event.type === "error");

    expect(errorEvent).toEqual({
      type: "error",
      requestId: "req-100",
      code: "upstream_unavailable",
      message: "Provider unavailable",
      retryable: true,
    });
    const serialized = JSON.stringify(errorEvent);
    expect(serialized).not.toMatch(/https?:\/\//i);
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
  });

  it("does not execute tools or start a second model request", async () => {
    const streamCalls: ModelRequest[] = [];
    const gateway: ModelGateway = {
      stream: async function* stream(request: ModelRequest) {
        streamCalls.push(request);
        const events: ModelStreamEvent[] = [
          {
            type: "tool_call",
            id: "call-1",
            name: "danger_tool",
            input: { command: "rm -rf /" },
          },
          { type: "completed" },
        ];
        for (const event of events) {
          yield event;
        }
      },
    };
    const core = createAgentCore(gateway);

    const events = await collect(core.run(makeRequest()));

    expect(streamCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "route_selected")).toHaveLength(1);
  });
});
