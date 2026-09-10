import type {
  JsonValue,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
import {
  AgentValidationError,
  validateModelRequest,
} from "@agent-workbench/agent-contracts";

export type AgentEvent =
  | {
      readonly type: "route_selected";
      readonly requestId: string;
      readonly routeId: string;
      readonly model: string;
    }
  | {
      readonly type: "text_delta";
      readonly requestId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly requestId: string;
      readonly id: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "usage";
      readonly requestId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly type: "completed";
      readonly requestId: string;
    }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface AgentCore {
  run(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent>;
}

/**
 * Only these gateway error codes may reach the Agent event stream. Anything
 * else is collapsed into `gateway_error` so that provider-specific codes cannot
 * become an unbounded, attacker-influenced surface.
 */
const SAFE_GATEWAY_ERROR_CODES: ReadonlySet<string> = new Set([
  "aborted",
  "rate_limited",
  "upstream_unavailable",
  "provider_protocol_error",
  "gateway_error",
]);

const GATEWAY_ERROR_MESSAGE = "Model gateway request failed.";
const GATEWAY_ABORTED_MESSAGE = "Request aborted.";

/**
 * Builds an error event from a gateway failure without ever forwarding the raw
 * gateway message. Raw transport text can embed URLs, Authorization headers,
 * API keys, tokens, request headers, provider payloads and stack traces.
 */
function sanitizedGatewayError(
  requestId: string,
  code: unknown,
  retryable: unknown,
): AgentEvent {
  const safeCode =
    typeof code === "string" && SAFE_GATEWAY_ERROR_CODES.has(code)
      ? code
      : "gateway_error";

  return {
    type: "error",
    requestId,
    code: safeCode,
    message:
      safeCode === "aborted" ? GATEWAY_ABORTED_MESSAGE : GATEWAY_ERROR_MESSAGE,
    retryable: retryable === true,
  };
}

function invalidRequestError(request: ModelRequest, error: unknown): AgentEvent {
  const requestId =
    typeof request?.requestId === "string" ? request.requestId : "";

  if (error instanceof AgentValidationError) {
    return {
      type: "error",
      requestId,
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }

  return {
    type: "error",
    requestId,
    code: "invalid_request",
    message: "Model request failed validation.",
    retryable: false,
  };
}

function mapGatewayEvent(
  event: ModelStreamEvent,
  requestId: string,
): AgentEvent {
  switch (event.type) {
    case "text_delta":
      return {
        type: "text_delta",
        requestId,
        text: event.text,
      };
    case "tool_call":
      return {
        type: "tool_call",
        requestId,
        id: event.id,
        name: event.name,
        input: event.input,
      };
    case "usage":
      return {
        type: "usage",
        requestId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case "completed":
      return {
        type: "completed",
        requestId,
      };
    case "error":
      return sanitizedGatewayError(requestId, event.code, event.retryable);
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return sanitizedGatewayError(requestId, "gateway_error", false);
    }
  }
}

export function createAgentCore(gateway: ModelGateway): AgentCore {
  return {
    async *run(request, signal): AsyncIterable<AgentEvent> {
      try {
        validateModelRequest(request);
      } catch (error) {
        yield invalidRequestError(request, error);
        return;
      }

      yield {
        type: "route_selected",
        requestId: request.requestId,
        routeId: request.routeId,
        model: request.model,
      };

      try {
        for await (const event of gateway.stream(request, signal)) {
          yield mapGatewayEvent(event, request.requestId);
        }
      } catch {
        yield {
          type: "error",
          requestId: request.requestId,
          code: "gateway_error",
          message: GATEWAY_ERROR_MESSAGE,
          retryable: false,
        };
      }
    },
  };
}
