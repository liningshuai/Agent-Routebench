import { mountDesktopUi, type DesktopUi } from "./ui.js";
import type { DesktopApiClient } from "./types.js";
import type { DesktopConfigApiClient } from "./config-client.js";

/**
 * The host (Tauri or another local shell) injects its API bridge here before
 * loading this module. The renderer never constructs a network client itself.
 */
export const DESKTOP_API_CLIENT_GLOBAL =
  "__AGENT_WORKBENCH_DESKTOP_API_CLIENT__" as const;
export const DESKTOP_CONFIG_CLIENT_GLOBAL =
  "__AGENT_WORKBENCH_DESKTOP_CONFIG_CLIENT__" as const;

type DesktopGlobal = typeof globalThis & {
  [DESKTOP_API_CLIENT_GLOBAL]?: DesktopApiClient;
  [DESKTOP_CONFIG_CLIENT_GLOBAL]?: DesktopConfigApiClient;
};

function isDesktopApiClient(value: unknown): value is DesktopApiClient {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.load === "function" &&
    typeof candidate.createSession === "function" &&
    typeof candidate.submitTurn === "function" &&
    typeof candidate.cancelTurn === "function"
  );
}

function isDesktopConfigApiClient(value: unknown): value is DesktopConfigApiClient {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return [
    "getConfig",
    "createProvider",
    "updateProvider",
    "deleteProvider",
    "createRoute",
    "updateRoute",
    "deleteRoute",
  ].every((method) => typeof candidate[method] === "function");
}

export function bootstrapDesktopUi(
  container: HTMLElement,
  client: DesktopApiClient,
  configClient?: DesktopConfigApiClient,
): DesktopUi {
  return mountDesktopUi(container, client, configClient);
}

/**
 * Mounts the page when the host supplied an injected API bridge.
 * Returning null is intentional: a plain browser preview has no API client
 * and must not invent network access or credentials.
 */
export function bootstrapDesktopUiFromDocument(
  doc: Document,
): DesktopUi | null {
  const container = doc.getElementById("app");
  const client = (globalThis as DesktopGlobal)[DESKTOP_API_CLIENT_GLOBAL];
  const configClient = (globalThis as DesktopGlobal)[DESKTOP_CONFIG_CLIENT_GLOBAL];
  if (!container || !isDesktopApiClient(client)) {
    return null;
  }
  return bootstrapDesktopUi(
    container,
    client,
    isDesktopConfigApiClient(configClient) ? configClient : undefined,
  );
}

if (typeof document !== "undefined") {
  bootstrapDesktopUiFromDocument(document);
}
