import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createTauriDesktopApiClient } from "./tauri-api-client.js";
import { mountDesktopUi } from "./ui.js";

/**
 * Tauri native entry point.
 *
 * The official @tauri-apps/api bridge functions are the only host boundary:
 * they are handed to the Task 17 `createTauriDesktopApiClient` factory, which
 * enforces validation, filtering and fixed error messages. This module never
 * talks to a provider, never reads the environment and never builds a second
 * IPC path.
 */
export function bootstrapTauriDesktopUi(doc: Document): void {
  const container = doc.getElementById("app");
  if (!container) {
    return;
  }
  const client = createTauriDesktopApiClient({ invoke, listen });
  mountDesktopUi(container, client);
}

if (typeof document !== "undefined") {
  bootstrapTauriDesktopUi(document);
}
