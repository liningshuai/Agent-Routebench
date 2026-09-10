import type {
  AgentContentBlock,
  AgentMessage,
  AgentToolDefinition,
  ModelRequest,
} from "../../packages/agent-contracts/src/index.js";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "../../packages/model-gateway/src/index.js";
import type {
  ProviderProtocol,
  ProviderRegistry,
} from "../../packages/provider-registry/src/index.js";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
} from "../../packages/provider-registry/src/index.js";
import { bytes, fromChunks } from "./adapter-fixtures.js";

/* ------------------------------------------------------------------ *
 * Synthetic, offline only fixtures.
 *
 * Every value below is invented for these tests. None of them is a real
 * credential, and all of them are deliberately short so that the repository
 * secret scanner never mistakes them for one.
 * ------------------------------------------------------------------ */

export const TEST_SECRET = "t4-secret-value";
export const SECOND_SECRET = "t4-other-secret";
/** Value planted inside a hostile upstream body to prove it never surfaces. */
export const LEAK_PROBE = "t4-body-secret";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.test";
export const OPENAI_BASE_URL = "https://api.openai.test/v1";
export const DEFAULT_PROVIDER_ID = "provider-t4";
export const DEFAULT_ROUTE_ID = "route-t4";
export const DEFAULT_MODEL = "offline-model";
export const DEFAULT_CREDENTIAL_REF = "credential:t4";

/* ------------------------------------------------------------------ *
 * Request fixtures
 * ------------------------------------------------------------------ */

export function textBlock(text: string): AgentContentBlock {
  return { type: "text", text };
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
    requestId: "req-t4",
    routeId: DEFAULT_ROUTE_ID,
    model: DEFAULT_MODEL,
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

/* ------------------------------------------------------------------ *
 * Registry + credential fixtures
 * ------------------------------------------------------------------ */

export interface RouteFixture {
  readonly registry: ProviderRegistry;
  readonly credentials: InMemoryCredentialStore;
  readonly providerId: string;
  readonly routeId: string;
  readonly model: string;
  readonly credentialRef: string | null;
}

export interface RouteFixtureOptions {
  readonly protocol?: ProviderProtocol;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly credentialRef?: string | null;
  readonly providerEnabled?: boolean;
  readonly routeEnabled?: boolean;
  /** `null` registers the reference but stores no secret. */
  readonly secret?: string | null;
  readonly providerId?: string;
  readonly routeId?: string;
}

export function makeRouteFixture(options: RouteFixtureOptions = {}): RouteFixture {
  const protocol = options.protocol ?? "anthropic_messages";
  const baseUrl =
    options.baseUrl ??
    (protocol === "anthropic_messages" ? ANTHROPIC_BASE_URL : OPENAI_BASE_URL);
  const model = options.model ?? DEFAULT_MODEL;
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const routeId = options.routeId ?? DEFAULT_ROUTE_ID;
  const credentialRef =
    options.credentialRef === undefined
      ? DEFAULT_CREDENTIAL_REF
      : options.credentialRef;

  const registry = new InMemoryProviderRegistry();
  registry.registerProvider({
    id: providerId,
    name: "Provider T4",
    protocol,
    baseUrl,
    credentialRef,
    models: [model],
    enabled: options.providerEnabled ?? true,
  });
  registry.registerRoute({
    id: routeId,
    name: "Route T4",
    providerId,
    model,
    enabled: options.routeEnabled ?? true,
  });

  const credentials = new InMemoryCredentialStore();
  const secret = options.secret === undefined ? TEST_SECRET : options.secret;
  if (credentialRef !== null && secret !== null) {
    void credentials.set(credentialRef, secret);
  }

  return { registry, credentials, providerId, routeId, model, credentialRef };
}

/** Registers a working route and then disables the provider behind it. */
export function disableProvider(fixture: RouteFixture): void {
  const provider = fixture.registry.getProvider(fixture.providerId);
  if (provider === undefined) {
    throw new Error("fixture provider is missing");
  }
  fixture.registry.updateProvider({ ...provider, enabled: false });
}

/* ------------------------------------------------------------------ *
 * Fake HTTP client
 * ------------------------------------------------------------------ */

export interface RecordedHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
}

export interface FakeHttpClient {
  readonly client: HttpClient;
  readonly requests: RecordedHttpRequest[];
  readonly calls: () => number;
  readonly request: (index: number) => RecordedHttpRequest;
}

