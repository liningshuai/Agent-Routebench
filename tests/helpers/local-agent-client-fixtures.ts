import type { AgentEvent } from "@agent-workbench/agent-core";
import type { LocalAgentSession } from "@agent-workbench/local-agent-api";

export interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

export function session(id = "sess-1"): LocalAgentSession {
  return {
    id,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  };
}

export function textEvent(
  text = "hello",
  requestId = "req-1",
): AgentEvent {
  return { type: "text_delta", requestId, text };
}

export function completedEvent(requestId = "req-1"): AgentEvent {
  return { type: "completed", requestId };
}

export function errorEvent(requestId = "req-1"): AgentEvent {
  return {
    type: "error",
    requestId,
    code: "runner_error",
    message: "Agent runner failed.",
    retryable: false,
  };
}

export function ndjson(events: readonly AgentEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function streamFromChunks(
  chunks: readonly (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

export function response(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body as BodyInit, { status, headers });
}

export function jsonResponse(value: unknown, status = 200): Response {
  return response(JSON.stringify(value), status, {
    "content-type": "application/json",
  });
}

export function streamResponse(events: readonly AgentEvent[]): Response {
  return response(
    streamFromChunks([ndjson(events)]),
    200,
    { "content-type": "application/x-ndjson" },
  );
}

export function userRequest(message = "hello") {
  return {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: message }] }],
  };
}
