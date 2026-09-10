import type {
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";

export interface FakeGatewayOptions {
  readonly events: readonly ModelStreamEvent[];
}

function cloneEvent(event: ModelStreamEvent): ModelStreamEvent {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", text: event.text };
    case "tool_call":
      return {
        type: "tool_call",
        id: event.id,
        name: event.name,
        input: structuredClone(event.input),
      };
    case "usage":
      return {
        type: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
    case "completed":
      return { type: "completed" };
    case "error":
      return {
        type: "error",
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      };
    default: {
      const exhaustive: never = event;
      throw new TypeError(`Unsupported fake gateway event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function abortedEvent(): ModelStreamEvent {
  return {
    type: "error",
    code: "aborted",
    message: "Request aborted before completion.",
    retryable: false,
  };
}

export class DeterministicFakeModelGateway implements ModelGateway {
  readonly #events: readonly ModelStreamEvent[];

  constructor(options: FakeGatewayOptions) {
    this.#events = Object.freeze(options.events.map(cloneEvent));
  }

  async *stream(
    _request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    if (signal?.aborted) {
      yield abortedEvent();
      return;
    }

    for (const event of this.#events) {
      if (signal?.aborted) {
        yield abortedEvent();
        return;
      }
      yield cloneEvent(event);
    }
  }
}
