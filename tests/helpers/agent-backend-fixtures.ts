import type { AgentEvent } from "../../packages/agent-core/src/index.js";
import type {
  AgentLoopEvent,
} from "../../packages/agent-runtime/src/index.js";
import type { ModelRequest } from "../../packages/agent-contracts/src/index.js";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
} from "../../packages/provider-registry/src/index.js";
import type { HttpResponse } from "../../packages/model-gateway/src/index.js";
import type { LocalAgentRunnerRequest } from "../../packages/local-agent-api/src/index.js";
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_ID,
  DEFAULT_ROUTE_ID,
  TEST_SECRET,
  bytesBody,
  httpResponse,
} from "./http-fixtures.js";

/* ------------------------------------------------------------------ *
 * Neutral offline fixtures for the Task 21 backend assembly tests.
 * Every value is invented for these tests; none is a real credential.
 * ------------------------------------------------------------------ */

export const BACKEND_ROUTE_ID = DEFAULT_ROUTE_ID;
export const BACKEND_MODEL = DEFAULT_MODEL;
export const BACKEND_TURN_ID = "turn-backend-1";

export function turnStarted(index: number): AgentLoopEvent {
  return { type: "turn_started", requestId: BACKEND_TURN_ID, turnIndex: index };
}

export function routeSelected(index: number): AgentLoopEvent {
  return {
    type: "route_selected",
    requestId: BACKEND_TURN_ID,
    turnIndex: index,
    routeId: BACKEND_ROUTE_ID,
    model: BACKEND_MODEL,
  };
}

export function textDelta(index: number, text: string): AgentLoopEvent {
  return { type: "text_delta", requestId: BACKEND_TURN_ID, turnIndex: index, text };
}

export function toolCallEvent(index: number, id: string, name: string): AgentLoopEvent {
  return {
    type: "tool_call",
    requestId: BACKEND_TURN_ID,
    turnIndex: index,
    id,
    name,
    input: { path: "a.txt" },
  };
}

export function usageEvent(index: number): AgentLoopEvent {
  return {
    type: "usage",
    requestId: BACKEND_TURN_ID,
    turnIndex: index,
    inputTokens: 7,
    outputTokens: 5,
  };
}

export function completed(index: number): AgentLoopEvent {
  return { type: "completed", requestId: BACKEND_TURN_ID, turnIndex: index };
}

export function toolExecutionStarted(index: number, id: string): AgentLoopEvent {
  return {
    type: "tool_execution_started",
    requestId: BACKEND_TURN_ID,
    turnIndex: index,
    toolCallId: id,
    name: "grep",
  };
}

export function toolExecutionCompleted(index: number, id: string): AgentLoopEvent {
  return {
    type: "tool_execution_completed",
    requestId: BACKEND_TURN_ID,
    turnIndex: index,
    toolCallId: id,
    isError: false,
  };
}

export function loopCompleted(turns: number): AgentLoopEvent {
  return { type: "loop_completed", requestId: BACKEND_TURN_ID, turns };
}

export function loopError(code: string, message: string): AgentLoopEvent {
  return {
    type: "error",
    requestId: BACKEND_TURN_ID,
    turnIndex: 0,
    code,
    message,
    retryable: false,
  };
}

/** Counts upstream next()/return() calls so release behavior is observable. */
export function createCountingLoopEvents(
  events: readonly AgentLoopEvent[],
): { iterable: AsyncIterable<AgentLoopEvent>; nextCalls: () => number; returned: () => number } {
  let nextCalls = 0;
  let returned = 0;
  const iterator: AsyncIterator<AgentLoopEvent> = {
    next: async () => {
      nextCalls += 1;
      const value = events[nextCalls - 1];
      if (value === undefined) {
        return { value: undefined, done: true };
      }
      return { value, done: false };
    },
    return: async () => {
      returned += 1;
      return { value: undefined, done: true };
    },
  };
  return {
    iterable: { [Symbol.asyncIterator]: () => iterator },
    nextCalls: () => nextCalls,
    returned: () => returned,
  };
}

/** Builds an Anthropic SSE body containing a tool_use block. */
export function anthropicToolUseStream(id: string, name: string, inputJson: string): string {
  const frame = (payload: Record<string, unknown>): string =>
    `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
  return [
    frame({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: inputJson } }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
    frame({ type: "message_stop" }),
  ].join("");
}

export function httpOk(body: string): HttpResponse {
  return httpResponse(200, bytesBody(body));
}

export interface BackendFixture {
  readonly registry: InMemoryProviderRegistry;
  readonly credentials: InMemoryCredentialStore;
  readonly httpClientCalls: () => number;
  readonly httpClientRequests: readonly { url: string; body: string }[];
}

/**
 * Builds a registry + credential store fixture with one enabled anthropic
 * route, mirroring the Task 4/5 fixtures but scoped to Task 21.
 */
export function makeBackendRegistry(
  options: {
    providerEnabled?: boolean;
    routeEnabled?: boolean;
    credentialRef?: string | null;
    withSecret?: boolean;
    models?: readonly string[];
  } = {},
): BackendFixture {
  const registry = new InMemoryProviderRegistry();
  const credentialRef = options.credentialRef === undefined ? DEFAULT_CREDENTIAL_REF : options.credentialRef;
  registry.registerProvider({
    id: DEFAULT_PROVIDER_ID,
    name: "Provider T21",
    protocol: "anthropic_messages",
    baseUrl: ANTHROPIC_BASE_URL,
    credentialRef: credentialRef === null ? null : credentialRef,
    models: [...(options.models ?? [BACKEND_MODEL])],
    enabled: options.providerEnabled ?? true,
  });
  registry.registerRoute({
    id: BACKEND_ROUTE_ID,
    name: "Route T21",
    providerId: DEFAULT_PROVIDER_ID,
    model: BACKEND_MODEL,
    enabled: options.routeEnabled ?? options.providerEnabled ?? true,
  });
  const credentials = new InMemoryCredentialStore();
  if (credentialRef !== null && options.withSecret !== false) {
    void credentials.set(credentialRef, TEST_SECRET);
  }
  return { registry, credentials, httpClientCalls: () => 0, httpClientRequests: [] };
}

/** A backend runner request matching the Local Agent API contract. */
export function makeRunnerRequest(
  overrides: Partial<ModelRequest & { sessionId: string; turnId: string; signal: AbortSignal }> = {},
): LocalAgentRunnerRequest {
  return {
    sessionId: "session-backend",
    turnId: BACKEND_TURN_ID,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    routeId: BACKEND_ROUTE_ID,
    model: BACKEND_MODEL,
    ...overrides,
  } as LocalAgentRunnerRequest;
}

export function isTerminalError(event: AgentEvent | undefined): boolean {
  return event?.type === "error";
}
