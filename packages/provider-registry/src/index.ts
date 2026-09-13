export type {
  ProviderDefinition,
  ProviderProtocol,
  ResolvedRoute,
  RouteDefinition,
} from "./types.js";
export {
  CREDENTIAL_REF_PATTERN,
  MAX_ROUTE_FALLBACKS,
  PROVIDER_ID_PATTERN,
  assertCredentialRef,
  cloneProviderDefinition,
  cloneRouteDefinition,
  isValidCredentialRef,
  validateProviderDefinition,
  validateRouteDefinition,
} from "./types.js";

export type { ProviderRegistryErrorCodeKey } from "./errors.js";
export {
  PROVIDER_REGISTRY_ERROR_CODES,
  ProviderRegistryError,
  providerRegistryError,
} from "./errors.js";

export type {
  CredentialBackend,
  CredentialRef,
  CredentialStore,
  CredentialStoreOptions,
} from "./credential-store.js";
export {
  MAX_CREDENTIAL_BYTES,
  InMemoryCredentialStore,
  UnavailableCredentialStore,
  assertCredentialBackend,
  createSecureCredentialStore,
} from "./credential-store.js";

export type { ProviderPreset } from "./presets.js";
export { getOfficialProviderPresets } from "./presets.js";

export type { ProviderRegistry } from "./registry.js";
export { InMemoryProviderRegistry } from "./registry.js";
