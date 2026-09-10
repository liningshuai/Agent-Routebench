import type {
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
import type {
  CredentialStore,
  ProviderRegistry,
  ResolvedRoute,
} from "@agent-workbench/provider-registry";

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
import { createFetchHttpClient, type HttpClient } from "./http-transport.js";

export interface RoutedHttpModelGatewayOptions {
  readonly registry: ProviderRegistry;
  readonly credentials: CredentialStore;
  readonly httpClient?: HttpClient;
  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}

/**
 * A Model Gateway that resolves **one** route, reads the referenced credential,
 * encodes the request with the protocol adapter and performs exactly one
 * injected HTTP call.
 *
 * Invariants:
 * - one route, one provider, one HTTP request: no retry and no failover. Use the
 *   resilient gateway when a bounded retry or an ordered provider fallback is
 *   wanted;
 * - a secret exists only inside the authentication headers of a single
 *   `HttpRequest`; it never enters the encoded body, an event, an error message
 *   or a log;
 * - the error surface is limited to the codes Agent Core already accepts, with
 *   fixed messages that never embed a URL, a status text, a body or an
 *   exception message;
 * - cancellation is forwarded to the transport and honoured while waiting for
 *   the response and while decoding it.
 */
export class RoutedHttpModelGateway implements ModelGateway {
  readonly #registry: ProviderRegistry;
  readonly #attempts: CandidateAttemptOptions;

  constructor(options: RoutedHttpModelGatewayOptions) {
    this.#registry = options.registry;
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
    // Pre-cancelled: no route lookup, no credential read, no HTTP request.
    if (isAborted(signal)) {
      yield streamErrorEvent("aborted");
      return;
    }

    let resolved: ResolvedRoute;
    try {
      resolved = this.#registry.resolveRoute(request.routeId);
    } catch {
      yield streamErrorEvent("gateway_error");
      return;
    }

    yield* runCandidateAttempt(this.#attempts, resolved, request, signal);
  }
}

export function createRoutedHttpModelGateway(
  options: RoutedHttpModelGatewayOptions,
): RoutedHttpModelGateway {
  return new RoutedHttpModelGateway(options);
}
