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

function parseProvider(value: unknown): ProviderDefinition {
  if (!isRecord(value)) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  const allowed = new Set([
    "id",
    "name",
    "protocol",
    "baseUrl",
    "credentialRef",
    "models",
    "enabled",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw createDesktopError("CONNECTION_FAILED");
    }
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.protocol !== "anthropic_messages" &&
      value.protocol !== "openai_compatible") ||
    typeof value.baseUrl !== "string" ||
    (value.credentialRef !== null && typeof value.credentialRef !== "string") ||
    !Array.isArray(value.models) ||
    typeof value.enabled !== "boolean"
  ) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  return value as unknown as ProviderDefinition;
}

function parseRoute(value: unknown): RouteDefinition {
  if (!isRecord(value)) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  const allowed = new Set([
    "id",
    "name",
    "providerId",
    "model",
    "enabled",
    "fallbackProviderIds",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw createDesktopError("CONNECTION_FAILED");
    }
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.model !== "string" ||
    typeof value.enabled !== "boolean"
  ) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  return value as unknown as RouteDefinition;
}

function parseSnapshot(value: unknown): PersistedConfigV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  if (!Array.isArray(value.providers) || !Array.isArray(value.routes)) {
    throw createDesktopError("CONNECTION_FAILED");
  }
  return value as unknown as PersistedConfigV1;
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
      throw createDesktopError("CONNECTION_FAILED");
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
      const response = await this.#invoke(
        CONFIG_COMMANDS.createProvider,
        { provider: input },
      );
      if (!isRecord(response) || !("provider" in response)) {
        throw new Error("invalid");
      }
      return parseProvider(response.provider);
    } catch {
      throw createDesktopError("SESSION_CREATE_FAILED");
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
      const response = await this.#invoke(
        CONFIG_COMMANDS.updateProvider,
        { provider: input },
      );
      if (!isRecord(response) || !("provider" in response)) {
        throw new Error("invalid");
      }
      return parseProvider(response.provider);
    } catch {
      throw createDesktopError("SESSION_CREATE_FAILED");
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
      await this.#invoke(CONFIG_COMMANDS.deleteProvider, { providerId });
    } catch {
      throw createDesktopError("CANCEL_FAILED");
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
      const response = await this.#invoke(
        CONFIG_COMMANDS.createRoute,
        { route: input },
      );
      if (!isRecord(response) || !("route" in response)) {
        throw new Error("invalid");
      }
      return parseRoute(response.route);
    } catch {
      throw createDesktopError("SESSION_CREATE_FAILED");
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
      const response = await this.#invoke(
        CONFIG_COMMANDS.updateRoute,
        { route: input },
      );
      if (!isRecord(response) || !("route" in response)) {
        throw new Error("invalid");
      }
      return parseRoute(response.route);
    } catch {
      throw createDesktopError("SESSION_CREATE_FAILED");
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
      await this.#invoke(CONFIG_COMMANDS.deleteRoute, { routeId });
    } catch {
      throw createDesktopError("CANCEL_FAILED");
    }
  }
}

export function createDesktopConfigClient(
  options: DesktopConfigClientOptions,
): DesktopConfigApiClient {
  return new DesktopConfigClient(options);
}
