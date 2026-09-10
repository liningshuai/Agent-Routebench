import type { StreamErrorCode } from "./adapters/errors.js";

/**
 * A fully materialised provider HTTP request.
 *
 * This is the only place where a credential value, an authentication header or
 * a provider URL exists. The request is handed straight to an `HttpClient` and
 * is never written to a log, an event, an error message or an encoded body.
 */
export interface HttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/**
 * A provider HTTP response.
 *
 * `body` is a *stream*, so the caller can decode incrementally. `null` means the
 * protocol response carried no body at all, which is a protocol error rather
 * than a transport error.
 */
export interface HttpResponse {
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
}

/**
 * The injectable transport seam.
 *
 * Production uses `createFetchHttpClient()`; every automated test injects a fake
 * so no test can reach a real provider.
 */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Minimal structural view of a `fetch` response used by the default client. */
export interface FetchResponseLike {
  readonly status: number;
  readonly body: unknown;
}

/** Minimal structural view of `fetch` so it can be injected in tests. */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<FetchResponseLike>;

/** Fixed endpoint for the Anthropic Messages protocol. */
export const ANTHROPIC_MESSAGES_ENDPOINT = "/v1/messages";

/** Fixed endpoint for the OpenAI Chat Completions protocol. */
export const OPENAI_CHAT_COMPLETIONS_ENDPOINT = "/chat/completions";

/** HTTP statuses that mean "the upstream side is temporarily unhealthy". */
const RETRYABLE_TRANSPORT_STATUSES: ReadonlySet<number> = new Set([
  408,
  425,
  500,
  502,
  503,
  504,
]);

/**
 * Joins a validated base URL with a fixed endpoint.
 *
 * The endpoint is never user supplied, trailing slashes are collapsed and the
 * result is re-parsed, so a request can never be redirected to another host or
 * end up with a duplicated `//` separator.
 */
export function buildProviderUrl(baseUrl: string, endpoint: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  const url = `${trimmed}${endpoint}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The provider base URL cannot be used.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The provider base URL cannot be used.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("The provider base URL cannot be used.");
  }
  return url;
}

/** Fixed Anthropic authentication headers. Never a bearer token. */
export function buildAnthropicHeaders(
  secret: string,
): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    "x-api-key": secret,
  };
}

/** Fixed OpenAI authentication headers. Never an api key header. */
export function buildOpenAIChatHeaders(
  secret: string,
): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${secret}`,
  };
}

/**
 * Maps an HTTP status onto one of the error codes Agent Core already accepts.
 *
 * The mapping never depends on the status text, on response headers or on the
 * response body: those are provider controlled and may embed a URL, a
 * credential or a payload.
 */
export function mapHttpStatusToErrorCode(status: number): StreamErrorCode {
  if (status === 429) {
    return "rate_limited";
  }
  if (RETRYABLE_TRANSPORT_STATUSES.has(status)) {
    return "upstream_unavailable";
  }
  return "gateway_error";
}

/**
 * Releases a response body without ever blocking and without reading it.
 *
 * Used when the response is rejected (non-2xx), when the body is never handed
 * to a decoder, or when a late response arrives after cancellation.
 */
export function releaseResponseBody(
  body: AsyncIterable<Uint8Array> | null,
): void {
  if (body === null || body === undefined) {
    return;
  }
  try {
    const iterator = (body as AsyncIterable<Uint8Array>)[
      Symbol.asyncIterator
    ]();
    const result = (iterator as AsyncIterator<Uint8Array>).return?.();
    if (
      result !== undefined &&
      result !== null &&
      typeof (result as Promise<unknown>).then === "function"
    ) {
      (result as Promise<unknown>).then(undefined, () => {
        // Cleanup failures never mask the decoded outcome.
      });
    }
  } catch {
    // Releasing is best effort only.
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

function toByteStream(body: unknown): AsyncIterable<Uint8Array> | null {
  // A `ReadableStream` in Node 24 is already async iterable.
  return isAsyncIterable(body) ? body : null;
}

/**
 * Builds the default production client on top of the Node 24 global fetch.
 *
 * This is the only place in the package that touches the global fetch. It still
 * performs no network I/O of its own: it performs exactly one call per request
 * with the URL, headers and body the gateway already decided.
 */
export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const perform =
      fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (typeof perform !== "function") {
      throw new Error("No HTTP client implementation is available.");
    }

    const init: RequestInit = {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
    };
    if (request.signal !== undefined) {
      init.signal = request.signal;
    }

    const response = await perform(request.url, init);
    return {
      status: response.status,
      body: toByteStream(response.body),
    };
  };
}
