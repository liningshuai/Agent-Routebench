import type {
  ProviderDefinition,
  RouteDefinition,
} from "@agent-workbench/provider-registry";
import type { PersistedConfigV1 } from "@agent-workbench/local-persistence";
import { createDesktopError } from "./errors.js";

/** Config-related Tauri commands. */
export const CONFIG_COMMANDS = Object.freeze({
  getConfig: "agent_get_config",
  createProvider: "agent_create_provider",
  updateProvider: "agent_update_provider",
  deleteProvider: "agent_delete_provider",
  createRoute: "agent_create_route",
  updateRoute: "agent_update_route",
  deleteRoute: "agent_delete_route",
} as const);

export type TauriInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type TauriListen = <T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void | Promise<void>>;

export interface DesktopConfigApiClient {
  getConfig(signal?: AbortSignal): Promise<PersistedConfigV1>;
  createProvider(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProviderDefinition>;
  updateProvider(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProviderDefinition>;
  deleteProvider(providerId: string, signal?: AbortSignal): Promise<void>;
  createRoute(input: unknown, signal?: AbortSignal): Promise<RouteDefinition>;
  updateRoute(input: unknown, signal?: AbortSignal): Promise<RouteDefinition>;
  deleteRoute(routeId: string, signal?: AbortSignal): Promise<void>;
}

export interface DesktopConfigClientOptions {
  readonly invoke: TauriInvoke;
  readonly listen: TauriListen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertConfigClientOptions(
  options: unknown,
): asserts options is DesktopConfigClientOptions {
  if (
    !isRecord(options) ||
    typeof options.invoke !== "function" ||
    typeof options.listen !== "function"
  ) {
    throw createDesktopError("CONNECTION_FAILED");
  }
}

const PROVIDER_FIELDS = new Set([
  "id",
  "name",
  "protocol",
  "baseUrl",
  "credentialRef",
  "models",
  "enabled",
]);
const ROUTE_FIELDS = new Set([
  "id",
  "name",
  "providerId",
  "model",
  "enabled",
  "fallbackProviderIds",
]);
const FORBIDDEN_FIELDS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "token",
  "authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "endpoint",
  "access_token",
  "refresh_token",
  "client_secret",
  "bearer",
  "oauth",
]);

function assertNoSensitiveFields(value: unknown, depth = 0): void {
  if (depth > 32) {
    throw new Error("invalid");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      throw new Error("invalid");
    }
    assertNoSensitiveFields(nested, depth + 1);
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("invalid");
  }
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("invalid");
  }
}

function validateProviderInput(value: unknown): ProviderDefinition {
  assertNoSensitiveFields(value);
  return parseProvider(value);
}

function validateRouteInput(value: unknown): RouteDefinition {
  assertNoSensitiveFields(value);
  return parseRoute(value);
}

function parseProvider(value: unknown): ProviderDefinition {
  if (!isRecord(value)) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  assertAllowedKeys(value, PROVIDER_FIELDS);
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.protocol !== "anthropic_messages" &&
      value.protocol !== "openai_compatible") ||
    typeof value.baseUrl !== "string" ||
    (value.credentialRef !== undefined &&
      value.credentialRef !== null &&
      typeof value.credentialRef !== "string") ||
    !Array.isArray(value.models) ||
    value.models.length === 0 ||
    !value.models.every((model) => typeof model === "string" && model.length > 0) ||
    typeof value.enabled !== "boolean"
  ) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  assertNonEmptyString(value.id);
  assertNonEmptyString(value.name);
  assertNonEmptyString(value.baseUrl);
  if (value.credentialRef !== undefined && value.credentialRef !== null) {
    assertNonEmptyString(value.credentialRef);
  }
  return {
    id: value.id,
    name: value.name,
    protocol: value.protocol,
    baseUrl: value.baseUrl,
    credentialRef: value.credentialRef === undefined ? null : value.credentialRef,
    models: [...value.models],
    enabled: value.enabled,
  } as ProviderDefinition;
}

