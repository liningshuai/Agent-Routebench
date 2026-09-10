import type {
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
import type { ProviderRegistry, ResolvedRoute } from "@agent-workbench/provider-registry";

import type { StreamErrorCode } from "./adapters/errors.js";
import { streamErrorEvent } from "./adapters/errors.js";
import {
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter,
} from "./adapters/index.js";
import {
  isAborted,
  runCandidateAttempt,
  type CandidateAttemptOptions,
} from "./candidate-attempt.js";
import { createFetchHttpClient } from "./http-transport.js";
import type { RoutedHttpModelGatewayOptions } from "./routed-http-gateway.js";
import {
  ResilienceOptionError,
  computeBackoffDelayMs,
  defaultRetryWait,
  isRetryableStreamError,
  isVisibleStreamEvent,
  normalizeRetryPolicy,
  type RetryPolicy,
  type RetryWait,
} from "./resilience.js";

export interface ResilientRoutedHttpModelGatewayOptions
  extends RoutedHttpModelGatewayOptions {
  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly wait?: RetryWait;
}

/**
 * The routed gateway plus a bounded retry and an ordered provider failover.
 *
 * Attempt order is fixed and sequential:
 *
 * ```text
 * primary        attempt 1 .. maxAttemptsPerProvider
 * fallback 1     attempt 1 .. maxAttemptsPerProvider
 * fallback 2     attempt 1 .. maxAttemptsPerProvider
 * ```
 *
 * bounded by `maxTotalAttempts`. Requests are never issued in parallel and the
 * candidate list is never revisited, so a provider is never reused once it is
 * exhausted.
 *
 * A retry or a switch is only allowed while the attempt has produced nothing
 * the consumer could have seen. As soon as a `text_delta`, `tool_call`, `usage`
 * or `completed` has been emitted, the attempt is surfaced as-is: re-sending
 * would duplicate text, a tool call or a usage count.
 */
export class ResilientRoutedHttpModelGateway implements ModelGateway {
  readonly #registry: ProviderRegistry;
  readonly #attempts: CandidateAttemptOptions;
  readonly #policy: RetryPolicy;
  readonly #wait: RetryWait;

  constructor(options: ResilientRoutedHttpModelGatewayOptions) {
    this.#policy = normalizeRetryPolicy(options.retryPolicy);

    if (typeof options.registry?.resolveRouteCandidates !== "function") {
      throw new ResilienceOptionError();
    }
    this.#registry = options.registry;
    this.#wait = options.wait ?? defaultRetryWait;
    this.#attempts = {
      credentials: options.credentials,
      httpClient: options.httpClient ?? createFetchHttpClient(),
      anthropic: createAnthropicMessagesAdapter(),
      openai: createOpenAIChatCompletionsAdapter(),
      maxFrameBytes: options.maxFrameBytes,
      maxToolInputBytes: options.maxToolInputBytes,
    };
  }

  async *stream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    // Pre-cancelled: no candidate resolution, no credential read, no HTTP call.
    if (isAborted(signal)) {
      yield streamErrorEvent("aborted");
      return;
    }

    let candidates: readonly ResolvedRoute[];
    try {
      candidates = this.#registry.resolveRouteCandidates(request.routeId);
    } catch {
      yield streamErrorEvent("gateway_error");
      return;
    }

    const policy = this.#policy;
    let attemptsUsed = 0;
    let lastRetryableCode: StreamErrorCode | undefined;

    candidates: for (const candidate of candidates) {
      for (let attempt = 0; attempt < policy.maxAttemptsPerProvider; attempt += 1) {
        if (isAborted(signal)) {
          yield streamErrorEvent("aborted");
          return;
        }
        if (attemptsUsed >= policy.maxTotalAttempts) {
          break candidates;
        }

        if (attempt > 0) {
          await this.#wait(computeBackoffDelayMs(policy, attempt - 1), signal);
          if (isAborted(signal)) {
            yield streamErrorEvent("aborted");
            return;
          }
        }

        attemptsUsed += 1;

        let visible = false;
        let retryableCode: StreamErrorCode | undefined;

        for await (const event of runCandidateAttempt(
          this.#attempts,
          candidate,
          request,
          signal,
        )) {
          if (isVisibleStreamEvent(event)) {
            // Streamed straight through: output is never buffered.
            visible = true;
            yield event;
            continue;
          }

          if (visible || !isRetryableStreamError(event)) {
            // Committed, cancelled, or not retryable at all.
            yield event;
            return;
          }

          // The retryable code is in the whitelist by construction.
          retryableCode = event.code as StreamErrorCode;
          break;
        }

        if (retryableCode === undefined) {
          if (visible) {
            // The attempt finished after producing output.
            return;
          }
          // An attempt that produced nothing at all cannot be retried safely.
          yield streamErrorEvent("gateway_error");
          return;
        }

        // Suppressed on purpose: the consumer only ever sees the final outcome.
        lastRetryableCode = retryableCode;
      }
    }

    yield streamErrorEvent(lastRetryableCode ?? "gateway_error");
  }
}

export function createResilientRoutedHttpModelGateway(
  options: ResilientRoutedHttpModelGatewayOptions,
): ResilientRoutedHttpModelGateway {
  return new ResilientRoutedHttpModelGateway(options);
}
