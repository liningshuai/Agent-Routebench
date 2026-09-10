import {
  buildAnthropicHeaders,
  buildOpenAIChatHeaders,
  buildProviderUrl,
  releaseResponseBody,
} from "@agent-workbench/model-gateway";
import type {
  ProviderDefinition,
  ProviderRegistry,
  CredentialStore,
} from "@agent-workbench/provider-registry";
import { PROVIDER_ID_PATTERN } from "@agent-workbench/provider-registry";
import { ProviderDiscoveryError, discoveryError, failDiscovery } from "./errors.js";
import { parseModelCatalogDocument, readBodyText } from "./parse.js";
import type {
  DiscoveryHttpClient,
  DiscoveryHttpRequest,
  ProviderDiscovery,
  ProviderDiscoveryOptions,
  ProviderHealth,
  ProviderHealthStatus,
  ProviderModelCatalog,
} from "./types.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES_LIMIT,
} from "./types.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const OPENAI_MODELS_ENDPOINT = "/models";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

function assertCallable(value: unknown, name: string): void {
  if (typeof value !== "object" || value === null) {
    throw discoveryError("invalidDiscoveryOptions");
  }
  if (typeof (value as Record<string, unknown>)[name] !== "function") {
    throw discoveryError("invalidDiscoveryOptions");
  }
}

function normalizeMaxBytes(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_RESPONSE_BYTES_LIMIT
  ) {
    throw discoveryError("invalidDiscoveryOptions");
  }
  return value;
}

function assertOptions(options: ProviderDiscoveryOptions): {
  registry: ProviderRegistry;
  credentialStore: CredentialStore;
  httpClient: DiscoveryHttpClient;
  clock: () => number;
  maxResponseBytes: number;
} {
  if (
    options === null ||
    options === undefined ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw discoveryError("invalidDiscoveryOptions");
  }
  const raw = options as Partial<ProviderDiscoveryOptions>;

  if (raw.registry === undefined || raw.registry === null) {
    throw discoveryError("invalidDiscoveryOptions");
  }
  assertCallable(raw.registry, "getProvider");

  if (raw.credentialStore === undefined || raw.credentialStore === null) {
    throw discoveryError("invalidDiscoveryOptions");
  }
  assertCallable(raw.credentialStore, "get");

  if (raw.httpClient === undefined || raw.httpClient === null) {
    throw discoveryError("invalidDiscoveryOptions");
  }
  if (typeof raw.httpClient !== "function") {
    throw discoveryError("invalidDiscoveryOptions");
  }

  const clock = raw.clock ?? Date.now;
  if (typeof clock !== "function") {
    throw discoveryError("invalidDiscoveryOptions");
  }

  const maxResponseBytes = normalizeMaxBytes(raw.maxResponseBytes);

  return {
    registry: raw.registry,
    credentialStore: raw.credentialStore,
    httpClient: raw.httpClient,
    clock,
    maxResponseBytes,
  };
}

