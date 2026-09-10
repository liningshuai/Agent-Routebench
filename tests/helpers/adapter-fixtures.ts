import type {
  AgentContentBlock,
  AgentMessage,
  AgentToolDefinition,
  ModelRequest,
  ModelStreamEvent,
} from "../../packages/agent-contracts/src/index.js";

/* ------------------------------------------------------------------ *
 * Request fixtures
 * ------------------------------------------------------------------ */

export function textBlock(text: string): AgentContentBlock {
  return { type: "text", text };
}

export function toolCallBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AgentContentBlock {
  return { type: "tool_call", id, name, input: input as unknown as never };
}

export function toolResultBlock(
  toolCallId: string,
  content: string,
  isError?: boolean,
): AgentContentBlock {
  const block: AgentContentBlock = isError === undefined
    ? { type: "tool_result", toolCallId, content }
    : { type: "tool_result", toolCallId, content, isError };
  return block;
}

export function toolDefinition(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): AgentToolDefinition {
  return {
    name,
    description,
    inputSchema: parameters as unknown as never,
  };
}

export function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "req-t3",
    routeId: "route-t3",
    model: "offline-model",
    messages: [{ role: "user", content: [textBlock("hello")] }],
    tools: [],
    maxTokens: 256,
    ...overrides,
  };
}

export function systemMessage(text: string): AgentMessage {
  return { role: "system", content: [textBlock(text)] };
}

export function userMessage(...blocks: AgentContentBlock[]): AgentMessage {
  return { role: "user", content: blocks };
}

export function assistantMessage(...blocks: AgentContentBlock[]): AgentMessage {
  return { role: "assistant", content: blocks };
}

export function toolMessage(...blocks: AgentContentBlock[]): AgentMessage {
  return { role: "tool", content: blocks };
}

/* ------------------------------------------------------------------ *
 * Byte helpers
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Splits raw bytes into fixed size chunks (may split multi-byte characters). */
export function splitBytes(source: Uint8Array, size: number): Uint8Array[] {
  if (size <= 0) {
    throw new Error("split size must be positive");
  }
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < source.length; offset += size) {
    out.push(source.subarray(offset, Math.min(offset + size, source.length)));
  }
  return out;
}

export function chunkText(text: string, size: number): Uint8Array[] {
  return splitBytes(bytes(text), size);
}

export async function* fromChunks(
  chunks: readonly Uint8Array[],
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

export async function collectEvents(
  iterable: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * SSE fixture builders (offline, synthetic only)
 * ------------------------------------------------------------------ */

export function dataFrame(payload: unknown): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

export function namedFrame(event: string, payload: unknown): string {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `event: ${event}\ndata: ${data}\n\n`;
}

export function anthropicFrame(payload: Record<string, unknown>): string {
  return namedFrame(String(payload.type), payload);
}

export const SSE_DONE = "data: [DONE]\n\n";

/* ------------------------------------------------------------------ *
 * Gated streaming source: lets a test prove incremental consumption
 * ------------------------------------------------------------------ */

type QueueItem =
  | { readonly kind: "chunk"; readonly value: Uint8Array }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "end" };

export interface GatedSource {
  readonly stream: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array | string): void;
  fail(error: unknown): void;
  close(): void;
  readonly buffered: number;
  readonly returnCalls: number;
}

export function createGatedSource(): GatedSource {
  const queue: QueueItem[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let returnCalls = 0;

  const wake = (): void => {
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) {
      resolve();
    }
  };

  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          for (;;) {
            const item = queue.shift();
            if (item !== undefined) {
              if (item.kind === "end") {
                return { done: true, value: undefined };
              }
              if (item.kind === "error") {
                throw item.error;
              }
              return { done: false, value: item.value };
            }
            if (ended) {
              return { done: true, value: undefined };
            }
            await new Promise<void>((resolve) => {
              waiters.push(resolve);
            });
          }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          returnCalls += 1;
          ended = true;
          wake();
          return { done: true, value: undefined };
        },
      };
    },
  };

  return {
    stream,
    push(chunk: Uint8Array | string): void {
      queue.push({
        kind: "chunk",
        value: typeof chunk === "string" ? bytes(chunk) : chunk,
      });
      wake();
    },
    fail(error: unknown): void {
      queue.push({ kind: "error", error });
      wake();
    },
    close(): void {
      if (!ended) {
        ended = true;
        queue.push({ kind: "end" });
      }
      wake();
    },
    get buffered(): number {
      return queue.length;
    },
    get returnCalls(): number {
      return returnCalls;
    },
  };
}

/** A source that counts how often the decoder touches the upstream iterator. */
export function createCountingSource(chunks: readonly Uint8Array[]) {
  let nextCalls = 0;
  let returnCalls = 0;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          nextCalls += 1;
          if (index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return {
    stream,
    get nextCalls(): number {
      return nextCalls;
    },
    get returnCalls(): number {
      return returnCalls;
    },
  };
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Awaits one more event, failing fast instead of hanging the suite. */
export async function nextEvent(
  iterator: AsyncIterator<ModelStreamEvent>,
  timeoutMs = 1000,
): Promise<IteratorResult<ModelStreamEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("timed out waiting for a decoded event")),
      timeoutMs,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function errorEventCodes(events: readonly ModelStreamEvent[]): string[] {
  return events
    .filter((event) => event.type === "error")
    .map((event) => (event.type === "error" ? event.code : ""));
}

export function textOf(events: readonly ModelStreamEvent[]): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => (event.type === "text_delta" ? event.text : ""))
    .join("");
}
