import type { AgentEvent } from "@agent-workbench/agent-core";

export interface TauriTurnPayload {
  readonly sessionId: string;
  readonly turnId: string;
  readonly event: AgentEvent;
}

export class Deferred<T> {
  public readonly promise: Promise<T>;
  public resolve!: (value: T | PromiseLike<T>) => void;
  public reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class FakeTauriBridge {
  public readonly invokeCalls: Array<{
    command: string;
    args: Record<string, unknown> | undefined;
  }> = [];
  public readonly unlistenCalls: string[] = [];
  public readonly listeners = new Map<
    string,
    (event: { readonly payload: unknown }) => void
  >();
  public readonly listenerSets = new Map<
    string,
    Set<(event: { readonly payload: unknown }) => void>
  >();
  public readonly invokeResponses = new Map<string, unknown>();
  public readonly invokeDeferred = new Map<string, Deferred<unknown>>();
  public readonly invokeErrors = new Map<string, unknown>();

  public async invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    this.invokeCalls.push({ command, args });
    const deferred = this.invokeDeferred.get(command);
    if (deferred) {
      return deferred.promise as Promise<T>;
    }
    const error = this.invokeErrors.get(command);
    if (error !== undefined) {
      throw error;
    }
    return this.invokeResponses.get(command) as T;
  }

  public async listen<T>(
    eventName: string,
    handler: (event: { readonly payload: T }) => void,
  ): Promise<() => void> {
    const storedHandler =
      handler as (event: { readonly payload: unknown }) => void;
    this.listeners.set(eventName, storedHandler);
    const handlers = this.listenerSets.get(eventName) ?? new Set();
    handlers.add(storedHandler);
    this.listenerSets.set(eventName, handlers);
    return () => {
      this.unlistenCalls.push(eventName);
      handlers.delete(storedHandler);
      if (handlers.size === 0) {
        this.listenerSets.delete(eventName);
        this.listeners.delete(eventName);
      }
    };
  }

  public emit(eventName: string, payload: TauriTurnPayload): void {
    const handlers = this.listenerSets.get(eventName);
    if (handlers) {
      for (const handler of handlers) handler({ payload });
      return;
    }
    this.listeners.get(eventName)?.({ payload });
  }

  public callsFor(command: string): Array<{
    command: string;
    args: Record<string, unknown> | undefined;
  }> {
    return this.invokeCalls.filter((call) => call.command === command);
  }
}

export const VALID_SESSION = Object.freeze({
  id: "session-1",
  status: "idle",
  createdAt: 1000,
  updatedAt: 1000,
});

export const VALID_TURN_REQUEST = Object.freeze({
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
    },
  ],
});

export function textEvent(text: string): AgentEvent {
  return {
    type: "text_delta",
    requestId: "request-1",
    text,
  };
}

export function completedEvent(): AgentEvent {
  return {
    type: "completed",
    requestId: "request-1",
  };
}

export async function flushTauriMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