function mapStatusToHealth(status: number): ProviderHealthStatus {
  if (status === 401 || status === 403) {
    return "unauthorized";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "unavailable";
}

function mapStatusToError(status: number): never {
  if (status === 401 || status === 403) {
    failDiscovery("unauthorized");
  }
  if (status === 429) {
    failDiscovery("rateLimited");
  }
  failDiscovery("upstreamUnavailable");
}

function resolveProvider(
  registry: ProviderRegistry,
  providerId: string,
): ProviderDefinition {
  if (typeof providerId !== "string" || !PROVIDER_ID_PATTERN.test(providerId)) {
    failDiscovery("invalidProviderId");
  }
  const provider = registry.getProvider(providerId);
  if (provider === undefined) {
    failDiscovery("providerNotFound");
  }
  if (!provider.enabled) {
    failDiscovery("providerDisabled");
  }
  return provider;
}

function endpointFor(provider: ProviderDefinition): string {
  if (provider.protocol === "anthropic_messages") {
    return ANTHROPIC_MODELS_ENDPOINT;
  }
  return OPENAI_MODELS_ENDPOINT;
}

function headersFor(provider: ProviderDefinition, secret: string): Readonly<Record<string, string>> {
  if (provider.protocol === "anthropic_messages") {
    return buildAnthropicHeaders(secret);
  }
  return buildOpenAIChatHeaders(secret);
}

function buildRequest(
  provider: ProviderDefinition,
  secret: string,
  signal: AbortSignal | undefined,
): DiscoveryHttpRequest {
  const url = buildProviderUrl(provider.baseUrl, endpointFor(provider));
  const headers = headersFor(provider, secret);
  return {
    method: "GET",
    url,
    headers,
    // GET carries no body; kept empty so the transport seam stays uniform.
    body: "",
    ...(signal === undefined ? {} : { signal }),
  };
}

async function fetchCatalogText(
  httpClient: DiscoveryHttpClient,
  request: DiscoveryHttpRequest,
  maxResponseBytes: number,
): Promise<string> {
  let response;
  try {
    response = await httpClient(request);
  } catch (error) {
    if (
      error instanceof ProviderDiscoveryError &&
      error.code === "aborted"
    ) {
      failDiscovery("aborted");
    }
    if (isAborted(request.signal)) {
      failDiscovery("aborted");
    }
    failDiscovery("upstreamUnavailable");
  }

  if (isAborted(request.signal)) {
    releaseResponseBody(response.body);
    failDiscovery("aborted");
  }

  if (response.status < 200 || response.status >= 300) {
    releaseResponseBody(response.body);
    mapStatusToError(response.status);
  }

  if (response.body === null) {
    failDiscovery("providerProtocolError");
  }

  return readBodyText(response.body, maxResponseBytes, request.signal);
}

async function loadCatalog(
  options: ReturnType<typeof assertOptions>,
  providerId: string,
  signal: AbortSignal | undefined,
  checkedAt: number,
): Promise<ProviderModelCatalog> {
  if (isAborted(signal)) {
    failDiscovery("aborted");
  }

  const provider = resolveProvider(options.registry, providerId);
  const credentialRef = provider.credentialRef;
  if (credentialRef === null) {
    failDiscovery("missingCredential");
  }

  const secret = await options.credentialStore.get(credentialRef);
  if (isAborted(signal)) {
    failDiscovery("aborted");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    failDiscovery("credentialNotFound");
  }

  const request = buildRequest(provider, secret, signal);
  const text = await fetchCatalogText(
    options.httpClient,
    request,
    options.maxResponseBytes,
  );

  if (isAborted(signal)) {
    failDiscovery("aborted");
  }

  return parseModelCatalogDocument(
    text,
    provider.id,
    provider.protocol,
    checkedAt,
  );
}

/** Local configuration errors are not health outcomes; they reject. */
const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_provider_id",
  "provider_not_found",
  "provider_disabled",
  "missing_credential",
  "credential_not_found",
  "invalid_discovery_options",
]);

function isConfigError(error: unknown): boolean {
  return (
    error instanceof ProviderDiscoveryError &&
    CONFIG_ERROR_CODES.has(error.code)
  );
}

function healthStatusForError(error: unknown): ProviderHealthStatus {
  if (!(error instanceof ProviderDiscoveryError)) {
    return "unavailable";
  }
  switch (error.code) {
    case "aborted":
      return "aborted";
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "provider_protocol_error":
    case "invalid_model_catalog":
    case "duplicate_model_id":
    case "response_too_large":
      return "protocol_error";
    default:
      return "unavailable";
  }
}

class ProviderDiscoveryService implements ProviderDiscovery {
  readonly #registry: ProviderRegistry;
  readonly #credentialStore: CredentialStore;
  readonly #httpClient: DiscoveryHttpClient;
  readonly #clock: () => number;
  readonly #maxResponseBytes: number;

  constructor(rawOptions: ProviderDiscoveryOptions) {
    const options = assertOptions(rawOptions);
    this.#registry = options.registry;
    this.#credentialStore = options.credentialStore;
    this.#httpClient = options.httpClient;
    this.#clock = options.clock;
    this.#maxResponseBytes = options.maxResponseBytes;
  }

  async checkProvider(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderHealth> {
    const startedAt = this.#clock();
    const options = {
      registry: this.#registry,
      credentialStore: this.#credentialStore,
      httpClient: this.#httpClient,
      clock: this.#clock,
      maxResponseBytes: this.#maxResponseBytes,
    };
    try {
      // Use startedAt as the catalog timestamp so the injected clock advances
      // only once before completion.
      await loadCatalog(options, providerId, signal, startedAt);
      const finishedAt = this.#clock();
      return {
        providerId,
        status: "healthy",
        latencyMs: Math.max(0, finishedAt - startedAt),
        checkedAt: finishedAt,
      };
    } catch (error) {
      if (isConfigError(error)) {
        throw error;
      }
      const finishedAt = this.#clock();
      return {
        providerId: typeof providerId === "string" ? providerId : "",
        status: healthStatusForError(error),
        latencyMs: Math.max(0, finishedAt - startedAt),
        checkedAt: finishedAt,
      };
    }
  }

  async listModels(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderModelCatalog> {
    const checkedAt = this.#clock();
    return loadCatalog(
      {
        registry: this.#registry,
        credentialStore: this.#credentialStore,
        httpClient: this.#httpClient,
        clock: this.#clock,
        maxResponseBytes: this.#maxResponseBytes,
      },
      providerId,
      signal,
      checkedAt,
    );
  }
}

export function createProviderDiscovery(
  options: ProviderDiscoveryOptions,
): ProviderDiscovery {
  return new ProviderDiscoveryService(options);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}
