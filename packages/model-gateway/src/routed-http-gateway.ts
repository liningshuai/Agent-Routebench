import type {
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
import type {
  CredentialStore,
  ProviderProtocol,
  ProviderRegistry,
} from "@agent-workbench/provider-registry";

import { streamErrorEvent } from "./adapters/errors.js";
import {
  createAnthropicMessagesAdapter,
  createOpenAIChatCompletionsAdapter,
} from "./adapters/index.js";
import type { ProtocolAdapter, StreamDecodeOptions } from "./adapters/types.js";
import {
  ANTHROPIC_MESSAGES_ENDPOINT,
  OPENAI_CHAT_COMPLETIONS_ENDPOINT,
  buildAnthropicHeaders,
  buildOpenAIChatHeaders,
  buildProviderUrl,
  createFetchHttpClient,
  mapHttpStatusToErrorCode,
  releaseResponseBody,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "./http-transport.js";

export interface RoutedHttpModelGatewayOptions {
  readonly registry: ProviderRegistry;
  readonly credentials: CredentialStore;
  readonly httpClient?: HttpClient;
  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}

/** Everything one invocation needs, resolved before any byte leaves the process. */
interface PreparedInvocation {
  readonly adapter: ProtocolAdapter;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type SendOutcome =
  | { readonly kind: "response"; readonly response: HttpResponse }
  | { readonly kind: "aborted" };

type GuardedOutcome = SendOutcome | { readonly kind: "failed" };

function endpointFor(protocol: ProviderProtocol): string {
  return protocol === "anthropic_messages"
    ? ANTHROPIC_MESSAGES_ENDPOINT
    : OPENAI_CHAT_COMPLETIONS_ENDPOINT;
}

/**
 * Reads the abort flag through a call on purpose.
 *
 * Calling a helper keeps TypeScript from narrowing the flag to `false` for the
 * rest of the scope after the first check, which would make the later checks
 * unreachable as far as the type system is concerned.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function headersFor(
  protocol: ProviderProtocol,
  secret: string,
): Readonly<Record<string, string>> {
  return protocol === "anthropic_messages"
    ? buildAnthropicHeaders(secret)
    : buildOpenAIChatHeaders(secret);
}

/**
 * A Model Gateway that resolves a route, reads the referenced credential,
 * encodes the request with the protocol adapter and performs exactly one
 * injected HTTP call.
 *
 * Invariants:
 * - one route, one provider, one HTTP request: no retry, no failover,
 *   no provider rotation;
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
  readonly #credentials: CredentialStore;
  readonly #http: HttpClient;
  readonly #anthropic: ProtocolAdapter;
  readonly #openai: ProtocolAdapter;
  readonly #maxFrameBytes: number | undefined;
  readonly #maxToolInputBytes: number | undefined;

  constructor(options: RoutedHttpModelGatewayOptions) {
    this.#registry = options.registry;
    this.#credentials = options.credentials;
    this.#http = options.httpClient ?? createFetchHttpClient();
    this.#anthropic = createAnthropicMessagesAdapter();
    this.#openai = createOpenAIChatCompletionsAdapter();
    this.#maxFrameBytes = options.maxFrameBytes;
    this.#maxToolInputBytes = options.maxToolInputBytes;
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

    let invocation: PreparedInvocation;
    try {
      invocation = await this.#prepare(request);
    } catch {
      yield streamErrorEvent("gateway_error");
      return;
    }

    let outcome: SendOutcome;
    try {
      outcome = await this.#send(invocation, signal);
    } catch {
      if (isAborted(signal)) {
        yield streamErrorEvent("aborted");
        return;
      }
      yield streamErrorEvent("upstream_unavailable");
      return;
    }

    if (outcome.kind === "aborted") {
      yield streamErrorEvent("aborted");
      return;
    }

    const response = outcome.response;

    if (response.status < 200 || response.status > 299) {
      // The body is released unread: it may embed a URL or a credential.
      releaseResponseBody(response.body);
      yield streamErrorEvent(mapHttpStatusToErrorCode(response.status));
      return;
    }

    if (response.body === null) {
      yield streamErrorEvent("provider_protocol_error");
      return;
    }

    try {
      yield* invocation.adapter.decode(response.body, this.#decodeOptions(signal));
    } catch {
      if (isAborted(signal)) {
        yield streamErrorEvent("aborted");
        return;
      }
      yield streamErrorEvent("gateway_error");
    }
  }

  async #prepare(request: ModelRequest): Promise<PreparedInvocation> {
    const resolved = this.#registry.resolveRoute(request.routeId);

    // A route serves exactly one model: a mismatch is refused, never rewritten.
    if (request.model !== resolved.model) {
      throw new Error("The requested model does not match the resolved route.");
    }

    const credentialRef = resolved.credentialRef;
    if (credentialRef === null) {
      throw new Error("The resolved route does not reference a credential.");
    }

    const secret = await this.#credentials.get(credentialRef);
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error("The referenced credential is not available.");
    }

    const adapter =
      resolved.protocol === "anthropic_messages" ? this.#anthropic : this.#openai;
    const encoded = adapter.encode(request);
    const body = JSON.stringify(encoded.body);
    if (typeof body !== "string") {
      throw new Error("The encoded request body could not be serialised.");
    }

    return {
      adapter,
      url: buildProviderUrl(resolved.baseUrl, endpointFor(resolved.protocol)),
      headers: headersFor(resolved.protocol, secret),
      body,
    };
  }

  async #send(
    invocation: PreparedInvocation,
    signal: AbortSignal | undefined,
  ): Promise<SendOutcome> {
    if (isAborted(signal)) {
      return { kind: "aborted" };
    }

    const request: HttpRequest =
      signal === undefined
        ? {
            method: "POST",
            url: invocation.url,
            headers: invocation.headers,
            body: invocation.body,
          }
        : {
            method: "POST",
            url: invocation.url,
            headers: invocation.headers,
            body: invocation.body,
            signal,
          };

    // The guarded promise never rejects, so a transport failure that lands
    // after the consumer gave up can never become an unhandled rejection.
    const guarded: Promise<GuardedOutcome> = this.#http(request).then(
      (response) => ({ kind: "response", response }) as const,
      () => ({ kind: "failed" }) as const,
    );

    if (signal === undefined) {
      const outcome = await guarded;
      if (outcome.kind === "failed") {
        throw new Error("The transport request failed.");
      }
      return outcome;
    }

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<SendOutcome>((resolve) => {
      onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    });

    let outcome: GuardedOutcome;
    try {
      outcome = await Promise.race([guarded, aborted]);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (outcome.kind === "aborted") {
      // A response may still arrive later; release its body unread so the
      // connection is not abandoned, and never let that step block the caller.
      void guarded
        .then((late) => {
          if (late.kind === "response") {
            releaseResponseBody(late.response.body);
          }
        })
        .catch(() => {
          // Best effort only.
        });
      return { kind: "aborted" };
    }

    if (outcome.kind === "failed") {
      throw new Error("The transport request failed.");
    }

    return outcome;
  }

  #decodeOptions(signal: AbortSignal | undefined): StreamDecodeOptions {
    return {
      signal,
      maxFrameBytes: this.#maxFrameBytes,
      maxToolInputBytes: this.#maxToolInputBytes,
    };
  }
}

export function createRoutedHttpModelGateway(
  options: RoutedHttpModelGatewayOptions,
): RoutedHttpModelGateway {
  return new RoutedHttpModelGateway(options);
}