/**
 * Records every request and answers with the object the test supplies.
 * Nothing here touches the network: the fake fully replaces `fetch`.
 */
export function createFakeHttpClient(
  respond: (
    request: HttpRequest,
    index: number,
  ) => HttpResponse | Promise<HttpResponse>,
): FakeHttpClient {
  const requests: RecordedHttpRequest[] = [];

  const client: HttpClient = async (request) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: request.body,
      signal: request.signal,
    });
    return respond(request, requests.length - 1);
  };

  return {
    client,
    requests,
    calls: () => requests.length,
    request: (index) => requests[index],
  };
}

/** Case-insensitive header lookup, so tests never depend on header casing. */
export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

export function headerNames(headers: Readonly<Record<string, string>>): string[] {
  return Object.keys(headers).map((key) => key.toLowerCase()).sort();
}

export function httpResponse(
  status: number,
  body: HttpResponse["body"] = null,
): HttpResponse {
  return { status, body };
}

export function bytesBody(text: string): AsyncIterable<Uint8Array> {
  return fromChunks([bytes(text)]);
}

export function chunksBody(
  chunks: readonly (string | Uint8Array)[],
): AsyncIterable<Uint8Array> {
  return fromChunks(
    chunks.map((chunk) => (typeof chunk === "string" ? bytes(chunk) : chunk)),
  );
}

/* ------------------------------------------------------------------ *
 * SSE payloads (offline, synthetic)
 * ------------------------------------------------------------------ */

export function anthropicTextStream(text = "hello"): string {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
}

export function openaiTextStream(text = "hello"): string {
  return [
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
}

export function anthropicDeltaFrame(text: string): string {
  return `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`;
}

export function openaiDeltaFrame(text: string): string {
  return `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`;
}

export const ANTHROPIC_OPEN = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
].join("");

