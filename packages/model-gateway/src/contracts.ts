import type { JsonValue, ModelRequest } from "../../agent-core/src/contracts.js";

export type ModelStreamEvent =
  | {
      readonly type: "text_delta";
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly type: "completed";
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface ModelGateway {
  stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>;
}
