import {
  InMemoryProviderRegistry,
  ProviderRegistryError,
  cloneProviderDefinition,
  cloneRouteDefinition,
  isValidCredentialRef,
  validateProviderDefinition,
  validateRouteDefinition,
  type ProviderDefinition,
  type ProviderRegistry,
  type RouteDefinition,
} from "@agent-workbench/provider-registry";
import { fail, type PersistenceErrorCodeKey } from "./errors.js";
import type { PersistedConfigV1 } from "./types.js";

const ALLOWED_ROOT_FIELDS = new Set(["version", "providers", "routes"]);

const ALLOWED_PROVIDER_FIELDS = new Set([
  "id",
  "name",
  "protocol",
  "baseUrl",
  "credentialRef",
  "models",
  "enabled",
]);

const ALLOWED_ROUTE_FIELDS = new Set([
  "id",
  "name",
  "providerId",
  "model",
  "enabled",
  "fallbackProviderIds",
]);

const SECRET_LIKE_FIELDS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "token",
  "authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "client_secret",
  "clientsecret",
  "provider_secret",
  "providersecret",
  "bearer",
  "oauth",
  "endpoint",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isSerializableJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) {
    return true;
  }
  const t = typeof value;
  if (t === "string" || t === "boolean") {
    return true;
  }
  if (t === "number") {
    return Number.isFinite(value as number);
  }
  if (t !== "object") {
    return false;
  }
  const obj = value as object;
  if (seen.has(obj)) {
    return false;
  }
  seen.add(obj);
  if (Array.isArray(value)) {
    return value.every((item) => isSerializableJsonValue(item, seen));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).every((item) => isSerializableJsonValue(item, seen));
}

function assertJsonValue(value: unknown, code: PersistenceErrorCodeKey = "invalidPersistedConfig"): void {
  if (!isSerializableJsonValue(value, new WeakSet())) {
    fail(code);
  }
}

/** A credentialRef must never look like it carries an actual secret value. */
const SECRET_LIKE_CREDENTIAL_REF = /(secret|password|token|apikey|api_key|bearer|authorization)/i;

function assertSafeCredentialRef(credentialRef: string | null): void {
  if (credentialRef === null) {
    return;
  }
  if (!isValidCredentialRef(credentialRef) || SECRET_LIKE_CREDENTIAL_REF.test(credentialRef)) {
    fail("invalidPersistedProvider");
  }
}

function hasSecretLikeField(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) =>
    SECRET_LIKE_FIELDS.has(key.toLowerCase()),
  );
}

function mapRegistryError(error: unknown): never {
  if (!(error instanceof ProviderRegistryError)) {
    throw error;
  }

  const code = error.code;

  if (code === "forbidden_provider_field" || code === "forbidden_route_field") {
    fail("forbiddenPersistedField");
  }

  if (
    code === "invalid_provider_id" ||
    code === "invalid_provider_name" ||
    code === "invalid_provider_protocol" ||
    code === "invalid_provider_url" ||
    code === "invalid_provider_models" ||
    code === "invalid_provider_enabled" ||
    code === "invalid_credential_ref"
  ) {
    fail("invalidPersistedProvider");
  }

  if (
    code === "invalid_route_id" ||
    code === "invalid_route_name" ||
    code === "invalid_route_model" ||
    code === "invalid_route_enabled" ||
    code === "invalid_fallback_provider_ids" ||
    code === "duplicate_fallback_provider_id" ||
    code === "too_many_fallback_providers"
  ) {
    fail("invalidPersistedRoute");
  }

  if (code === "duplicate_provider_id") {
    fail("duplicatePersistedProvider");
  }

  if (code === "duplicate_route_id") {
    fail("duplicatePersistedRoute");
  }

  if (code === "provider_not_found" || code === "fallback_provider_not_found") {
    fail("persistedProviderNotFound");
  }

  if (
    code === "model_not_available" ||
    code === "fallback_model_not_available" ||
    code === "provider_disabled"
  ) {
    fail("persistedModelNotAvailable");
  }

  fail("invalidPersistedConfig");
}

/**
 * Creates a stable, deep-copied, secret-free snapshot of the registry.
 *
 * Providers and routes are sorted by id. CredentialStore contents and
 * environment variables are never read.
 */
export function createConfigSnapshot(
  registry: ProviderRegistry,
): PersistedConfigV1 {
  const providers = [...registry.listProviders()]
    .map(cloneProviderDefinition)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const routes = [...registry.listRoutes()]
    .map(cloneRouteDefinition)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return Object.freeze({
    version: 1 as const,
    providers: Object.freeze(providers),
    routes: Object.freeze(routes),
  });
}