function parseRoute(value: unknown): RouteDefinition {
  if (!isRecord(value)) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  assertAllowedKeys(value, ROUTE_FIELDS);
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.model !== "string" ||
    typeof value.enabled !== "boolean" ||
    (value.fallbackProviderIds !== undefined &&
      (!Array.isArray(value.fallbackProviderIds) ||
        !value.fallbackProviderIds.every(
          (id) => typeof id === "string" && id.length > 0,
        )))
  ) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  assertNonEmptyString(value.id);
  assertNonEmptyString(value.name);
  assertNonEmptyString(value.providerId);
  assertNonEmptyString(value.model);
  return {
    id: value.id,
    name: value.name,
    providerId: value.providerId,
    model: value.model,
    enabled: value.enabled,
    ...(value.fallbackProviderIds === undefined
      ? {}
      : { fallbackProviderIds: [...value.fallbackProviderIds] }),
  } as RouteDefinition;
}

function parseSnapshot(value: unknown): PersistedConfigV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  assertAllowedKeys(value, new Set(["version", "providers", "routes"]));
  if (!Array.isArray(value.providers) || !Array.isArray(value.routes)) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  return {
    version: 1,
    providers: value.providers.map(parseProvider),
    routes: value.routes.map(parseRoute),
  } as PersistedConfigV1;
}

class DesktopConfigClient implements DesktopConfigApiClient {
  readonly #invoke: TauriInvoke;

  constructor(options: DesktopConfigClientOptions) {
    assertConfigClientOptions(options);
    this.#invoke = options.invoke;
  }

  async getConfig(signal?: AbortSignal): Promise<PersistedConfigV1> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      return parseSnapshot(await this.#invoke(CONFIG_COMMANDS.getConfig));
    } catch {
      throw createDesktopError("CONFIG_LOAD_FAILED");
    }
  }

  async createProvider(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProviderDefinition> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const provider = validateProviderInput(input);
      const response = await this.#invoke(
        CONFIG_COMMANDS.createProvider,
        { provider },
      );
      if (!isRecord(response) || !("provider" in response)) {
        throw new Error("invalid");
      }
      return parseProvider(response.provider);
    } catch {
      throw createDesktopError("CONFIG_MUTATION_FAILED");
    }
  }

  async updateProvider(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProviderDefinition> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const provider = validateProviderInput(input);
      const response = await this.#invoke(
        CONFIG_COMMANDS.updateProvider,
        { provider },
      );
      if (!isRecord(response) || !("provider" in response)) {
        throw new Error("invalid");
      }
      return parseProvider(response.provider);
    } catch {
      throw createDesktopError("CONFIG_MUTATION_FAILED");
    }
  }

  async deleteProvider(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      assertNonEmptyString(providerId);
      await this.#invoke(CONFIG_COMMANDS.deleteProvider, { providerId });
    } catch {
      throw createDesktopError("CONFIG_MUTATION_FAILED");
    }
  }

  async createRoute(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<RouteDefinition> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const route = validateRouteInput(input);
      const response = await this.#invoke(
        CONFIG_COMMANDS.createRoute,
        { route },
      );
      if (!isRecord(response) || !("route" in response)) {
        throw new Error("invalid");
      }
      return parseRoute(response.route);
    } catch {
      throw createDesktopError("CONFIG_MUTATION_FAILED");
    }
  }

  async updateRoute(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<RouteDefinition> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const route = validateRouteInput(input);
      const response = await this.#invoke(
        CONFIG_COMMANDS.updateRoute,
        { route },
      );
      if (!isRecord(response) || !("route" in response)) {
        throw new Error("invalid");
      }
      return parseRoute(response.route);
    } catch {
      throw createDesktopError("CONFIG_MUTATION_FAILED");
    }
  }

  async deleteRoute(
    routeId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      assertNonEmptyString(routeId);
      await this.#invoke(CONFIG_COMMANDS.deleteRoute, { routeId });
    } catch {
      throw createDesktopError("CONFIG_MUTATION_FAILED");
    }
  }
}

export function createDesktopConfigClient(
  options: DesktopConfigClientOptions,
): DesktopConfigApiClient {
  return new DesktopConfigClient(options);
}
