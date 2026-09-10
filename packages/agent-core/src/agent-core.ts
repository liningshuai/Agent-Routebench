import type { JsonValue, ModelRequest } from "./contracts.js";
import { AgentValidationError, validateModelRequest } from "./contracts.js";
import type { ModelGateway, ModelStreamEvent } from "../../model-gateway/src/contracts.js";

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
      return {
        type: "error",
        requestId,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      };
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return {
        type: "error",
        requestId,
        code: "gateway_error",
        message: "Model gateway produced an unknown event.",
        retryable: false,
      };
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
          message: "Model gateway failed while streaming the response.",
          retryable: false,
        };
      }
    },
  };
}