export const ANTHROPIC_CLOSE = [
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

export const OPENAI_CLOSE =
  'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"offline-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/* ------------------------------------------------------------------ *
 * Task 5 fixtures: ordered provider candidates and scripted transports
 * ------------------------------------------------------------------ */

/** Synthetic, clearly fake, and short enough for the repository secret scan. */
export const TASK5_SECRET_PRIMARY = "t5-secret-a";
export const TASK5_SECRET_FALLBACK = "t5-secret-b";
/** A value shaped like a secret, used only to prove it is rejected/never leaks. */
export const TASK5_SECRET_PROBE = "TASK5_SYNTHETIC_SECRET_VALUE";

export const TASK5_BASE_URL = "https://api.task5.test/v1";
export const TASK5_PRIMARY_BASE_URL = "https://primary.task5.test/v1";
export const TASK5_FALLBACK_BASE_URL = "https://fallback.task5.test/v1";
export const TASK5_ROUTE_ID = "route-t5";
export const TASK5_PRIMARY_ID = "primary-main";

export interface CandidateProviderSpec {
  readonly id: string;
  readonly protocol?: ProviderProtocol;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly credentialRef?: string | null;
  readonly enabled?: boolean;
  /** `null` registers the reference but stores no secret for it. */
  readonly secret?: string | null;
}

export interface CandidateRegistryFixture {
  readonly registry: ProviderRegistry;
  readonly credentials: InMemoryCredentialStore;
  readonly routeId: string;
  readonly model: string;
  readonly primaryId: string;
  readonly fallbackIds: readonly string[];
}

function baseUrlFor(protocol: ProviderProtocol): string {
  return protocol === "anthropic_messages" ? ANTHROPIC_BASE_URL : OPENAI_BASE_URL;
}

export function candidateFixture(options: {
  readonly routeId?: string;
  readonly model?: string;
  readonly routeEnabled?: boolean;
  readonly primary: CandidateProviderSpec;
  readonly fallbacks?: readonly CandidateProviderSpec[];
}): CandidateRegistryFixture {
  const routeId = options.routeId ?? TASK5_ROUTE_ID;
  const model = options.model ?? DEFAULT_MODEL;
  const fallbacks = options.fallbacks ?? [];

  const registry = new InMemoryProviderRegistry();
  const credentials = new InMemoryCredentialStore();

  for (const spec of [options.primary, ...fallbacks]) {
    const protocol = spec.protocol ?? "anthropic_messages";
    const credentialRef =
      spec.credentialRef === undefined ? `credential:${spec.id}` : spec.credentialRef;
    registry.registerProvider({
      id: spec.id,
      name: `Provider ${spec.id}`,
      protocol,
      baseUrl: spec.baseUrl ?? baseUrlFor(protocol),
      credentialRef,
      models: [spec.model ?? model],
      // A route may not be registered against a disabled primary provider, so
      // `enabled: false` specs are applied after the route exists (see below).
      enabled: true,
    });

    const secret = spec.secret === undefined ? `${spec.id}-value` : spec.secret;
    if (credentialRef !== null && secret !== null) {
      void credentials.set(credentialRef, secret);
    }
  }

  registry.registerRoute({
    id: routeId,
    name: "Route T5",
    providerId: options.primary.id,
    model,
    enabled: options.routeEnabled ?? true,
    ...(fallbacks.length === 0
      ? {}
      : { fallbackProviderIds: fallbacks.map((spec) => spec.id) }),
  });

  // A route may not be registered against a disabled primary provider, so a
  // spec marked `enabled: false` is applied right after the route exists.
  for (const spec of [options.primary, ...fallbacks]) {
    if ((spec.enabled ?? true) === false) {
      const current = registry.getProvider(spec.id);
      if (current !== undefined && current.enabled) {
        registry.updateProvider({ ...current, enabled: false });
      }
    }
  }

  return {
    registry,
    credentials,
    routeId,
    model,
    primaryId: options.primary.id,
    fallbackIds: fallbacks.map((spec) => spec.id),
  };
}

/** Two providers, both serving the same model, with distinct credentials. */
export function twoProviderFixture(options: {
  readonly primaryProtocol?: ProviderProtocol;
  readonly fallbackProtocol?: ProviderProtocol;
  readonly primaryEnabled?: boolean;
  readonly fallbackEnabled?: boolean;
  readonly primarySecret?: string | null;
  readonly fallbackSecret?: string | null;
} = {}): CandidateRegistryFixture {
  return candidateFixture({
    primary: {
      id: TASK5_PRIMARY_ID,
      protocol: options.primaryProtocol ?? "anthropic_messages",
      baseUrl: TASK5_PRIMARY_BASE_URL,
      enabled: options.primaryEnabled ?? true,
      ...(options.primarySecret === undefined
        ? { secret: TASK5_SECRET_PRIMARY }
        : { secret: options.primarySecret }),
    },
    fallbacks: [
      {
        id: "fallback-second",
        protocol: options.fallbackProtocol ?? "anthropic_messages",
        baseUrl: TASK5_FALLBACK_BASE_URL,
        enabled: options.fallbackEnabled ?? true,
        ...(options.fallbackSecret === undefined
          ? { secret: TASK5_SECRET_FALLBACK }
          : { secret: options.fallbackSecret }),
      },
    ],
  });
}

export type ScriptedEntry =
  | HttpResponse
  | (() => HttpResponse | Promise<HttpResponse>);

/** Marker text used when a script runs out: any overrun is then visible in the events. */
export const SCRIPT_OVERRUN_TEXT = "script-overrun";

/**
 * Answers the n-th request with the n-th scripted entry.
 *
 * A request beyond the script is answered with a clearly marked success so that
 * an unexpected extra attempt shows up both in `calls()` and in the emitted
 * text instead of being silently swallowed.
 */
export function createScriptedHttpClient(
  script: readonly ScriptedEntry[],
): FakeHttpClient {
  return createFakeHttpClient((_request, index) => {
    const entry = script[index];
    if (entry === undefined) {
      return anthropicSuccessResponse(SCRIPT_OVERRUN_TEXT);
    }
    return typeof entry === "function" ? entry() : entry;
  });
}

/** A response that streams a complete Anthropic text answer. */
export function anthropicSuccessResponse(text = "ok"): HttpResponse {
  return httpResponse(200, bytesBody(anthropicTextStream(text)));
}

export function openaiSuccessResponse(text = "ok"): HttpResponse {
  return httpResponse(200, bytesBody(openaiTextStream(text)));
}

/** A retryable failure whose body must never be read. */
export function transportFailureResponse(status = 503): HttpResponse {
  return httpResponse(status, bytesBody(`{"error":"${TASK5_SECRET_PROBE}"}`));
}
