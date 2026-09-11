import type { AgentEvent } from "@agent-workbench/agent-core";
import type { LocalAgentSession, LocalAgentTurnRequest } from "@agent-workbench/local-agent-api";

export interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
}

export type FakeFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export function createFakeFetch(responses: FakeResponse[]): FakeFetch {
  let callCount = 0;

  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (callCount >= responses.length) {
      throw new Error("FakeFetch: no more responses");
    }

    const fake = responses[callCount++];
    const headers = new Headers(fake.headers);

    let body: BodyInit | null = null;
    if (fake.body !== undefined) {
      if (typeof fake.body === "string") {
        body = fake.body;
      } else if (fake.body instanceof Uint8Array) {
        body = fake.body as any;
      } else {
        body = fake.body as ReadableStream<Uint8Array>;
      }
    }

    return new Response(body, {
      status: fake.status,
      headers,
    });
  };
}

export function makeHealthResponse(): FakeResponse {
  return {
    status: 200,
    body: JSON.stringify({ status: "ok", version: "v1" }),
  };
}

export function makeSessionResponse(id: string = "sess-123"): FakeResponse {
  const session: LocalAgentSession = {
    id,
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(session),
  };
}

export function makeEventsResponse(events: readonly AgentEvent[]): FakeResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events),
  };
}

export function makeCancelResponse(): FakeResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cancelled: true }),
  };
}

export function makeNDJSONStream(events: readonly AgentEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        const line = JSON.stringify(events[index++]) + "\n";
        controller.enqueue(encoder.encode(line));
      } else {
        controller.close();
      }
    },
  });
}

export function makeStreamResponse(events: readonly AgentEvent[]): FakeResponse {
  return {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
    body: makeNDJSONStream(events),
  };
}

export function makeTextDeltaEvent(requestId: string, text: string): AgentEvent {
  return { type: "text_delta", requestId, text };
}

export function makeCompletedEvent(requestId: string): AgentEvent {
  return { type: "completed", requestId };
}

export function makeErrorEvent(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean,
): AgentEvent {
  return { type: "error", requestId, code, message, retryable };
}

export function makeRouteSelectedEvent(
  requestId: string,
  routeId: string,
  model: string,
): AgentEvent {
  return { type: "route_selected", requestId, routeId, model };
}

export function makeUsageEvent(
  requestId: string,
  inputTokens: number,
  outputTokens: number,
): AgentEvent {
  return { type: "usage", requestId, inputTokens, outputTokens };
}

export function makeToolCallEvent(
  requestId: string,
  id: string,
  name: string,
  input: unknown,
): AgentEvent {
  return { type: "tool_call", requestId, id, name, input: input as any };
}
