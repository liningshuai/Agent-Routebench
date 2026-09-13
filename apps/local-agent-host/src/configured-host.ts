import { isAbsolute } from "node:path";
import {
  createFileJsonConfigStore,
  ensureParentDirectory,
  loadProviderRegistry,
} from "@agent-workbench/local-persistence";
import { createAgentBackendRunner } from "@agent-workbench/agent-backend";
import type { AgentBackendOptions } from "@agent-workbench/agent-backend";
import type { ToolApprovalHandler, ToolExecutor, ToolPolicy } from "@agent-workbench/agent-runtime";
import type { HttpClient, RetryPolicy, RetryWait } from "@agent-workbench/model-gateway";
import type { CredentialStore } from "@agent-workbench/provider-registry";

import { ConfigBootstrapError } from "./errors.js";
import { createConfigManager } from "./config-manager.js";
import { createLocalAgentHost } from "./host.js";
import type { LocalAgentHost } from "./types.js";

/** Options for the configured Local Agent host bootstrap. */
export interface ConfiguredLocalAgentHostOptions {
  readonly host?: "127.0.0.1" | "localhost";
  readonly port: number;
  readonly configFilePath: string;
  readonly credentials?: CredentialStore;
  readonly httpClient?: HttpClient;
  /** Creates an empty version-1 snapshot when the path does not exist. */
  readonly createIfMissing?: boolean;

  // ── Optional Agent Backend passthrough ────────────────────────────────
  // These are forwarded verbatim to the existing Agent Backend assembly so
  // the configured host can run the same governed tool / retry chain the
  // backend already documents. Nothing is created implicitly: omitting them
  // keeps the backend's own fail-closed defaults (no policy ⇒ deny).
  readonly toolExecutor?: ToolExecutor;
  readonly policy?: ToolPolicy;
  readonly approvalHandler?: ToolApprovalHandler;
  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly wait?: RetryWait;
  readonly maxTurns?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly maxToolResultBytes?: number;
  readonly defaultMaxTokens?: number;
  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}

/** Backend options the configured host forwards, in a fixed order. */
const BACKEND_OPTION_KEYS = [
  "httpClient",
  "retryPolicy",
  "wait",
  "toolExecutor",
  "policy",
  "approvalHandler",
  "maxTurns",
  "maxToolCallsPerTurn",
  "maxToolResultBytes",
  "defaultMaxTokens",
  "maxFrameBytes",
  "maxToolInputBytes",
] as const;


/**
 * Validates that the config file path is a safe absolute path.
 * Rejects empty strings, relative paths, null bytes, query fragments and
 * hash fragments. Messages are fixed and never echo the rejected value.
 */
function assertConfigPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigBootstrapError("invalid_config_path");
  }
  if (value.includes("\0") || value.includes("?") || value.includes("#")) {
    throw new ConfigBootstrapError("invalid_config_path");
  }
  if (!isAbsolute(value)) {
    throw new ConfigBootstrapError("invalid_config_path");
  }
}

/**
 * Validates the injected CredentialStore. Accepts object literals,
 * null-prototype objects and class instances; rejects null, arrays,
 * primitives and objects without a callable `get` method.
 */
function assertCredentialStore(value: unknown): asserts value is CredentialStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigBootstrapError("invalid_credentials");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.get !== "function") {
    throw new ConfigBootstrapError("invalid_credentials");
  }
}

/**
 * Fail-closed default CredentialStore. Always returns undefined; never
 * throws. This is NOT an OS Keychain implementation — it simply ensures
 * that without an explicit credential source, no secret is ever available.
 */
class UnavailableCredentialStore implements CredentialStore {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async set(): Promise<void> {
    // No-op: this store cannot hold secrets.
  }
  async has(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<void> {
    // No-op: this store cannot hold secrets.
  }
}

/**
 * Creates a loopback Local Agent host from a validated non-sensitive config
 * file. The config is loaded and the ProviderRegistry restored *before* any
 * HTTP listener exists. If the config is missing or invalid, the host is
 * never created and no port is bound.
 *
 * CredentialStore is injected explicitly; the default is fail-closed.
 * No secret is read from the config file, environment or CLI arguments.
 */
export async function createConfiguredLocalAgentHost(
  options: ConfiguredLocalAgentHostOptions,
): Promise<LocalAgentHost> {
  // Validate options before touching the filesystem.
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ConfigBootstrapError("invalid_config_path");
  }
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new ConfigBootstrapError("invalid_config_path");
  }
  if (
    typeof options.port !== "number" ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new ConfigBootstrapError("invalid_config_path");
  }
  assertConfigPath(options.configFilePath);

  // Validate credentials if provided; otherwise use fail-closed default.
  let credentials: CredentialStore;
  if (options.credentials !== undefined) {
    assertCredentialStore(options.credentials);
    credentials = options.credentials;
  } else {
    credentials = new UnavailableCredentialStore();
  }

  // Load config file and restore registry BEFORE creating any listener.
  // Check existence first so we can distinguish not-found from invalid.
  const { existsSync } = await import("node:fs");
  const store = createFileJsonConfigStore({
    filePath: options.configFilePath,
  });

  if (!existsSync(options.configFilePath) && options.createIfMissing === true) {
    try {
      await ensureParentDirectory(options.configFilePath);
      await store.save({ version: 1, providers: [], routes: [] });
    } catch {
      throw new ConfigBootstrapError("config_write_failed");
    }
  }
  if (!existsSync(options.configFilePath)) {
    throw new ConfigBootstrapError("config_not_found");
  }

  let registry;
  try {
    registry = await loadProviderRegistry(store);
  } catch {
    throw new ConfigBootstrapError("config_invalid");
  }

  // Assemble the backend runner. No credential read, no HTTP, no provider
  // call happens here — the runner is lazy. Only explicitly supplied backend
  // options are forwarded, so the backend keeps its own fail-closed defaults.
  const backendOptions: Record<string, unknown> = { registry, credentials };
  const rawOptions = options as unknown as Record<string, unknown>;
  for (const key of BACKEND_OPTION_KEYS) {
    const value = rawOptions[key];
    if (value !== undefined) {
      backendOptions[key] = value;
    }
  }
  let runner;
  try {
    runner = createAgentBackendRunner(backendOptions as unknown as AgentBackendOptions);
  } catch {
    // The backend validates its own options; a rejection is reported through
    // this bootstrap's fixed contract instead of leaking the inner error.
    throw new ConfigBootstrapError("invalid_backend_options");
  }

  const configManager = createConfigManager({
    registry,
    jsonStore: store,
  });

  // Create and start the loopback host with the assembled runner.
  const localHost = createLocalAgentHost({
    host,
    port: options.port,
    runner,
    configManager,
  });
  await localHost.start();
  return localHost;
}
