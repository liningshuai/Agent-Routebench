import { fail, providerRegistryError } from "./errors.js";

export type ProviderProtocol = "anthropic_messages" | "openai_compatible";

/**
 * Non-sensitive provider configuration.
 *
 * A provider definition never carries a secret. `credentialRef` is a pointer
 * into the credential store; the secret itself lives only there.
 */
export interface ProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly credentialRef: string | null;
  readonly models: readonly string[];
  readonly enabled: boolean;
}

/** A route only references a provider id and one of its model names. */
export interface RouteDefinition {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly model: string;
  readonly enabled: boolean;
}

/** Resolved route handed to a future gateway adapter. Still secret free. */
export interface ResolvedRoute {
  readonly routeId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly credentialRef: string | null;
}

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const CREDENTIAL_REF_PATTERN = /^credential:[a-z][a-z0-9._-]{0,63}$/;

const PROVIDER_PROTOCOLS: ReadonlySet<string> = new Set<ProviderProtocol>([
  "anthropic_messages",
  "openai_compatible",
]);

/**
 * Field names that must never appear on a user supplied provider definition.
 * Checked against the raw input object, so `as unknown` casts cannot bypass it.
 */
const FORBIDDEN_PROVIDER_FIELDS: ReadonlySet<string> = new Set([
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
]);

/** Route definitions additionally may not carry transport level settings. */
const FORBIDDEN_ROUTE_FIELDS: ReadonlySet<string> = new Set([
  "apikey",
  "api_key",
  "api-key",
  "token",
  "authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "baseurl",
  "base_url",
  "endpoint",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "client_secret",
  "clientsecret",
  "bearer",
  "oauth",
]);

/** Model names that look like credentials or transport endpoints. */
const SECRET_LIKE_MODEL_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{8,}$/i,
  /^gh[pousr]_[A-Za-z0-9]+$/i,
  /^xox[baprs]-/i,
  /^bearer\s+\S+$/i,
  /^(api[_-]?key|authorization|token|secret|password)$/i,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasForbiddenField(
  record: Record<string, unknown>,
  forbidden: ReadonlySet<string>,
): boolean {
  return Object.keys(record).some((key) => forbidden.has(key.toLowerCase()));
}

function assertId(value: unknown, kind: "provider" | "route"): asserts value is string {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    fail(kind === "provider" ? "invalidProviderId" : "invalidRouteId");
  }
}

function assertDisplayName(
  value: unknown,
  kind: "provider" | "route",
): asserts value is string {
  const invalid =
    typeof value !== "string" || value.length === 0 || value.trim() !== value;
  if (invalid) {
    fail(kind === "provider" ? "invalidProviderName" : "invalidRouteName");
  }
}

function assertModelName(
  value: unknown,
  key: "invalidProviderModels" | "invalidRouteModel",
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    fail(key);
  }
  if (value.includes("://") || SECRET_LIKE_MODEL_PATTERNS.some((re) => re.test(value))) {
    fail(key);
  }
}

/** Validates a credential reference. */
export function assertCredentialRef(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CREDENTIAL_REF_PATTERN.test(value)) {
    fail("invalidCredentialRef");
  }
}

export function isValidCredentialRef(value: unknown): boolean {
  return typeof value === "string" && CREDENTIAL_REF_PATTERN.test(value);
}

function parseBaseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw providerRegistryError("invalidProviderUrl");
  }
}

function assertBaseUrl(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    fail("invalidProviderUrl");
  }
  if (value.includes("?") || value.includes("#")) {
    fail("invalidProviderUrl");
  }

  const parsed = parseBaseUrl(value);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("invalidProviderUrl");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    fail("invalidProviderUrl");
  }
}

function assertProtocol(value: unknown): asserts value is ProviderProtocol {
  if (typeof value !== "string" || !PROVIDER_PROTOCOLS.has(value)) {
    fail("invalidProviderProtocol");
  }
}

function assertEnabled(
  value: unknown,
  key: "invalidProviderEnabled" | "invalidRouteEnabled",
): asserts value is boolean {
  if (typeof value !== "boolean") {
    fail(key);
  }
}

/**
 * Fully validates a provider definition and returns a normalized copy.
 * The returned value encodes no secret: only `credentialRef` is carried.
 */
export function validateProviderDefinition(input: unknown): ProviderDefinition {
  if (!isPlainObject(input)) {
    fail("invalidProviderId");
  }
  if (hasForbiddenField(input, FORBIDDEN_PROVIDER_FIELDS)) {
    fail("forbiddenProviderField");
  }

  const id = input.id;
  const name = input.name;
  const protocol = input.protocol;
  const baseUrl = input.baseUrl;
  const enabled = input.enabled;

  assertId(id, "provider");
  assertDisplayName(name, "provider");
  assertProtocol(protocol);
  assertBaseUrl(baseUrl);

  const rawCredentialRef = input.credentialRef ?? null;
  let credentialRef: string | null = null;
  if (rawCredentialRef !== null) {
    assertCredentialRef(rawCredentialRef);
    credentialRef = rawCredentialRef;
  }

  const models = input.models;
  if (!Array.isArray(models) || models.length === 0) {
    fail("invalidProviderModels");
  }
  const seen = new Set<string>();
  for (const model of models) {
    assertModelName(model, "invalidProviderModels");
    if (seen.has(model)) {
      fail("invalidProviderModels");
    }
    seen.add(model);
  }

  assertEnabled(enabled, "invalidProviderEnabled");

  return {
    id,
    name,
    protocol,
    baseUrl,
    credentialRef,
    models: [...models],
    enabled,
  };
}

/** Fully validates a route definition and returns a normalized copy. */
export function validateRouteDefinition(input: unknown): RouteDefinition {
  if (!isPlainObject(input)) {
    fail("invalidRouteId");
  }
  if (hasForbiddenField(input, FORBIDDEN_ROUTE_FIELDS)) {
    fail("forbiddenRouteField");
  }

  const id = input.id;
  const name = input.name;
  const providerId = input.providerId;
  const model = input.model;
  const enabled = input.enabled;

  assertId(id, "route");
  assertDisplayName(name, "route");

  if (typeof providerId !== "string" || providerId.length === 0) {
    fail("providerNotFound");
  }

  assertModelName(model, "invalidRouteModel");
  assertEnabled(enabled, "invalidRouteEnabled");

  return {
    id,
    name,
    providerId,
    model,
    enabled,
  };
}

export function cloneProviderDefinition(
  provider: ProviderDefinition,
): ProviderDefinition {
  return {
    id: provider.id,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    credentialRef: provider.credentialRef,
    models: [...provider.models],
    enabled: provider.enabled,
  };
}

export function cloneRouteDefinition(route: RouteDefinition): RouteDefinition {
  return {
    id: route.id,
    name: route.name,
    providerId: route.providerId,
    model: route.model,
    enabled: route.enabled,
  };
}
