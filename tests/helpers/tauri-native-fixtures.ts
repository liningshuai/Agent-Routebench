import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TAURI_COMMANDS, TAURI_EVENTS } from "../../apps/desktop/src/tauri-api-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Repository root (the directory containing package.json). */
export const REPO_ROOT = resolve(dirname(__dirname), "..");

export const DESKTOP_ROOT = join(REPO_ROOT, "apps/desktop");
export const TAURI_ROOT = join(DESKTOP_ROOT, "src-tauri");

export function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

export function repoFileExists(relativePath: string): boolean {
  return existsSync(join(REPO_ROOT, relativePath));
}

export function readRepoJson<T = unknown>(relativePath: string): T {
  return JSON.parse(readRepoFile(relativePath)) as T;
}

export const TAURI_CONFIG_PATH = "apps/desktop/src-tauri/tauri.conf.json";
export const CAPABILITIES_PATH = "apps/desktop/src-tauri/capabilities/default.json";
export const TAURI_ENTRY_PATH = "apps/desktop/src/tauri-entry.ts";
export const TAURI_API_CLIENT_PATH = "apps/desktop/src/tauri-api-client.ts";
export const CARGO_MANIFEST_PATH = "apps/desktop/src-tauri/Cargo.toml";
export const BROWSER_PREVIEW_PATH = "docs/previews/desktop-ui-preview.html";
export const PUBLIC_INDEX_PATH = "apps/desktop/public/index.html";

/** The only loopback IPC origin Tauri itself needs; not a remote provider. */
export const TAURI_LOOPBACK_ORIGINS = new Set(["http://ipc.localhost"]);

/** CSP directives that must be present and locked to 'self'. */
export const REQUIRED_CSP_DIRECTIVES = ["default-src", "script-src", "style-src"] as const;

/** Core permission namespaces considered safe for the main window. */
export const ALLOWED_CAPABILITY_PERMISSIONS = new Set([
  "core:default",
  "core:app:default",
  "core:event:default",
  "core:window:default",
  "core:webview:default",
]);

/** Substrings that must never appear in a capability permission name. */
export const DANGEROUS_PERMISSION_MARKERS = [
  "shell",
  "fs",
  "http",
  "process",
  "sql",
  "dialog",
  "clipboard",
  "notification",
  "opener",
  "global-shortcut",
  "localhost",
  "remote",
] as const;

/** Plugin crates that must never appear in the Rust host manifest. */
export const FORBIDDEN_CARGO_DEPENDENCIES = [
  "tauri-plugin-shell",
  "tauri-plugin-fs",
  "tauri-plugin-http",
  "tauri-plugin-process",
  "tauri-plugin-sql",
  "tauri-plugin-dialog",
  "tauri-plugin-clipboard-manager",
  "tauri-plugin-notification",
  "tauri-plugin-opener",
  "tauri-plugin-global-shortcut",
  "tauri-plugin-updater",
  "tauri-plugin-tray",
  "reqwest",
  "ureq",
  "hyper",
  "tokio",
] as const;

/** Cargo dependencies the Task 18 MVP host is allowed to declare. */
export const ALLOWED_CARGO_DEPENDENCIES = new Set([
  "tauri",
  "tauri-build",
  "serde",
  "serde_json",
]);

export const HOST_ERROR_CODES = [
  "host_not_ready",
  "invalid_request",
  "invalid_session_id",
  "invalid_turn_id",
  "forbidden_field",
] as const;

export const HOST_NOT_READY_CODE = "host_not_ready";
export const HOST_NOT_READY_MESSAGE = "Agent host backend is not ready.";

export const FORBIDDEN_TURN_FIELDS = [
  "apiKey",
  "api_key",
  "token",
  "authorization",
  "Authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "baseUrl",
  "endpoint",
] as const;

/** Parse `#[tauri::command]` annotated function names out of a Rust source string. */
export function extractTauriCommandNames(rustSource: string): string[] {
  const names: string[] = [];
  const pattern = /#\s*\[\s*tauri\s*::\s*command\s*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g;
  for (const match of rustSource.matchAll(pattern)) {
    names.push(match[1] ?? "");
  }
  return names;
}

/** Extract every `pub fn` / `pub async fn` name from a Rust source string. */
export function extractPublicFnNames(rustSource: string): string[] {
  const names: string[] = [];
  const pattern = /pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/g;
  for (const match of rustSource.matchAll(pattern)) {
    names.push(match[1] ?? "");
  }
  return names;
}

/** Read the fixed TS command contract for cross-language comparison. */
export function tsCommandNames(): string[] {
  return Object.values(TAURI_COMMANDS);
}

export function tsEventNames(): string[] {
  return Object.values(TAURI_EVENTS);
}

/** Extract the quoted module specifiers of ESM imports in a JS/TS string. */
export function extractStaticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value) specifiers.push(value);
    }
  }
  return specifiers;
}

export interface WindowConfig {
  readonly label?: string;
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly resizable?: boolean;
  readonly [key: string]: unknown;
}

export interface TauriConfigShape {
  readonly productName?: string;
  readonly version?: string;
  readonly identifier?: string;
  readonly build?: {
    readonly frontendDist?: string;
    readonly devUrl?: string;
    readonly [key: string]: unknown;
  };
  readonly app?: {
    readonly security?: { readonly csp?: string; readonly [key: string]: unknown };
    readonly windows?: readonly WindowConfig[];
    readonly [key: string]: unknown;
  };
  readonly bundle?: {
    readonly active?: boolean;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface CapabilityShape {
  readonly identifier?: string;
  readonly description?: string;
  readonly windows?: readonly string[];
  readonly permissions?: readonly string[];
  readonly [key: string]: unknown;
}

export function loadTauriConfig(): TauriConfigShape {
  return readRepoJson<TauriConfigShape>(TAURI_CONFIG_PATH);
}

export function loadCapabilities(): CapabilityShape {
  return readRepoJson<CapabilityShape>(CAPABILITIES_PATH);
}
