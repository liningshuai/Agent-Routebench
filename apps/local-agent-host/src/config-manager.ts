import {
  InMemoryProviderRegistry,
  type ProviderDefinition,
  type ProviderRegistry,
  type RouteDefinition,
} from "@agent-workbench/provider-registry";
import {
  createConfigSnapshot,
  createRegistryFromSnapshot,
  saveProviderRegistry,
  type PersistedConfigV1,
} from "@agent-workbench/local-persistence";

/** Fixed error for config operations. */
export class ConfigManagerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigManagerError";
    this.code = code;
  }
}

export interface ConfigManagerOptions {
  readonly registry: ProviderRegistry;
  readonly jsonStore: {
    load(): Promise<PersistedConfigV1 | undefined>;
    save(snapshot: unknown): Promise<void>;
  };
}

export interface ConfigManager {
  getSnapshot(): PersistedConfigV1;
  createProvider(input: unknown): Promise<ProviderDefinition>;
  updateProvider(input: unknown): Promise<ProviderDefinition>;
  deleteProvider(providerId: string): Promise<void>;
  createRoute(input: unknown): Promise<RouteDefinition>;
  updateRoute(input: unknown): Promise<RouteDefinition>;
  deleteRoute(routeId: string): Promise<void>;
}

/**
 * Config manager wrapping a ProviderRegistry with atomic persistence.
 * Every mutation: validate → apply → snapshot → persist → rollback on failure.
 */
class ConfigManagerImpl implements ConfigManager {
  readonly #registry: ProviderRegistry;
  readonly #jsonStore: ConfigManagerOptions["jsonStore"];
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ConfigManagerOptions) {
    this.#registry = options.registry;
    this.#jsonStore = options.jsonStore;
  }

  getSnapshot(): PersistedConfigV1 {
    return createConfigSnapshot(this.#registry);
  }

  async createProvider(input: unknown): Promise<ProviderDefinition> {
    return this.#withLock(async () => {
      const snapshot = createConfigSnapshot(this.#registry);
      try {
        this.#registry.registerProvider(
          input as ProviderDefinition,
        );
      } catch (error) {
        // Restore from snapshot on failure.
        this.#restore(snapshot);
        throw error instanceof ConfigManagerError
          ? error
          : new ConfigManagerError(
              "invalid_config_request",
              error instanceof Error ? error.message : "Config operation failed.",
            );
      }
      try {
        await saveProviderRegistry(this.#jsonStore, this.#registry);
      } catch {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "config_persistence_failed",
          "Config persistence failed.",
        );
      }
      return this.#registry.getProvider(
        (input as { id: string }).id,
      ) as ProviderDefinition;
    });
  }

  async updateProvider(input: unknown): Promise<ProviderDefinition> {
    return this.#withLock(async () => {
      const snapshot = createConfigSnapshot(this.#registry);
      try {
        this.#registry.updateProvider(input as ProviderDefinition);
      } catch (error) {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "invalid_config_request",
          error instanceof Error ? error.message : "Config operation failed.",
        );
      }
      try {
        await saveProviderRegistry(this.#jsonStore, this.#registry);
      } catch {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "config_persistence_failed",
          "Config persistence failed.",
        );
      }
      return this.#registry.getProvider(
        (input as { id: string }).id,
      ) as ProviderDefinition;
    });
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.#withLock(async () => {
      const snapshot = createConfigSnapshot(this.#registry);
      try {
        this.#registry.removeProvider(providerId);
      } catch (error) {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "invalid_config_request",
          error instanceof Error ? error.message : "Config operation failed.",
        );
      }
      try {
        await saveProviderRegistry(this.#jsonStore, this.#registry);
      } catch {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "config_persistence_failed",
          "Config persistence failed.",
        );
      }
    });
  }

  async createRoute(input: unknown): Promise<RouteDefinition> {
    return this.#withLock(async () => {
      const snapshot = createConfigSnapshot(this.#registry);
      try {
        this.#registry.registerRoute(input as RouteDefinition);
      } catch (error) {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "invalid_config_request",
          error instanceof Error ? error.message : "Config operation failed.",
        );
      }
      try {
        await saveProviderRegistry(this.#jsonStore, this.#registry);
      } catch {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "config_persistence_failed",
          "Config persistence failed.",
        );
      }
      return this.#registry.getRoute(
        (input as { id: string }).id,
      ) as RouteDefinition;
    });
  }

  async updateRoute(input: unknown): Promise<RouteDefinition> {
    return this.#withLock(async () => {
      const snapshot = createConfigSnapshot(this.#registry);
      try {
        this.#registry.updateRoute(input as RouteDefinition);
      } catch (error) {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "invalid_config_request",
          error instanceof Error ? error.message : "Config operation failed.",
        );
      }
      try {
        await saveProviderRegistry(this.#jsonStore, this.#registry);
      } catch {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "config_persistence_failed",
          "Config persistence failed.",
        );
      }
      return this.#registry.getRoute(
        (input as { id: string }).id,
      ) as RouteDefinition;
    });
  }

  async deleteRoute(routeId: string): Promise<void> {
    await this.#withLock(async () => {
      const snapshot = createConfigSnapshot(this.#registry);
      try {
        this.#registry.removeRoute(routeId);
      } catch (error) {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "invalid_config_request",
          error instanceof Error ? error.message : "Config operation failed.",
        );
      }
      try {
        await saveProviderRegistry(this.#jsonStore, this.#registry);
      } catch {
        this.#restore(snapshot);
        throw new ConfigManagerError(
          "config_persistence_failed",
          "Config persistence failed.",
        );
      }
    });
  }

  #restore(snapshot: PersistedConfigV1): void {
    const restored = createRegistryFromSnapshot(snapshot);
    // Copy restored state back into the shared registry instance.
    // We replace the internal maps by re-registering everything.
    // Since ProviderRegistry is an interface, we clear by removing all
    // and re-adding. For InMemoryProviderRegistry this works.
    const reg = this.#registry as InMemoryProviderRegistry;
    for (const route of reg.listRoutes()) {
      reg.removeRoute(route.id);
    }
    for (const provider of reg.listProviders()) {
      reg.removeProvider(provider.id);
    }
    for (const provider of restored.listProviders()) {
      reg.registerProvider(provider);
    }
    for (const route of restored.listRoutes()) {
      reg.registerRoute(route);
    }
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function createConfigManager(
  options: ConfigManagerOptions,
): ConfigManager {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new ConfigManagerError(
      "invalid_config_request",
      "Config manager options are invalid.",
    );
  }
  if (
    typeof options.registry !== "object" ||
    options.registry === null
  ) {
    throw new ConfigManagerError(
      "invalid_config_request",
      "Config manager options are invalid.",
    );
  }
  if (
    typeof options.jsonStore !== "object" ||
    options.jsonStore === null ||
    typeof options.jsonStore.save !== "function"
  ) {
    throw new ConfigManagerError(
      "invalid_config_request",
      "Config manager options are invalid.",
    );
  }
  return new ConfigManagerImpl(options);
}
