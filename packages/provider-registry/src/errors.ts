/**
 * Stable, machine-readable error codes for the provider registry.
 *
 * Codes are part of the public contract: callers must branch on `code` and must
 * never depend on the human readable message text.
 */
export const PROVIDER_REGISTRY_ERROR_CODES = Object.freeze({
  invalidProviderId: "invalid_provider_id",
  duplicateProviderId: "duplicate_provider_id",
  providerNotFound: "provider_not_found",
  providerDisabled: "provider_disabled",
  invalidProviderName: "invalid_provider_name",
  invalidProviderProtocol: "invalid_provider_protocol",
  invalidProviderUrl: "invalid_provider_url",
  invalidProviderModels: "invalid_provider_models",
  invalidProviderEnabled: "invalid_provider_enabled",
  forbiddenProviderField: "forbidden_provider_field",

  invalidCredentialRef: "invalid_credential_ref",
  invalidCredentialValue: "invalid_credential_value",
  invalidCredentialStore: "invalid_credential_store",
  credentialBackendFailed: "credential_backend_failed",

  invalidRouteId: "invalid_route_id",
  duplicateRouteId: "duplicate_route_id",
  routeNotFound: "route_not_found",
  routeDisabled: "route_disabled",
  invalidRouteName: "invalid_route_name",
  invalidRouteModel: "invalid_route_model",
  invalidRouteEnabled: "invalid_route_enabled",
  forbiddenRouteField: "forbidden_route_field",

  invalidFallbackProviderIds: "invalid_fallback_provider_ids",
  duplicateFallbackProviderId: "duplicate_fallback_provider_id",
  fallbackProviderNotFound: "fallback_provider_not_found",
  fallbackModelNotAvailable: "fallback_model_not_available",
  tooManyFallbackProviders: "too_many_fallback_providers",

  providerHasRoutes: "provider_has_routes",
  modelNotAvailable: "model_not_available",
  invalidRegistrySnapshot: "invalid_registry_snapshot",
} as const);

/**
 * Fixed message table.
 *
 * Messages deliberately never echo caller supplied values: no URLs, no field
 * values, no credentials and no tokens. A rejected input must not become an
 * exfiltration channel through error reporting.
 */
const ERROR_MESSAGES = Object.freeze({
  invalidProviderId: "Provider id must match ^[a-z][a-z0-9._-]{0,63}$.",
  duplicateProviderId: "A provider with this id is already registered.",
  providerNotFound: "Provider is not registered.",
  providerDisabled: "Provider is disabled.",
  invalidProviderName:
    "Provider name must be a non-empty string without leading or trailing whitespace.",
  invalidProviderProtocol:
    "Provider protocol must be anthropic_messages or openai_compatible.",
  invalidProviderUrl:
    "Provider baseUrl must be an absolute http or https URL without user info, query or hash.",
  invalidProviderModels:
    "Provider models must be a non-empty list of unique model names.",
  invalidProviderEnabled: "Provider enabled must be a boolean.",
  forbiddenProviderField:
    "Provider definition contains a field that is not allowed in user supplied configuration.",

  invalidCredentialRef:
    "credentialRef must be null or match ^credential:[a-z][a-z0-9._-]{0,63}$.",
  invalidCredentialValue: "Credential value is invalid.",
  invalidCredentialStore: "Credential store options are invalid.",
  credentialBackendFailed: "Credential operation failed.",

  invalidRouteId: "Route id must match ^[a-z][a-z0-9._-]{0,63}$.",
  duplicateRouteId: "A route with this id is already registered.",
  routeNotFound: "Route is not registered.",
  routeDisabled: "Route is disabled.",
  invalidRouteName:
    "Route name must be a non-empty string without leading or trailing whitespace.",
  invalidRouteModel: "Route model must be a non-empty model name.",
  invalidRouteEnabled: "Route enabled must be a boolean.",
  forbiddenRouteField:
    "Route definition contains a field that is not allowed in user supplied configuration.",

  invalidFallbackProviderIds:
    "Route fallbackProviderIds must be an ordered list of provider ids.",
  duplicateFallbackProviderId:
    "Route fallbackProviderIds must not repeat a provider or the primary provider.",
  fallbackProviderNotFound: "A fallback provider is not registered.",
  fallbackModelNotAvailable:
    "A fallback provider does not serve the model of the route.",
  tooManyFallbackProviders:
    "Route fallbackProviderIds exceeds the supported number of fallbacks.",

  providerHasRoutes: "Provider is still referenced by a route and cannot be removed.",
  modelNotAvailable: "Route model is not available on the referenced provider.",
  invalidRegistrySnapshot: "Registry state is inconsistent.",
} as const);

export type ProviderRegistryErrorCodeKey = keyof typeof ERROR_MESSAGES;

export class ProviderRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}

export function providerRegistryError(
  key: ProviderRegistryErrorCodeKey,
): ProviderRegistryError {
  return new ProviderRegistryError(
    PROVIDER_REGISTRY_ERROR_CODES[key],
    ERROR_MESSAGES[key],
  );
}

export function fail(key: ProviderRegistryErrorCodeKey): never {
  throw providerRegistryError(key);
}
