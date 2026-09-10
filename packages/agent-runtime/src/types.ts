import type {
  JsonValue,
  ModelGateway,
  ModelRequest,
} from "@agent-workbench/agent-contracts";

/**
 * A single tool invocation requested by the model.
 *
 * The runtime never invents these: they are produced by the model through the
 * model gateway and re-validated here before anything is executed.
 */
export interface ToolExecutionRequest {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

/**
 * The result of one tool invocation.
 *
 * `content` is the only value the model ever sees; it never travels through the
 * event stream, so a large or sensitive result stays inside the loop.
 */
export interface ToolExecutionResult {
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * The only way the runtime can execute anything.
 *
 * The runtime ships no default implementation: it cannot run a command, read a
 * file or open a socket on its own. Every side effect has to be supplied by the
 * caller through this interface.
 */
export interface ToolExecutor {
  execute(
    request: ToolExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

/**
 * What a policy may decide about one tool call.
 *
 * The runtime never infers a decision: `ask` is the only value that routes to
 * the approval handler, and anything that is not exactly one of these three
 * strings is treated as a failure.
 */
export type ToolPolicyDecision = "allow" | "deny" | "ask";

/**
 * An injected, caller owned policy.
 *
 * It is a structural interface: an object literal, a null-prototype object and
 * a class instance are all acceptable. It receives the abort signal so a policy
 * that consults a human or a service can be cancelled.
 */
export interface ToolPolicy {
  decide(
    request: ToolExecutionRequest,
    signal?: AbortSignal,
  ): ToolPolicyDecision | Promise<ToolPolicyDecision>;
}

export type ToolApprovalDecision = "approved" | "denied";

export interface ToolApprovalRequest {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

/**
 * An injected approval gate.
 *
 * It never executes anything itself and never persists a decision: this package
 * has no stored preference, no allow list and no automatic approval.
 */
export interface ToolApprovalHandler {
  requestApproval(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): ToolApprovalDecision | Promise<ToolApprovalDecision>;
}

export interface GovernedToolExecutorOptions {
  readonly executor: ToolExecutor;
  readonly policy?: ToolPolicy;
  readonly approvalHandler?: ToolApprovalHandler;
}

export interface AgentLoopOptions {
  readonly gateway: ModelGateway;
  readonly toolExecutor?: ToolExecutor;
  readonly maxTurns?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly maxToolResultBytes?: number;
}

/** Documented defaults; also exported so callers can assert them. */
export const DEFAULT_AGENT_LOOP_LIMITS = {
  maxTurns: 8,
  maxToolCallsPerTurn: 16,
  maxToolResultBytes: 65536,
} as const;

/**
 * A normalized copy of `AgentLoopOptions` with every limit resolved.
 * Internal, but exported for the option resolver's tests.
 */
export interface ResolvedAgentLoopOptions {
  readonly gateway: ModelGateway;
  readonly toolExecutor: ToolExecutor | undefined;
  readonly maxTurns: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxToolResultBytes: number;
}

/**
 * Every event the runtime can emit.
 *
 * Tool *results* deliberately do not appear here: `tool_execution_completed`
 * only reports the tool call id and whether it failed, so a tool payload can
 * never reach a consumer or a renderer through this channel.
 */
export type AgentLoopEvent =
  | {
      readonly type: "turn_started";
      readonly requestId: string;
      readonly turnIndex: number;
    }
  | {
      readonly type: "route_selected";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly routeId: string;
      readonly model: string;
    }
  | {
      readonly type: "text_delta";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly id: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "usage";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly type: "tool_execution_started";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly toolCallId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_execution_completed";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly toolCallId: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "completed";
      readonly requestId: string;
      readonly turnIndex: number;
    }
  | {
      readonly type: "loop_completed";
      readonly requestId: string;
      readonly turns: number;
    }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly turnIndex: number;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

export interface AgentLoop {
  run(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentLoopEvent>;
}
