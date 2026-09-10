import type {
  AgentLoopEvent,
  AgentMessage,
  AgentToolDefinition,
  JsonValue,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../packages/agent-runtime/src/index.js";

export const USER_TEXT = "hello runtime";

export function textMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function toolDefinition(name: string): AgentToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  };
}

export function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "req-6",
    routeId: "route-6",
    model: "offline-model",
    messages: [textMessage(USER_TEXT)],
    tools: [],
    maxTokens: 64,
    ...overrides,
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export function textOf(events: readonly AgentLoopEvent[]): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => (event.type === "text_delta" ? event.text : ""))
    .join("");
}

export function typesOf(events: readonly AgentLoopEvent[]): string[] {
  return events.map((event) => event.type);
}

export function errorEvents(events: readonly AgentLoopEvent[]) {
  return events.filter((event) => event.type === "error");
}

/**
 * A gateway whose n-th `stream()` call replays the n-th scripted turn.
 * Calling it more often than the script allows is recorded, so a test can
 * prove that no extra model request happened.
 */
export interface ScriptedGateway extends ModelGateway {
  readonly calls: ModelRequest[];
  readonly signals: (AbortSignal | undefined)[];
}

export function scriptedGateway(
  script: readonly (readonly ModelStreamEvent[])[],
): ScriptedGateway {
  const calls: ModelRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];

  return {
    calls,
    signals,
    stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
      const index = calls.length;
      calls.push(request);
      signals.push(signal);

      return (async function* replay(): AsyncIterable<ModelStreamEvent> {
        const events = script[index];
        if (events === undefined) {
          throw new Error("the scripted gateway received an unexpected extra call");
        }
        for (const event of events) {
          yield event;
        }
      })();
    },
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface GatedGateway extends ModelGateway {
  readonly calls: ModelRequest[];
  readonly signals: (AbortSignal | undefined)[];
  /** Resolves once the gateway is suspended waiting for the next release. */
  waitForPending(): Promise<void>;
  /** Releases the currently pending `stream()` call with the given events. */
  release(events: readonly ModelStreamEvent[]): void;
}

/**
 * A gateway that suspends inside `stream()` until the test releases it, which
 * is how an in-flight model stream is paused for a cancellation test.
 */
export function gatedGateway(): GatedGateway {
  const calls: ModelRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const pending: Deferred<readonly ModelStreamEvent[]>[] = [];
  const waiters: (() => void)[] = [];

  const notify = (): void => {
    for (const resolve of waiters.splice(0, waiters.length)) {
      resolve();
    }
  };

  return {
    calls,
    signals,
    async waitForPending(): Promise<void> {
      while (pending.length === 0) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    release(events: readonly ModelStreamEvent[]): void {
      const gate = pending.shift();
      if (gate === undefined) {
        throw new Error("no pending gated stream to release");
      }
      gate.resolve(events);
    },
    stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
      calls.push(request);
      signals.push(signal);
      const gate = deferred<readonly ModelStreamEvent[]>();
      pending.push(gate);
      notify();

      return (async function* gated(): AsyncIterable<ModelStreamEvent> {
        const events = await gate.promise;
        for (const event of events) {
          yield event;
        }
      })();
    },
  };
}

export interface RecordingExecutor {
  readonly executor: ToolExecutor;
  readonly requests: ToolExecutionRequest[];
  readonly signals: (AbortSignal | undefined)[];
  readonly order: string[];
  readonly concurrent: () => number;
  readonly maxConcurrent: () => number;
}

/** Records every call and tracks how many executions overlapped. */
export function recordingExecutor(
  handler: (
    request: ToolExecutionRequest,
  ) => ToolExecutionResult | Promise<ToolExecutionResult>,
): RecordingExecutor {
  const requests: ToolExecutionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const order: string[] = [];
  let active = 0;
  let peak = 0;

  return {
    requests,
    signals,
    order,
    concurrent: () => active,
    maxConcurrent: () => peak,
    executor: {
      async execute(
        request: ToolExecutionRequest,
        signal?: AbortSignal,
      ): Promise<ToolExecutionResult> {
        requests.push(request);
        signals.push(signal);
        order.push(request.id);
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await handler(request);
        } finally {
          active -= 1;
        }
      },
    },
  };
}

export function resultFor(content: string, isError?: boolean): ToolExecutionResult {
  return isError === undefined ? { content } : { content, isError };
}

export function jsonInput(value: JsonValue): JsonValue {
  return value;
}

export interface HangingExecutor {
  readonly executor: ToolExecutor;
  readonly calls: ToolExecutionRequest[];
  readonly signals: (AbortSignal | undefined)[];
  resolveLate(value: ToolExecutionResult): void;
  rejectLate(error: unknown): void;
  readonly pending: () => number;
}

/** A tool executor whose promise never settles on its own. */
export function hangingExecutor(): HangingExecutor {
  const calls: ToolExecutionRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const gates: Deferred<ToolExecutionResult>[] = [];

  return {
    calls,
    signals,
    pending: () => gates.length,
    resolveLate(value: ToolExecutionResult): void {
      const gate = gates.shift();
      gate?.resolve(value);
    },
    rejectLate(error: unknown): void {
      const gate = gates.shift();
      gate?.reject(error);
    },
    executor: {
      execute(
        request: ToolExecutionRequest,
        signal?: AbortSignal,
      ): Promise<ToolExecutionResult> {
        calls.push(request);
        signals.push(signal);
        const gate = deferred<ToolExecutionResult>();
        gates.push(gate);
        return gate.promise;
      },
    },
  };
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits for a condition with a bounded number of macrotasks. */
export async function until(
  predicate: () => boolean,
  attempts = 400,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
  throw new Error("the expected condition was not reached in time");
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/** Small helper so an expected event can be compared with `toMatchObject`. */
export function abortedEvent(requestId: string, turnIndex = 0) {
  return {
    type: "error",
    requestId,
    turnIndex,
    code: "aborted",
    message: "Request aborted.",
    retryable: false,
  };
}
