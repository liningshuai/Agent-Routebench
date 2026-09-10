import type {
  ProviderDefinition,
  RouteDefinition,
} from "@agent-workbench/provider-registry";

/**
 * Versioned, secret-free snapshot of the provider/route configuration.
 *
 * Only non-sensitive fields are ever persisted. A credential appears here as
 * a `credential:<id>` reference; the secret itself never enters this shape.
 */
export interface PersistedConfigV1 {
  readonly version: 1;
  readonly providers: readonly ProviderDefinition[];
  readonly routes: readonly RouteDefinition[];
}
