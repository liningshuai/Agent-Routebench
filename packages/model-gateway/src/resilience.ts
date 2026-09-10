import type { ModelStreamEvent } from "@agent-workbench/agent-contracts";

/**
 * Bounded retry policy for the resilient routed gateway.
 *
 * Every value is explicit and deterministic: there is no jitter and no wall
 * clock dependency, so an entire retry and failover timeline is reproducible in
 * an offline test.
 */
export interface RetryPolicy {
  /** Attempts allowed for one provider before moving to the next candidate. */
  readonly maxAttemptsPerProvider: number;
  /** Attempts allowed across every candidate of one stream call. */
  readonly maxTotalAttempts: number;
  /** Delay before the first retry of a provider, in milliseconds. */
  readonly initialBackoffMs: number;
  /** Upper bound for any single backoff delay, in milliseconds. */
  readonly maxBackoffMs: number;
}

/** Defaults: at most two attempts per provider and eight attempts overall. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttemptsPerProvider: 2,
  maxTotalAttempts: 8,
  initialBackoffMs: 250,
  maxBackoffMs: 2000,
});

/**
 * The only error codes a retry or a provider switch may answer.
 *
 * A cancellation, a protocol violation, a configuration failure and every other
 * non retryable outcome are surfaced unchanged.
 */
export const RETRYABLE_STREAM_ERROR_CODES: ReadonlySet<string> = Object.freeze(
  new Set(["rate_limited", "upstream_unavailable"]),
);

export const RESILIENCE_ERROR_CODES = Object.freeze({
  invalidResilienceOptions: "invalid_resilience_options",
} as const);

/**
 * Thrown synchronously for an invalid resilience configuration.
 *
 * The message is fixed and never echoes the rejected values.
 */
export class ResilienceOptionError extends Error {
  readonly code: string;

  constructor() {
    super("The resilience options are invalid.");
    this.name = "ResilienceOptionError";
    this.code = RESILIENCE_ERROR_CODES.invalidResilienceOptions;
  }
}

/** Waits for a delay while staying cancellable. */
export type RetryWait = (delayMs: number, signal?: AbortSignal) => Promise<void>;

function readAttemptCount(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ResilienceOptionError();
  }
  return value;
}

function readDelay(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ResilienceOptionError();
  }
  return value;
}

/** Merges a partial policy with the defaults, rejecting anything unusable. */
export function normalizeRetryPolicy(
  input?: Partial<RetryPolicy> | undefined,
): RetryPolicy {
  if (input !== undefined && (typeof input !== "object" || input === null)) {
    throw new ResilienceOptionError();
  }

  const policy: RetryPolicy = {
    maxAttemptsPerProvider: readAttemptCount(
      input?.maxAttemptsPerProvider,
      DEFAULT_RETRY_POLICY.maxAttemptsPerProvider,
    ),
    maxTotalAttempts: readAttemptCount(
      input?.maxTotalAttempts,
      DEFAULT_RETRY_POLICY.maxTotalAttempts,
    ),
    initialBackoffMs: readDelay(
      input?.initialBackoffMs,
      DEFAULT_RETRY_POLICY.initialBackoffMs,
    ),
    maxBackoffMs: readDelay(input?.maxBackoffMs, DEFAULT_RETRY_POLICY.maxBackoffMs),
  };

  if (policy.maxBackoffMs < policy.initialBackoffMs) {
    throw new ResilienceOptionError();
  }

  return policy;
}

/**
 * Deterministic exponential backoff for one retry of one provider.
 *
 * `delay(retryIndex) = min(initialBackoffMs * 2 ** retryIndex, maxBackoffMs)`
 * where `retryIndex` is 0 for the first retry of that provider. The first
 * attempt of a provider never waits.
 */
export function computeBackoffDelayMs(policy: RetryPolicy, retryIndex: number): number {
  const index = Number.isSafeInteger(retryIndex) && retryIndex > 0 ? retryIndex : 0;
  const scaled = policy.initialBackoffMs * 2 ** index;
  return Math.min(scaled, policy.maxBackoffMs);
}

/**
 * True only for the error events that a bounded retry or a provider switch may
 * answer.
 *
 * Classification uses the structured code and the controlled `retryable` flag,
 * never the message text.
 */
export function isRetryableStreamError(event: ModelStreamEvent): boolean {
  return (
    event.type === "error" &&
    event.retryable === true &&
    RETRYABLE_STREAM_ERROR_CODES.has(event.code)
  );
}

/**
 * True for every event that has already been shown to the consumer.
 *
 * Once one of these has been emitted the attempt is committed: its outcome must
 * be surfaced rather than retried or answered by another provider.
 */
export function isVisibleStreamEvent(
  event: ModelStreamEvent,
): event is Exclude<ModelStreamEvent, { type: "error" }> {
  return event.type !== "error";
}

/**
 * Default wait: a real timer that also resolves as soon as the signal aborts.
 *
 * The timer is unref'd so a pending backoff never keeps the process alive, and
 * the abort listener is removed on every path.
 */
export const defaultRetryWait: RetryWait = (delayMs, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
      resolve();
    };

    onAbort = (): void => finish();
    timer = setTimeout(finish, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
