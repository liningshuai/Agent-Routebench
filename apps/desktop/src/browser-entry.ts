import { mountDesktopUi, type DesktopUi } from "./ui.js";
import type { DesktopApiClient } from "./types.js";

/**
 * The host (Tauri or another local shell) injects its API bridge here before
 * loading this module. The renderer never constructs a network client itself.
 */
export const DESKTOP_API_CLIENT_GLOBAL =
  "__AGENT_WORKBENCH_DESKTOP_API_CLIENT__" as const;

type DesktopGlobal = typeof globalThis & {
  [DESKTOP_API_CLIENT_GLOBAL]?: DesktopApiClient;
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

export function bootstrapDesktopUi(
  container: HTMLElement,
  client: DesktopApiClient,
): DesktopUi {
  return mountDesktopUi(container, client);
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
  if (!container || !isDesktopApiClient(client)) {
    return null;
  }
  return bootstrapDesktopUi(container, client);
}

if (typeof document !== "undefined") {
  bootstrapDesktopUiFromDocument(document);
}
