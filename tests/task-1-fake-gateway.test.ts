import { describe, expect, it, vi } from "vitest";
import { DeterministicFakeModelGateway } from "../packages/model-gateway/src/index.js";
import type { ModelRequest, ModelStreamEvent } from "../packages/model-gateway/src/index.js";

function makeRequest(): ModelRequest {
  return {
    requestId: "req-1",
    routeId: "route-1",
    model: "model-1",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
    tools: [],
    maxTokens: 64,
  };
}

async function collect(
  iterable: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("deterministic fake model gateway", () => {
  it("replays the same text scenario identically every time", async () => {
    const events: ModelStreamEvent[] = [
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "completed" },
    ];
    const gateway = new DeterministicFakeModelGateway({ events });
    const request = makeRequest();

    const first = await collect(gateway.stream(request));
    const second = await collect(gateway.stream(request));

    expect(first).toEqual(events);
    expect(second).toEqual(first);
    expect(first.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "usage",
      "completed",
    ]);
  });

  it("preserves tool call id, name, and input", async () => {
    const events: ModelStreamEvent[] = [
      {
        type: "tool_call",
        id: "call-42",
        name: "read_file",
        input: { path: "docs/readme.md", encoding: "utf8" },
      },
      { type: "usage", inputTokens: 3, outputTokens: 7 },
      { type: "completed" },
    ];
    const gateway = new DeterministicFakeModelGateway({ events });

    const received = await collect(gateway.stream(makeRequest()));

    expect(received[0]).toEqual({
      type: "tool_call",
      id: "call-42",
      name: "read_file",
      input: { path: "docs/readme.md", encoding: "utf8" },
    });
  });

  it("preserves stable gateway error code and retryable flag", async () => {
    const events: ModelStreamEvent[] = [
      {
        type: "error",
        code: "rate_limited",
        message: "Try again later",
        retryable: true,
      },
    ];
    const gateway = new DeterministicFakeModelGateway({ events });

    const received = await collect(gateway.stream(makeRequest()));

    expect(received).toEqual([
      {
        type: "error",
        code: "rate_limited",
        message: "Try again later",
        retryable: true,
      },
    ]);
  });

  it("does not let caller mutation pollute later streams", async () => {
    const events: ModelStreamEvent[] = [
      { type: "text_delta", text: "stable" },
      { type: "completed" },
    ];
    const gateway = new DeterministicFakeModelGateway({ events });

    const first = await collect(gateway.stream(makeRequest()));
    const mutable = first[0] as { type: "text_delta"; text: string };
    mutable.text = "mutated";

    const second = await collect(gateway.stream(makeRequest()));

    expect(second[0]).toEqual({ type: "text_delta", text: "stable" });
    expect(second[1]).toEqual({ type: "completed" });
  });

  it("does not let request mutation change internal scenario", async () => {
    const events: ModelStreamEvent[] = [
      { type: "text_delta", text: "from-scenario" },
      { type: "completed" },
    ];
    const gateway = new DeterministicFakeModelGateway({ events });
    const request = makeRequest();

    await collect(gateway.stream(request));
    const mutableRequest = request as { model: string; maxTokens: number };
    mutableRequest.model = "changed-model";
    mutableRequest.maxTokens = 1;

    const received = await collect(gateway.stream(request));

    expect(received).toEqual(events);
  });

  it("does not perform network calls", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const gateway = new DeterministicFakeModelGateway({
        events: [{ type: "text_delta", text: "offline" }, { type: "completed" }],
      });
      const received = await collect(gateway.stream(makeRequest()));
      expect(received).toHaveLength(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("constructor deep-clones nested tool input", async () => {
    const nestedInput = {
      query: "search",
      filters: { tags: ["a", "b"], limit: 3 },
      flags: [true, null, 1.5],
      nested: { deeper: { value: "original" } },
    };
    const events: ModelStreamEvent[] = [
      { type: "tool_call", id: "call-9", name: "search", input: nestedInput },
      { type: "completed" },
    ];
    const gateway = new DeterministicFakeModelGateway({ events });

    nestedInput.query = "mutated";
    nestedInput.filters.tags.push("mutated");
    nestedInput.nested.deeper.value = "mutated";

    const received = await collect(gateway.stream(makeRequest()));

    expect(received[0]).toEqual({
      type: "tool_call",
      id: "call-9",
      name: "search",
      input: {
        query: "search",
        filters: { tags: ["a", "b"], limit: 3 },
        flags: [true, null, 1.5],
        nested: { deeper: { value: "original" } },
      },
    });
  });

  it("emits aborted and stops mid-stream when the signal aborts", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        { type: "text_delta", text: "first" },
        { type: "text_delta", text: "second" },
        { type: "completed" },
      ],
    });
    const controller = new AbortController();

    const received: ModelStreamEvent[] = [];
    for await (const event of gateway.stream(makeRequest(), controller.signal)) {
      received.push(event);
      if (event.type === "text_delta") {
        controller.abort();
      }
    }

    expect(received.map((event) => event.type)).toEqual(["text_delta", "error"]);
    expect(received[received.length - 1]).toEqual({
      type: "error",
      code: "aborted",
      message: "Request aborted before completion.",
      retryable: false,
    });
  });

  it("does not emit completed when the signal is already aborted", async () => {
    const gateway = new DeterministicFakeModelGateway({
      events: [
        { type: "text_delta", text: "never" },
        { type: "completed" },
      ],
    });
    const controller = new AbortController();
    controller.abort();

    const received = await collect(gateway.stream(makeRequest(), controller.signal));

    expect(received.some((event) => event.type === "completed")).toBe(false);
    expect(received[0]?.type).toBe("error");
    if (received[0]?.type === "error") {
      expect(received[0].code).toBe("aborted");
      expect(received[0].retryable).toBe(false);
    }
  });
});
