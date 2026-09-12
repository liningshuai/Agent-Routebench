import type { AgentEvent } from "@agent-workbench/agent-core";
import type { AgentLoopEvent } from "@agent-workbench/agent-runtime";

/**
 * Maps the agent runtime's loop events onto the Local Agent API event
 * contract, incrementally:
 *
 * - `turn_started`, `tool_execution_started` and `tool_execution_completed`
 *   are internal runtime detail and never surface.
 * - Runtime `completed` fires at the end of every model turn, including
 *   middle turns that are followed by tool execution. The Local Agent API
 *   treats the first `completed` as the end of the whole HTTP stream, so a
 *   `completed` is stashed and only emitted when `loop_completed` proves the
 *   loop has really finished. Any visible follow-up event discards the stash.
 * - An `error` is terminal: the pending completed is dropped and never
 *   emitted afterwards.
 * - Every output event carries the runner's `turnId` as `requestId`.
 *
 * The mapping streams lazily; nothing is buffered just to decide terminals.
 */
export async function* mapAgentLoopEvents(
  loopEvents: AsyncIterable<AgentLoopEvent>,
  turnId: string,
): AsyncGenerator<AgentEvent, void, undefined> {
  let pendingCompleted: AgentEvent | undefined;

  for await (const event of loopEvents) {
    switch (event.type) {
      case "turn_started":
      case "tool_execution_started":
      case "tool_execution_completed":
        continue;

      case "route_selected": {
        pendingCompleted = undefined;
        yield {
          type: "route_selected",
          requestId: turnId,
          routeId: event.routeId,
          model: event.model,
        };
        break;
      }

      case "text_delta": {
        pendingCompleted = undefined;
        yield { type: "text_delta", requestId: turnId, text: event.text };
        break;
      }

      case "tool_call": {
        pendingCompleted = undefined;
        yield {
          type: "tool_call",
          requestId: turnId,
          id: event.id,
          name: event.name,
          input: event.input,
        };
        break;
      }

      case "usage": {
        pendingCompleted = undefined;
        yield {
          type: "usage",
          requestId: turnId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        };
        break;
      }

      case "completed": {
        pendingCompleted = { type: "completed", requestId: turnId };
        break;
      }

      case "loop_completed": {
        yield pendingCompleted ?? { type: "completed", requestId: turnId };
        pendingCompleted = undefined;
        return;
      }

      case "error": {
        pendingCompleted = undefined;
        yield {
          type: "error",
          requestId: turnId,
          code: isNonEmptyString(event.code) ? event.code : "gateway_error",
          message: isNonEmptyString(event.message)
            ? event.message
            : "Agent backend request failed.",
          retryable: event.retryable === true,
        };
        return;
      }
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
