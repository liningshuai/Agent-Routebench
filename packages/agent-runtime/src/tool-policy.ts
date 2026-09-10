import type {
  GovernedToolExecutorOptions,
  ToolApprovalHandler,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
  ToolPolicy,
  ToolPolicyDecision,
} from "./types.js";
import { TOOL_FAILURE_CONTENT } from "./errors.js";

/** Fixed result shown to the model when a policy refuses a tool. */
export const TOOL_POLICY_DENIED_CONTENT = "Tool execution was denied.";

/** Fixed result shown to the model when `ask` has nowhere to ask. */
export const TOOL_APPROVAL_UNAVAILABLE_CONTENT = "Tool approval is unavailable.";

/** Fixed result shown to the model when the approval was refused. */
export const TOOL_APPROVAL_DENIED_CONTENT = "Tool execution was denied.";

/** Fixed result shown to the model when the approval gate itself failed. */
export const TOOL_APPROVAL_FAILED_CONTENT = "Tool approval failed.";

/** Fixed result shown to the model when the policy could not be evaluated. */
export const TOOL_POLICY_FAILED_CONTENT = "Tool policy evaluation failed.";

export const TOOL_POLICY_ERROR_CODES = {
  invalidToolPolicyOptions: "invalid_tool_policy_options",
} as const;

export type ToolPolicyErrorKey = keyof typeof TOOL_POLICY_ERROR_CODES;
export type ToolPolicyErrorCode =
  (typeof TOOL_POLICY_ERROR_CODES)[ToolPolicyErrorKey];

const TOOL_POLICY_ERROR_MESSAGES: Record<ToolPolicyErrorKey, string> = {
  invalidToolPolicyOptions: "Tool policy options are invalid.",
};

/** Raised synchronously for an unusable configuration. */
export class ToolPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolPolicyError";
    this.code = code;
  }
}

function toolPolicyError(key: ToolPolicyErrorKey): never {
  throw new ToolPolicyError(
    TOOL_POLICY_ERROR_CODES[key],
    TOOL_POLICY_ERROR_MESSAGES[key],
  );
}

/**
 * Structural check for an injected dependency.
 *
 * `ToolPolicy`, `ToolApprovalHandler` and `ToolExecutor` are structural
 * interfaces, so a class instance with the method on its prototype is just as
 * acceptable as an object literal. Only the shape matters: a non-null,
 * non-array object that actually exposes the method as a function.
 */
function hasCallableMethod(value: unknown, method: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[method] === "function";
}

/**
 * Reads `signal.aborted` through a call so TypeScript cannot narrow the signal
 * away after the first check (the runtime re-checks after every await).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** A failed tool result. The content is always one of the fixed constants. */
function failed(content: string): ToolExecutionResult {
  return { content, isError: true };
}

/**
 * Wraps a caller supplied `ToolExecutor` behind a policy decision and an
 * approval gate.
 *
 * The wrapper is the only place where those two concerns exist: `createAgentLoop`
 * itself knows nothing about them, so the Task 6 semantics are untouched.
 *
 * Order of operations for one tool call:
 *
 * ```text
 * aborted?            -> fixed failure (the loop reports `aborted`)
 * no policy           -> deny
 * policy.decide()
 *   allow             -> executor.execute()
 *   deny              -> fixed denial, no approval, no execution
 *   ask, no handler   -> fixed "approval unavailable"
 *   ask               -> approvalHandler.requestApproval()
 *     "approved"      -> executor.execute()
 *     "denied"        -> fixed denial
 *     anything else   -> fixed approval failure
 *   anything else     -> fixed policy failure
 * ```
 *
 * Every exception is collapsed into one of the fixed constants, so nothing the
 * policy, the handler or the executor threw can reach the model or an event.
 * Decisions are never cached: the policy is consulted again for every call.
 */
export function createGovernedToolExecutor(
  options: GovernedToolExecutorOptions,
): ToolExecutor {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    toolPolicyError("invalidToolPolicyOptions");
  }

  const executor = (options as { executor?: unknown }).executor;
  if (!hasCallableMethod(executor, "execute")) {
    toolPolicyError("invalidToolPolicyOptions");
  }
  const run = executor as ToolExecutor;

  const rawPolicy = (options as { policy?: unknown }).policy;
  if (rawPolicy !== undefined && !hasCallableMethod(rawPolicy, "decide")) {
    toolPolicyError("invalidToolPolicyOptions");
  }
  const policy = rawPolicy as ToolPolicy | undefined;

  const rawApproval = (options as { approvalHandler?: unknown })
    .approvalHandler;
  if (
    rawApproval !== undefined &&
    !hasCallableMethod(rawApproval, "requestApproval")
  ) {
    toolPolicyError("invalidToolPolicyOptions");
  }
  const approval = rawApproval as ToolApprovalHandler | undefined;

  return {
    async execute(
      request: ToolExecutionRequest,
      signal?: AbortSignal,
    ): Promise<ToolExecutionResult> {
      if (isAborted(signal)) {
        return failed(TOOL_FAILURE_CONTENT);
      }

      let decision: ToolPolicyDecision;
      if (policy === undefined) {
        // Fail closed: without a policy nothing is executed.
        decision = "deny";
      } else {
        try {
          decision = await policy.decide(request, signal);
        } catch {
          return failed(TOOL_POLICY_FAILED_CONTENT);
        }
      }

      if (isAborted(signal)) {
        return failed(TOOL_FAILURE_CONTENT);
      }

      if (decision === "deny") {
        return failed(TOOL_POLICY_DENIED_CONTENT);
      }

      if (decision === "ask") {
        if (approval === undefined) {
          return failed(TOOL_APPROVAL_UNAVAILABLE_CONTENT);
        }

        let verdict: unknown;
        try {
          verdict = await approval.requestApproval(
            { id: request.id, name: request.name, input: request.input },
            signal,
          );
        } catch {
          return failed(TOOL_APPROVAL_FAILED_CONTENT);
        }

        // The approval may have taken arbitrarily long: an abort that landed in
        // the meantime must not turn into an execution.
        if (isAborted(signal)) {
          return failed(TOOL_FAILURE_CONTENT);
        }

        if (verdict === "denied") {
          return failed(TOOL_APPROVAL_DENIED_CONTENT);
        }
        if (verdict !== "approved") {
          return failed(TOOL_APPROVAL_FAILED_CONTENT);
        }
      } else if (decision !== "allow") {
        return failed(TOOL_POLICY_FAILED_CONTENT);
      }

      try {
        return await run.execute(request, signal);
      } catch {
        // A malformed result is deliberately passed through unchanged: the
        // Agent Loop already classifies it with the Task 6 rules.
        return failed(TOOL_FAILURE_CONTENT);
      }
    },
  };
}
