import type { ModelStreamEvent } from "@agent-workbench/agent-contracts";
import { AdapterError, AdapterStreamError, streamErrorEvent } from "./errors.js";
import { SseFrameParser, type SseEvent } from "./sse.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_MAX_TOOL_INPUT_BYTES,
  type StreamDecodeOptions,
} from "./types.js";

export interface NormalizedDecodeOptions {
  readonly signal: AbortSignal | undefined;
  readonly maxFrameBytes: number;
  readonly maxToolInputBytes: number;
}

function readPositiveSafeInteger(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AdapterError("invalid_adapter_options");
  }
  return value;
}

/**
 * Validates decode options up front so `decode()` can fail synchronously
 * instead of emitting an option error into the event stream.
 */
export function normalizeDecodeOptions(
  options: StreamDecodeOptions | undefined,
): NormalizedDecodeOptions {
  return {
    signal: options?.signal,
    maxFrameBytes: readPositiveSafeInteger(
      options?.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
    ),
    maxToolInputBytes: readPositiveSafeInteger(
      options?.maxToolInputBytes,
      DEFAULT_MAX_TOOL_INPUT_BYTES,
    ),
  };
}

export interface FrameDecoder<TState> {
  createState(options: NormalizedDecodeOptions): TState;
  handleFrame(state: TState, frame: SseEvent): readonly ModelStreamEvent[];
  isTerminal(state: TState): boolean;
  finish(state: TState): readonly ModelStreamEvent[];
}

type StepResult =
  | { readonly kind: "value"; readonly value: Uint8Array }
  | { readonly kind: "done" }
  | { readonly kind: "aborted" };

/**
 * Waits for the next upstream chunk while staying cancellable.
 *
 * A pending `next()` promise keeps a rejection handler attached so that a late
 * failure after an abort can never surface as an unhandled rejection.
 */
async function nextStep(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<StepResult> {
  if (signal === undefined) {
    const result = await iterator.next();
    return result.done === true
      ? { kind: "done" }
      : { kind: "value", value: result.value };
  }

  if (signal.aborted) {
    return { kind: "aborted" };
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<StepResult>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const pending = iterator.next();
  pending.then(undefined, () => {
    // Swallowed on purpose: see the doc comment above.
  });

  try {
    return await Promise.race([
      pending.then((result) =>
        result.done === true
          ? ({ kind: "done" } as const)
          : ({ kind: "value", value: result.value } as const),
      ),
      aborted,
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Releases the upstream iterator without ever blocking the consumer.
 *
 * A hanging `return()` must not keep the decoded iterator open, so the promise
 * is intentionally not awaited; its rejection is dropped.
 */
function releaseIterator(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const result = iterator.return?.();
    if (
      result !== undefined &&
      result !== null &&
      typeof (result as Promise<unknown>).then === "function"
    ) {
      (result as Promise<unknown>).catch(() => {
        // Upstream cleanup failures never mask the decoded outcome.
      });
    }
  } catch {
    // Ignored for the same reason.
  }
}

/**
 * Drives a frame decoder over a byte source.
 *
 * Guarantees, shared by both protocols:
 * - incremental: frames are decoded as soon as they arrive, never after
 *   buffering the whole response,
 * - at most one terminal event (`completed` or `error`) per call,
 * - consumption stops at the first terminal event and the upstream iterator is
 *   released,
 * - aborting is honoured at every step: before reading a chunk, *before pulling
 *   the next frame out of the current chunk*, and before every event is emitted,
 *   so a cancel that lands mid-chunk stops the remaining frames instead of
 *   leaking more events or parsing trailing bytes,
 * - aborting yields exactly one `aborted` event and never a `text_delta`,
 *   `tool_call`, `usage` or `completed` afterwards,
 * - a terminal event that already reached the consumer is never followed by an
 *   `aborted`,
 * - aborting resolves a pending `next()` without waiting for another chunk.
 *
 * Frames are consumed lazily through an explicitly driven iterator, so the
 * cancellation check happens before a frame is produced and the rest of the
 * chunk is neither parsed nor validated once the consumer has cancelled.
 */
export async function* decodeFrameStream<TState>(
  source: AsyncIterable<Uint8Array>,
  options: NormalizedDecodeOptions,
  decoder: FrameDecoder<TState>,
): AsyncIterable<ModelStreamEvent> {
  const signal = options.signal;

  if (signal?.aborted) {
    yield streamErrorEvent("aborted");
    return;
  }

  const iterator = source[Symbol.asyncIterator]();
  const parser = new SseFrameParser({ maxFrameBytes: options.maxFrameBytes });
  const state = decoder.createState(options);

  const cancelled = (): boolean => signal?.aborted === true;

  try {
    for (;;) {
      if (cancelled()) {
        yield streamErrorEvent("aborted");
        return;
      }

      const step = await nextStep(iterator, signal);
      if (step.kind === "aborted") {
        yield streamErrorEvent("aborted");
        return;
      }
      if (step.kind === "done") {
        break;
      }

      const frames = parser.framesFrom(step.value);
      try {
        for (;;) {
          // Checked *before* the frame iterator advances, so a cancel that
          // arrived while the consumer processed the previous event never
          // triggers another frame parse (which may itself be malformed).
          if (cancelled()) {
            yield streamErrorEvent("aborted");
            return;
          }

          const nextFrame = frames.next();
          if (nextFrame.done === true) {
            break;
          }

          // Every event of one frame is emitted as a batch; the terminal check
          // happens only after the batch, so a final frame that carries both
          // usage and completed is not truncated.
          for (const event of decoder.handleFrame(state, nextFrame.value)) {
            // Re-checked after every resume: a cancel that arrives while the
            // consumer processes the previous event must suppress this one.
            if (cancelled()) {
              yield streamErrorEvent("aborted");
              return;
            }
            yield event;
          }

          if (decoder.isTerminal(state)) {
            return;
          }
        }
      } finally {
        // Abandoning the frame iterator drops the unparsed tail of the chunk.
        frames.return(undefined);
      }
    }

    if (cancelled()) {
      yield streamErrorEvent("aborted");
      return;
    }

    for (const frame of parser.finish()) {
      if (cancelled()) {
        yield streamErrorEvent("aborted");
        return;
      }

      for (const event of decoder.handleFrame(state, frame)) {
        if (cancelled()) {
          yield streamErrorEvent("aborted");
          return;
        }
        yield event;
      }

      if (decoder.isTerminal(state)) {
        return;
      }
    }

    if (!decoder.isTerminal(state)) {
      for (const event of decoder.finish(state)) {
        if (cancelled()) {
          yield streamErrorEvent("aborted");
          return;
        }
        yield event;
      }
    }
  } catch (error) {
    if (error instanceof AdapterStreamError) {
      yield streamErrorEvent(error.code);
    } else {
      yield streamErrorEvent("gateway_error");
    }
  } finally {
    releaseIterator(iterator);
  }
}