function validateProviderEntry(
  input: unknown,
  index: number,
): ProviderDefinition {
  void index;
  if (!isPlainObject(input)) {
    fail("invalidPersistedProvider");
  }
  if (hasSecretLikeField(input)) {
    fail("forbiddenPersistedField");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_PROVIDER_FIELDS.has(key)) {
      fail("forbiddenPersistedField");
    }
  }
  assertJsonValue(input, "invalidPersistedProvider");

  try {
    const validated = validateProviderDefinition(input);
    assertSafeCredentialRef(validated.credentialRef);
    return validated;
  } catch (error) {
    return mapRegistryError(error);
  }
}

function validateRouteEntry(input: unknown, index: number): RouteDefinition {
  void index;
  if (!isPlainObject(input)) {
    fail("invalidPersistedRoute");
  }
  if (hasSecretLikeField(input)) {
    fail("forbiddenPersistedField");
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_ROUTE_FIELDS.has(key)) {
      fail("forbiddenPersistedField");
    }
  }
  assertJsonValue(input, "invalidPersistedRoute");

  try {
    return validateRouteDefinition(input);
  } catch (error) {
    return mapRegistryError(error);
  }
}

/**
 * Validates an untrusted snapshot and returns a new immutable copy.
 *
 * The caller's object is never mutated. Unknown fields, secrets, circular
 * structures, unsupported versions and inconsistent enabled/model/provider
 * relationships are all rejected.
 */
export function validateConfigSnapshot(input: unknown): PersistedConfigV1 {
  if (!isPlainObject(input)) {
    fail("invalidPersistedConfig");
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_ROOT_FIELDS.has(key)) {
      fail("forbiddenPersistedField");
    }
  }

  if (input.version !== 1) {
    fail("unsupportedConfigVersion");
  }

  if (!Array.isArray(input.providers)) {
    fail("invalidPersistedConfig");
  }
  if (!Array.isArray(input.routes)) {
    fail("invalidPersistedConfig");
  }

  const providers = input.providers.map((entry, index) =>
    validateProviderEntry(entry, index),
  );
  const routes = input.routes.map((entry, index) =>
    validateRouteEntry(entry, index),
  );

  const providerById = new Map<string, ProviderDefinition>();
  for (const provider of providers) {
    if (providerById.has(provider.id)) {
      fail("duplicatePersistedProvider");
    }
    providerById.set(provider.id, provider);
  }

  const routeById = new Set<string>();
  for (const route of routes) {
    if (routeById.has(route.id)) {
      fail("duplicatePersistedRoute");
    }
    routeById.add(route.id);

    const provider = providerById.get(route.providerId);
    if (provider === undefined) {
      fail("persistedProviderNotFound");
    }
    if (!provider.models.includes(route.model)) {
      fail("persistedModelNotAvailable");
    }
    if (!provider.enabled && route.enabled) {
      fail("invalidPersistedProvider");
    }

    for (const fallbackId of route.fallbackProviderIds ?? []) {
      const fallback = providerById.get(fallbackId);
      if (fallback === undefined) {
        fail("persistedProviderNotFound");
      }
      if (!fallback.models.includes(route.model)) {
        fail("persistedModelNotAvailable");
      }
    }
  }

  return Object.freeze({
    version: 1 as const,
    providers: Object.freeze(providers.map(cloneProviderDefinition)),
    routes: Object.freeze(routes.map(cloneRouteDefinition)),
  });
}

/**
 * Builds a fresh in-memory registry from a snapshot.
 *
 * Validation happens first; a failure never returns a partially filled
 * registry. The returned registry is fully isolated from the snapshot.
 */
export function createRegistryFromSnapshot(
  snapshot: unknown,
): InMemoryProviderRegistry {
  const validated = validateConfigSnapshot(snapshot);
  const registry = new InMemoryProviderRegistry();

  try {
    for (const provider of validated.providers) {
      registry.registerProvider(cloneProviderDefinition(provider));
    }
    for (const route of validated.routes) {
      registry.registerRoute(cloneRouteDefinition(route));
    }
  } catch (error) {
    return mapRegistryError(error);
  }

  return registry;
}

/**
 * Loads a registry through a JsonConfigStore.
 *
 * A missing file yields an empty registry. Corrupt or inconsistent files
 * raise a stable PersistenceError; nothing is partially restored.
 */
export async function loadProviderRegistry(store: {
  load(): Promise<PersistedConfigV1 | undefined>;
}): Promise<InMemoryProviderRegistry> {
  const snapshot = await store.load();
  if (snapshot === undefined) {
    return new InMemoryProviderRegistry();
  }
  return createRegistryFromSnapshot(snapshot);
}

/**
 * Saves the registry through a JsonConfigStore without mutating it.
 */
export async function saveProviderRegistry(
  store: { save(snapshot: unknown): Promise<void> },
  registry: ProviderRegistry,
): Promise<void> {
  const snapshot = createConfigSnapshot(registry);
  await store.save(snapshot);
}
