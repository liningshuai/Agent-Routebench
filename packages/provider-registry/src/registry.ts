import { providerRegistryError } from "./errors.js";
import {
  cloneProviderDefinition,
  cloneRouteDefinition,
  validateProviderDefinition,
  validateRouteDefinition,
  type ProviderDefinition,
  type ResolvedRoute,
  type RouteDefinition,
} from "./types.js";

export interface ProviderRegistry {
  registerProvider(provider: ProviderDefinition): void;
  updateProvider(provider: ProviderDefinition): void;
  removeProvider(providerId: string): void;
  getProvider(providerId: string): ProviderDefinition | undefined;
  listProviders(): readonly ProviderDefinition[];

  registerRoute(route: RouteDefinition): void;
  updateRoute(route: RouteDefinition): void;
  removeRoute(routeId: string): void;
  getRoute(routeId: string): RouteDefinition | undefined;
  listRoutes(): readonly RouteDefinition[];

  resolveRoute(routeId: string): ResolvedRoute;
}

/**
 * In-memory, offline provider/route registry.
 *
 * The registry is a pure data boundary:
 * - it never reads, stores, prints or persists a secret value,
 * - it never performs network I/O,
 * - it never resolves a disabled route or a disabled provider,
 * - and it never falls back to another provider.
 *
 * Only `credentialRef` values travel through it.
 */
export class InMemoryProviderRegistry implements ProviderRegistry {
  readonly #providers = new Map<string, ProviderDefinition>();
  readonly #routes = new Map<string, RouteDefinition>();

  registerProvider(provider: ProviderDefinition): void {
    const validated = validateProviderDefinition(provider);
    if (this.#providers.has(validated.id)) {
      throw providerRegistryError("duplicateProviderId");
    }
    this.#providers.set(validated.id, cloneProviderDefinition(validated));
  }

  updateProvider(provider: ProviderDefinition): void {
    const validated = validateProviderDefinition(provider);
    if (!this.#providers.has(validated.id)) {
      throw providerRegistryError("providerNotFound");
    }

    for (const route of this.#routes.values()) {
      if (route.providerId !== validated.id) {
        continue;
      }
      if (!validated.models.includes(route.model)) {
        throw providerRegistryError("modelNotAvailable");
      }
    }

    this.#providers.set(validated.id, cloneProviderDefinition(validated));
  }

  removeProvider(providerId: string): void {
    if (!this.#providers.has(providerId)) {
      throw providerRegistryError("providerNotFound");
    }
    for (const route of this.#routes.values()) {
      if (route.providerId === providerId) {
        throw providerRegistryError("providerHasRoutes");
      }
    }
    this.#providers.delete(providerId);
  }

  getProvider(providerId: string): ProviderDefinition | undefined {
    const stored = this.#providers.get(providerId);
    return stored === undefined ? undefined : cloneProviderDefinition(stored);
  }

  listProviders(): readonly ProviderDefinition[] {
    return [...this.#providers.values()].map(cloneProviderDefinition);
  }

  registerRoute(route: RouteDefinition): void {
    const validated = validateRouteDefinition(route);
    if (this.#routes.has(validated.id)) {
      throw providerRegistryError("duplicateRouteId");
    }

    const provider = this.#providers.get(validated.providerId);
    if (provider === undefined) {
      throw providerRegistryError("providerNotFound");
    }
    if (!provider.models.includes(validated.model)) {
      throw providerRegistryError("modelNotAvailable");
    }
    if (!provider.enabled && validated.enabled) {
      throw providerRegistryError("providerDisabled");
    }

    this.#routes.set(validated.id, cloneRouteDefinition(validated));
  }

  updateRoute(route: RouteDefinition): void {
    const validated = validateRouteDefinition(route);
    if (!this.#routes.has(validated.id)) {
      throw providerRegistryError("routeNotFound");
    }

    const provider = this.#providers.get(validated.providerId);
    if (provider === undefined) {
      throw providerRegistryError("providerNotFound");
    }
    if (!provider.models.includes(validated.model)) {
      throw providerRegistryError("modelNotAvailable");
    }
    if (!provider.enabled && validated.enabled) {
      throw providerRegistryError("providerDisabled");
    }

    this.#routes.set(validated.id, cloneRouteDefinition(validated));
  }

  removeRoute(routeId: string): void {
    if (!this.#routes.has(routeId)) {
      throw providerRegistryError("routeNotFound");
    }
    this.#routes.delete(routeId);
  }

  getRoute(routeId: string): RouteDefinition | undefined {
    const stored = this.#routes.get(routeId);
    return stored === undefined ? undefined : cloneRouteDefinition(stored);
  }

  listRoutes(): readonly RouteDefinition[] {
    return [...this.#routes.values()].map(cloneRouteDefinition);
  }

  resolveRoute(routeId: string): ResolvedRoute {
    const route = this.#routes.get(routeId);
    if (route === undefined) {
      throw providerRegistryError("routeNotFound");
    }
    if (!route.enabled) {
      throw providerRegistryError("routeDisabled");
    }

    const provider = this.#providers.get(route.providerId);
    if (provider === undefined) {
      throw providerRegistryError("providerNotFound");
    }
    if (!provider.enabled) {
      throw providerRegistryError("providerDisabled");
    }
    if (!provider.models.includes(route.model)) {
      throw providerRegistryError("invalidRegistrySnapshot");
    }

    // Deliberately secret free: only the credential reference is forwarded.
    return {
      routeId: route.id,
      providerId: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      model: route.model,
      credentialRef: provider.credentialRef,
    };
  }
}
