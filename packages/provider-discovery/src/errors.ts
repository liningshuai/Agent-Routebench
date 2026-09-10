/**
 * Stable error codes for provider discovery.
 *
 * Messages are fixed and never echo URLs, provider ids, credential refs,
 * secrets, headers, response bodies or stack traces.
 */
export const DISCOVERY_ERROR_CODES = Object.freeze({
  invalidDiscoveryOptions: "invalid_discovery_options",
  invalidProviderId: "invalid_provider_id",
  providerNotFound: "provider_not_found",
  providerDisabled: "provider_disabled",
  missingCredential: "missing_credential",
  credentialNotFound: "credential_not_found",
  unauthorized: "unauthorized",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  providerProtocolError: "provider_protocol_error",
  aborted: "aborted",
  invalidModelCatalog: "invalid_model_catalog",
  duplicateModelId: "duplicate_model_id",
  responseTooLarge: "response_too_large",
} as const);

export type DiscoveryErrorCodeKey = keyof typeof DISCOVERY_ERROR_CODES;

const ERROR_MESSAGES = Object.freeze({
  invalidDiscoveryOptions: "Provider discovery options are invalid.",
  invalidProviderId: "Provider id is invalid.",
  providerNotFound: "Provider is not registered.",
  providerDisabled: "Provider is disabled.",
  missingCredential: "Provider has no credential reference.",
  credentialNotFound: "Credential is not available.",
  unauthorized: "Provider rejected the credential.",
  rateLimited: "Provider rate limited the request.",
  upstreamUnavailable: "Provider is unavailable.",
  providerProtocolError: "Provider returned an unexpected protocol response.",
  aborted: "Request aborted.",
  invalidModelCatalog: "Model catalog is invalid.",
  duplicateModelId: "Model catalog contains a duplicate id.",
  responseTooLarge: "Provider response exceeded the size limit.",
} as const);

export class ProviderDiscoveryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderDiscoveryError";
    this.code = code;
  }
}

export function discoveryError(
  key: DiscoveryErrorCodeKey,
): ProviderDiscoveryError {
  return new ProviderDiscoveryError(
    DISCOVERY_ERROR_CODES[key],
    ERROR_MESSAGES[key],
  );
}

export function failDiscovery(key: DiscoveryErrorCodeKey): never {
  throw discoveryError(key);
}
