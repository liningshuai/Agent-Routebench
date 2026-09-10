import type { ModelRequest, ModelStreamEvent } from "@agent-workbench/agent-contracts";
import type { CredentialStore, ResolvedRoute } from "@agent-workbench/provider-registry";

import { streamErrorEvent } from "./adapters/errors.js";
import type { ProtocolAdapter, StreamDecodeOptions } from "./adapters/types.js";
import {
  ANTHROPIC_MESSAGES_ENDPOINT,
  OPENAI_CHAT_COMPLETIONS_ENDPOINT,
  buildAnthropicHeaders,
  buildOpenAIChatHeaders,
  buildProviderUrl,
  mapHttpStatusToErrorCode,
  releaseResponseBody,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "./http-transport.js";

/**
 * Everything one candidate attempt needs.
 *
 * The adapters and the transport are shared between attempts, while every piece
 * of mutable state (headers, decoder state, pending promises) is created inside
 * the attempt itself.
 */
export interface CandidateAttemptOptions {
  readonly credentials: CredentialStore;
  readonly httpClient: HttpClient;
  readonly anthropic: ProtocolAdapter;
  readonly openai: ProtocolAdapter;
  readonly maxFrameBytes: number | undefined;
  readonly maxToolInputBytes: number | undefined;
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

/**
 * Reads the abort flag through a call on purpose.
 *
 * Calling a helper keeps TypeScript from narrowing the flag to `false` for the
 * rest of the scope after the first check, which would make the later checks
 * unreachable as far as the type system is concerned.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function endpointFor(protocol: ResolvedRoute["protocol"]): string {
  return protocol === "anthropic_messages"
    ? ANTHROPIC_MESSAGES_ENDPOINT
    : OPENAI_CHAT_COMPLETIONS_ENDPOINT;
}

function headersFor(
  protocol: ResolvedRoute["protocol"],
  secret: string,
): Readonly<Record<string, string>> {
  return protocol === "anthropic_messages"
    ? buildAnthropicHeaders(secret)
    : buildOpenAIChatHeaders(secret);
}

/**
 * Resolves one candidate into a concrete request.
 *
 * The candidate carries a credential *reference* only; the secret is read here,
 * used to build the authentication headers of this single request, and never
 * stored on the candidate, the request or any event.
 */
async function prepareInvocation(
  options: CandidateAttemptOptions,
  candidate: ResolvedRoute,
  request: ModelRequest,
): Promise<PreparedInvocation> {
  // A route candidate serves exactly one model: a mismatch is refused, never
  // rewritten.
  if (request.model !== candidate.model) {
    throw new Error("The requested model does not match the resolved route.");
  }

  const credentialRef = candidate.credentialRef;
  if (credentialRef === null) {
    throw new Error("The resolved route does not reference a credential.");
  }

  const secret = await options.credentials.get(credentialRef);
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("The referenced credential is not available.");
  }

  const adapter =
    candidate.protocol === "anthropic_messages" ? options.anthropic : options.openai;
  const encoded = adapter.encode(request);
  const body = JSON.stringify(encoded.body);
  if (typeof body !== "string") {
    throw new Error("The encoded request body could not be serialised.");
  }

  return {
    adapter,
    url: buildProviderUrl(candidate.baseUrl, endpointFor(candidate.protocol)),
    headers: headersFor(candidate.protocol, secret),
    body,
  };
}

/**
 * Performs exactly one HTTP request.
 *
 * The guarded promise never rejects, so a transport failure that lands after the
 * consumer gave up can never become an unhandled rejection.
 */
async function sendRequest(
  options: CandidateAttemptOptions,
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

  const guarded: Promise<GuardedOutcome> = options.httpClient(request).then(
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

function decodeOptions(
  options: CandidateAttemptOptions,
  signal: AbortSignal | undefined,
): StreamDecodeOptions {
  return {
    signal,
    maxFrameBytes: options.maxFrameBytes,
    maxToolInputBytes: options.maxToolInputBytes,
  };
}

/**
 * Runs exactly one attempt against one resolved candidate.
 *
 * Behaviour, shared with the single shot gateway:
 * - one candidate, one HTTP request, one decoder;
 * - the error surface is limited to the codes Agent Core already accepts, with
 *   fixed messages that never embed a URL, a status text, a body or an
 *   exception message;
 * - cancellation is forwarded to the transport and honoured while waiting for
 *   the response and while decoding it.
 *
 * A retryable looking failure is reported as a plain error event: deciding
 * whether it may be retried or answered by another candidate is the caller's
 * job, not this function's.
 */
export async function* runCandidateAttempt(
  options: CandidateAttemptOptions,
  candidate: ResolvedRoute,
  request: ModelRequest,
  signal: AbortSignal | undefined,
): AsyncIterable<ModelStreamEvent> {
  let invocation: PreparedInvocation;
  try {
    invocation = await prepareInvocation(options, candidate, request);
  } catch {
    yield streamErrorEvent("gateway_error");
    return;
  }

  let outcome: SendOutcome;
  try {
    outcome = await sendRequest(options, invocation, signal);
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
    yield* invocation.adapter.decode(response.body, decodeOptions(options, signal));
  } catch {
    if (isAborted(signal)) {
      yield streamErrorEvent("aborted");
      return;
    }
    yield streamErrorEvent("gateway_error");
  }
}
