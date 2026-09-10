import type {
  CredentialStore,
  ProviderProtocol,
  ProviderRegistry,
} from "@agent-workbench/provider-registry";
import type { HttpResponse } from "@agent-workbench/model-gateway";

export type ProviderHealthStatus =
  | "healthy"
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "protocol_error"
  | "aborted";

export interface ProviderHealth {
  readonly providerId: string;
  readonly status: ProviderHealthStatus;
  readonly latencyMs: number;
  readonly checkedAt: number;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly created?: number;
  readonly createdAt?: string;
  readonly ownedBy?: string;
  readonly displayName?: string;
}

export interface ProviderModelCatalog {
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly models: readonly ModelCatalogEntry[];
  readonly checkedAt: number;
}

/**
 * GET request shape for discovery.
 *
 * The transport seam in model-gateway is typed for chat POSTs. Discovery uses
 * a structurally compatible GET request instead of widening that package.
 */
export interface DiscoveryHttpRequest {
  readonly method: "GET";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export type DiscoveryHttpResponse = HttpResponse;

export type DiscoveryHttpClient = (
  request: DiscoveryHttpRequest,
) => Promise<DiscoveryHttpResponse>;

export interface ProviderDiscovery {
  checkProvider(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderHealth>;
  listModels(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<ProviderModelCatalog>;
}

export interface ProviderDiscoveryOptions {
  readonly registry: ProviderRegistry;
  readonly credentialStore: CredentialStore;
  readonly httpClient: DiscoveryHttpClient;
  readonly clock?: () => number;
  readonly maxResponseBytes?: number;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES_LIMIT = 8 * 1024 * 1024;
