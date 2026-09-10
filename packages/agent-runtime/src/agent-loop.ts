import type {
  AgentContentBlock,
  AgentMessage,
  AgentRole,
  JsonValue,
  ModelRequest,
} from "@agent-workbench/agent-contracts";
import { isJsonValue } from "@agent-workbench/agent-contracts";
import { createAgentCore } from "@agent-workbench/agent-core";
import {
  AGENT_LOOP_ERROR_CODES,
  TOOL_FAILURE_CONTENT,
  agentLoopError,
  agentLoopMessage,
  type AgentLoopErrorKey,
} from "./errors.js";
import {
  DEFAULT_AGENT_LOOP_LIMITS,
  type AgentLoop,
  type AgentLoopEvent,
  type AgentLoopOptions,
  type ResolvedAgentLoopOptions,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolExecutor,
} from "./types.js";

const encoder = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Reads `signal.aborted` through a call so TypeScript cannot narrow the signal
 * away after the first check (the runtime re-checks after every await).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Structural check for an injected dependency.
 *
 * `ModelGateway` and `ToolExecutor` are structural interfaces, so an
 * implementation may just as well be a class instance with the method on its
 * prototype as an object literal. Only the shape matters: a non-null,
 * non-array object that actually exposes the method as a function.
 */
function hasCallableMethod(value: unknown, method: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[method] === "function";
}

function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Deep copies a JSON value. A value that is not valid JSON is returned as-is so
 * the validators still reject it instead of silently normalizing it.
 */
function cloneJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      copy[key] = cloneJsonValue(nested);
    }
    return copy;
  }
  return value;
}

function cloneContentBlock(block: unknown): AgentContentBlock {
  if (!isPlainObject(block)) {
    return block as AgentContentBlock;
  }
  if (block.type === "text") {
    return { type: "text", text: block.text as string };
  }
  if (block.type === "tool_call") {
    return {
      type: "tool_call",
      id: block.id as string,
      name: block.name as string,
      input: cloneJsonValue(block.input),
    };
  }
  if (block.type === "tool_result") {
    const base = {
      type: "tool_result" as const,
      toolCallId: block.toolCallId as string,
      content: block.content as string,
    };
    return block.isError === undefined ? base : { ...base, isError: block.isError === true };
  }
  return block as AgentContentBlock;
}

/** Copies the caller history so the loop never shares mutable structures. */
function cloneMessages(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((message) => {
    const source = isPlainObject(message) ? message : {};
    const content = Array.isArray(source.content) ? source.content : [];
    return {
      role: source.role as AgentRole,
      content: content.map((block) => cloneContentBlock(block)),
    };
  });
}

function cloneToolDefinitions(raw: unknown): ModelRequest["tools"] {
  if (!Array.isArray(raw)) {
    return [] as unknown as ModelRequest["tools"];
  }
  return raw.map((tool) => {
    const source = isPlainObject(tool) ? tool : {};
    return {
      name: source.name as string,
      description: source.description as string,
      inputSchema: cloneJsonValue(source.inputSchema),
    };
  }) as unknown as ModelRequest["tools"];
}

function collectToolNames(raw: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(raw)) {
    return names;
  }
  for (const tool of raw) {
    if (isPlainObject(tool) && typeof tool.name === "string") {
      names.add(tool.name);
    }
  }
  return names;
}

/**
 * The tool call ids already present in the caller history. The model may not
 * reuse any of them, and the check has to exist here because a turn that only
 * repeats an old id would otherwise be appended to the next request.
 */
function collectToolCallIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) {
    return ids;
  }
  for (const message of raw) {
    if (!isPlainObject(message) || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (isPlainObject(block) && block.type === "tool_call" && typeof block.id === "string") {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function runtimeError(
  requestId: string,
  turnIndex: number,
  key: AgentLoopErrorKey,
): AgentLoopEvent {
  return {
    type: "error",
    requestId,
    turnIndex,
    code: AGENT_LOOP_ERROR_CODES[key],
    message: agentLoopMessage(key),
    retryable: false,
  };
}

type NextStep<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "done" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed" };

/**
 * Advances an iterator without ever leaving a rejection unhandled, and without
 * waiting for the upstream when the caller aborted. Racing the signal is what
 * makes a cancellation observable instead of hanging on a parked `next()`.
 */
function nextStep<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<NextStep<T>> {
  if (isAborted(signal)) {
    return Promise.resolve({ kind: "aborted" });
  }

  if (signal === undefined) {
    return iterator.next().then(
      (result) =>
        result.done === true
          ? ({ kind: "done" } as NextStep<T>)
          : ({ kind: "value", value: result.value } as NextStep<T>),
      () => ({ kind: "failed" }) as NextStep<T>,
    );
  }

  const settled = iterator.next().then(
    (result) => ({ ok: true as const, result }),
    () => ({ ok: false as const }),
  );

  return new Promise<NextStep<T>>((resolve) => {
    let finished = false;
    const finish = (step: NextStep<T>): void => {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener("abort", onAbort);
      resolve(step);
    };
    const onAbort = (): void => {
      finish({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((outcome) => {
      if (!outcome.ok) {
        finish({ kind: "failed" });
        return;
      }
      finish(
        outcome.result.done === true
          ? { kind: "done" }
          : { kind: "value", value: outcome.result.value },
      );
    });
  });
}

/**
 * Releases an upstream iterator without awaiting it: a hanging `return()` must
 * never be able to block the loop from finishing.
 */
function releaseIterator(iterator: AsyncIterator<unknown>): void {
  const returned = iterator.return;
  if (typeof returned !== "function") {
    return;
  }
  try {
    const result = returned.call(iterator, undefined) as unknown;
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void (result as PromiseLike<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // A misbehaving upstream must never break the loop's own cleanup.
  }
}

interface ValidatedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

type ToolCallCheck =
  | { readonly ok: true; readonly call: ValidatedToolCall }
  | { readonly ok: false; readonly errorKey: AgentLoopErrorKey };

/**
 * Re-validates a model supplied tool call. The input is never replaced by an
 * empty object when it is unusable, so an invalid call can never turn into a
 * valid one.
 */
function readToolCall(
  event: { readonly id: unknown; readonly name: unknown; readonly input: unknown },
  seenIds: ReadonlySet<string>,
): ToolCallCheck {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return { ok: false, errorKey: "invalidToolCall" };
  }
  if (typeof event.name !== "string" || event.name.length === 0) {
    return { ok: false, errorKey: "invalidToolCall" };
  }
  if (!isJsonValue(event.input)) {
    return { ok: false, errorKey: "invalidToolCall" };
  }
  if (seenIds.has(event.id)) {
    return { ok: false, errorKey: "duplicateToolCallId" };
  }
  return { ok: true, call: { id: event.id, name: event.name, input: cloneJsonValue(event.input) } };
}

interface ClassifiedToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/**
 * Turns whatever the executor produced into a safe result. A malformed value,
 * an oversized payload or a raw exception all collapse into one fixed failure
 * that the model may recover from on the next turn.
 */
function classifyToolResult(raw: unknown, maxBytes: number): ClassifiedToolResult {
  if (!isPlainObject(raw)) {
    return { content: TOOL_FAILURE_CONTENT, isError: true };
  }
  const content = raw.content;
  const isError = raw.isError;
  if (typeof content !== "string") {
    return { content: TOOL_FAILURE_CONTENT, isError: true };
  }
  if (isError !== undefined && typeof isError !== "boolean") {
    return { content: TOOL_FAILURE_CONTENT, isError: true };
  }
  if (utf8ByteLength(content) > maxBytes) {
    return { content: TOOL_FAILURE_CONTENT, isError: true };
  }
  return { content, isError: isError === true };
}

type ToolOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "aborted" };

/**
 * Runs one tool invocation, racing it against the abort signal so a tool that
 * never settles cannot keep the loop alive.
 */
async function executeTool(
  executor: ToolExecutor,
  request: ToolExecutionRequest,
  signal: AbortSignal | undefined,
): Promise<ToolOutcome> {
  if (isAborted(signal)) {
    return { kind: "aborted" };
  }

  let invocation: Promise<unknown>;
  try {
    invocation = Promise.resolve(executor.execute(request, signal));
  } catch {
    return { kind: "result", value: undefined };
  }

  const settled = invocation.then(
    (value) => ({ value }),
    () => ({ value: undefined }),
  );

  if (signal === undefined) {
    const outcome = await settled;
    return { kind: "result", value: outcome.value };
  }

  return new Promise<ToolOutcome>((resolve) => {
    let finished = false;
    const finish = (outcome: ToolOutcome): void => {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      finish({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then((outcome) => {
      finish({ kind: "result", value: outcome.value });
    });
  });
}

function buildTurnRequest(
  request: ModelRequest,
  messages: readonly AgentMessage[],
): ModelRequest {
  return {
    requestId: request.requestId,
    routeId: request.routeId,
    model: request.model,
    messages: cloneMessages(messages),
    tools: cloneToolDefinitions((request as { tools?: unknown }).tools),
    maxTokens: request.maxTokens,
  };
}

/**
 * Validates the option bag and resolves every limit.
 *
 * Rejects synchronously with `invalid_loop_options`; the rejected value is
 * never echoed so a misconfigured caller cannot leak a value through the error.
 */
export function resolveAgentLoopOptions(
  options: AgentLoopOptions,
): ResolvedAgentLoopOptions {
  if (!isPlainObject(options)) {
    throw agentLoopError("invalidLoopOptions");
  }

  const gateway = (options as { gateway?: unknown }).gateway;
  if (!hasCallableMethod(gateway, "stream")) {
    throw agentLoopError("invalidLoopOptions");
  }

  const toolExecutor = (options as { toolExecutor?: unknown }).toolExecutor;
  if (
    toolExecutor !== undefined &&
    !hasCallableMethod(toolExecutor, "execute")
  ) {
    throw agentLoopError("invalidLoopOptions");
  }

  return {
    gateway: options.gateway,
    toolExecutor: toolExecutor as ToolExecutor | undefined,
    maxTurns: resolveLimit(options.maxTurns, DEFAULT_AGENT_LOOP_LIMITS.maxTurns),
    maxToolCallsPerTurn: resolveLimit(
      options.maxToolCallsPerTurn,
      DEFAULT_AGENT_LOOP_LIMITS.maxToolCallsPerTurn,
    ),
    maxToolResultBytes: resolveLimit(
      options.maxToolResultBytes,
      DEFAULT_AGENT_LOOP_LIMITS.maxToolResultBytes,
    ),
  };
}

function resolveLimit(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw agentLoopError("invalidLoopOptions");
  }
  return value;
}

/**
 * Creates a bounded multi-turn agent loop.
 *
 * One turn is one request to Agent Core. When a turn asks for tools the loop
 * runs them serially, appends the assistant and tool messages and asks again,
 * up to `maxTurns` model requests in total. Every event keeps its turn index so
 * a consumer can attribute output to the turn that produced it.
 */
export function createAgentLoop(options: AgentLoopOptions): AgentLoop {
  const resolved = resolveAgentLoopOptions(options);

  return {
    async *run(
      request: ModelRequest,
      signal?: AbortSignal,
    ): AsyncIterable<AgentLoopEvent> {
      const rawRequest = request as unknown as { requestId?: unknown } | null;
      const requestId =
        rawRequest !== null &&
        rawRequest !== undefined &&
        typeof rawRequest.requestId === "string"
          ? rawRequest.requestId
          : "";

      if (isAborted(signal)) {
        yield runtimeError(requestId, 0, "aborted");
        return;
      }

      const core = createAgentCore(resolved.gateway);
      const availableTools = collectToolNames((request as { tools?: unknown }).tools);
      const seenToolCallIds = collectToolCallIds((request as { messages?: unknown }).messages);
      let messages = cloneMessages((request as { messages?: unknown }).messages);

      for (let turnIndex = 0; turnIndex < resolved.maxTurns; turnIndex += 1) {
        if (isAborted(signal)) {
          yield runtimeError(requestId, turnIndex, "aborted");
          return;
        }

        yield { type: "turn_started", requestId, turnIndex };

        const turnRequest = buildTurnRequest(request, messages);
        const texts: string[] = [];
        const toolCalls: ValidatedToolCall[] = [];
        let completed = false;
        let failureKey: AgentLoopErrorKey | null = null;
        let gatewayFailure: AgentLoopEvent | null = null;

        const iterator = core.run(turnRequest, signal)[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await nextStep(iterator, signal);
            if (step.kind === "aborted") {
              yield runtimeError(requestId, turnIndex, "aborted");
              return;
            }
            if (step.kind === "done") {
              break;
            }
            if (step.kind === "failed") {
              yield runtimeError(requestId, turnIndex, "gatewayFailure");
              return;
            }

            const event = step.value;

            if (event.type === "route_selected") {
              yield {
                type: "route_selected",
                requestId,
                turnIndex,
                routeId: event.routeId,
                model: event.model,
              };
              continue;
            }

            if (event.type === "text_delta") {
              texts.push(event.text);
              yield { type: "text_delta", requestId, turnIndex, text: event.text };
              continue;
            }

            if (event.type === "usage") {
              yield {
                type: "usage",
                requestId,
                turnIndex,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              };
              continue;
            }

            if (event.type === "completed") {
              completed = true;
              yield { type: "completed", requestId, turnIndex };
              continue;
            }

            if (event.type === "error") {
              // Agent Core already sanitized this event; forwarding it verbatim
              // is the only way not to re-introduce raw upstream text.
              gatewayFailure = {
                type: "error",
                requestId,
                turnIndex,
                code: event.code,
                message: event.message,
                retryable: event.retryable,
              };
              break;
            }

            const check = readToolCall(event, seenToolCallIds);
            if (!check.ok) {
              failureKey = check.errorKey;
              break;
            }
            seenToolCallIds.add(check.call.id);
            toolCalls.push(check.call);
            yield {
              type: "tool_call",
              requestId,
              turnIndex,
              id: check.call.id,
              name: check.call.name,
              input: cloneJsonValue(check.call.input),
            };
          }
        } finally {
          releaseIterator(iterator);
        }

        if (gatewayFailure !== null) {
          yield gatewayFailure;
          return;
        }
        if (failureKey !== null) {
          yield runtimeError(requestId, turnIndex, failureKey);
          return;
        }
        if (isAborted(signal)) {
          yield runtimeError(requestId, turnIndex, "aborted");
          return;
        }
        if (!completed) {
          yield runtimeError(requestId, turnIndex, "incompleteModelResponse");
          return;
        }

        if (toolCalls.length === 0) {
          yield { type: "loop_completed", requestId, turns: turnIndex + 1 };
          return;
        }

        // The whole batch is validated before a single tool runs, so a bad
        // third call can never be discovered after two tools already ran.
        if (toolCalls.length > resolved.maxToolCallsPerTurn) {
          yield runtimeError(requestId, turnIndex, "tooManyToolCalls");
          return;
        }
        const executor = resolved.toolExecutor;
        if (executor === undefined) {
          yield runtimeError(requestId, turnIndex, "toolExecutionUnavailable");
          return;
        }
        for (const call of toolCalls) {
          if (!availableTools.has(call.name)) {
            yield runtimeError(requestId, turnIndex, "unknownTool");
            return;
          }
        }
        if (turnIndex + 1 >= resolved.maxTurns) {
          yield runtimeError(requestId, turnIndex, "maxTurnsExceeded");
          return;
        }

        const assistantBlocks: AgentContentBlock[] = [];
        const assistantText = texts.join("");
        if (assistantText.length > 0) {
          assistantBlocks.push({ type: "text", text: assistantText });
        }
        for (const call of toolCalls) {
          assistantBlocks.push({
            type: "tool_call",
            id: call.id,
            name: call.name,
            input: cloneJsonValue(call.input),
          });
        }

        const resultBlocks: AgentContentBlock[] = [];
        for (const call of toolCalls) {
          if (isAborted(signal)) {
            yield runtimeError(requestId, turnIndex, "aborted");
            return;
          }

          yield {
            type: "tool_execution_started",
            requestId,
            turnIndex,
            toolCallId: call.id,
            name: call.name,
          };

          const outcome = await executeTool(
            executor,
            { id: call.id, name: call.name, input: cloneJsonValue(call.input) },
            signal,
          );

          if (outcome.kind === "aborted") {
            yield runtimeError(requestId, turnIndex, "aborted");
            return;
          }

          const classified = classifyToolResult(outcome.value, resolved.maxToolResultBytes);
          yield {
            type: "tool_execution_completed",
            requestId,
            turnIndex,
            toolCallId: call.id,
            isError: classified.isError,
          };
          resultBlocks.push(
            classified.isError
              ? {
                  type: "tool_result",
                  toolCallId: call.id,
                  content: classified.content,
                  isError: true,
                }
              : { type: "tool_result", toolCallId: call.id, content: classified.content },
          );
        }

        messages = [
          ...messages,
          { role: "assistant", content: assistantBlocks },
          { role: "tool", content: resultBlocks },
        ];
      }

      // Only reachable if the loop runs out of turns while a tool batch is
      // still outstanding; the budget check above handles the normal path.
      yield runtimeError(requestId, resolved.maxTurns - 1, "maxTurnsExceeded");
    },
  };
}
