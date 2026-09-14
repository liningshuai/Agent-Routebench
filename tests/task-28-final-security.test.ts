import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import type { LocalAgentHost } from "../apps/local-agent-host/src/types.js";
import {
  InMemoryCredentialStore,
  UnavailableCredentialStore,
  createSecureCredentialStore,
} from "../packages/provider-registry/src/index.js";
import type { CredentialStore } from "../packages/provider-registry/src/index.js";
import { createEventViewModel } from "../apps/desktop/src/view-model.js";
import {
  T28_BASE_URL,
  T28_CREDENTIAL_REF,
  T28_MODEL,
  T28_PROVIDER_ID,
  T28_ROUTE_ID,
  T28_SECRET,
  createRecordingCredentialBackend,
  createSession,
  createTempConfigDir,
  eventTypes,
  freeLoopbackPort,
  runTurn,
  t28Snapshot,
  t28TurnBody,
  writeSnapshot,
  type TempConfig,
} from "./helpers/task-28-fixtures.js";
import { anthropicSuccessResponse, createFakeHttpClient } from "./helpers/http-fixtures.js";

/* ------------------------------------------------------------------ *
 * Task 28 — final credential and secret boundary.
 * ------------------------------------------------------------------ */

const repoRoot = resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function listSourceFiles(relativeDir: string): string[] {
  const root = resolve(repoRoot, relativeDir);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|rs)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

let host: LocalAgentHost | undefined;
let temp: TempConfig | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await temp?.dispose();
  temp = undefined;
});

async function boot(
  options: {
    readonly withSecret?: boolean;
    readonly injectCredentials?: boolean;
  } = {},
): Promise<{
  baseUrl: string;
  credentials: ReturnType<typeof createRecordingCredentialBackend>;
  http: ReturnType<typeof createFakeHttpClient>;
}> {
  temp = await createTempConfigDir();
  await writeSnapshot(temp.filePath, t28Snapshot());
  const credentials = createRecordingCredentialBackend(
    options.withSecret === false ? {} : { [T28_CREDENTIAL_REF]: T28_SECRET },
  );
  const http = createFakeHttpClient(() => anthropicSuccessResponse("hello"));
  const port = await freeLoopbackPort();
  host = await createConfiguredLocalAgentHost({
    port,
    configFilePath: temp.filePath,
    httpClient: http.client,
    ...(options.injectCredentials === false ? {} : { credentials: credentials.store() }),
  });
  return { baseUrl: host.address() as string, credentials, http };
}

describe("Task 28 final security: credential lifecycle", () => {
  it("reads no credential during startup", async () => {
    const harness = await boot();
    expect(harness.credentials.gets()).toBe(0);
    expect(harness.credentials.calls()).toHaveLength(0);
  });

  it("reads no credential for health, session or config requests", async () => {
    const harness = await boot();
    await fetch(`${harness.baseUrl}/health`);
    await fetch(`${harness.baseUrl}/v1/config`);
    await createSession(harness.baseUrl);
    expect(harness.credentials.gets()).toBe(0);
  });

  it("reads the credential exactly once for one authenticated turn", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(harness.credentials.gets()).toBe(1);
    expect(harness.credentials.calls().every((call) => call.op === "get")).toBe(true);
  });

  it("never writes, deletes or probes credentials", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(harness.credentials.calls().filter((call) => call.op !== "get")).toHaveLength(0);
  });

  it("fails closed with no credential source configured", async () => {
    const harness = await boot({ injectCredentials: false });
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    expect(harness.http.calls()).toBe(0);
    expect(eventTypes(result.events)).toEqual(["route_selected", "error"]);
    expect(result.events[1]).toMatchObject({
      type: "error",
      message: "Model gateway request failed.",
    });
  });

  it("uses the fail-closed unavailable store by default in the configured host", () => {
    const source = readRepoFile("apps/local-agent-host/src/configured-host.ts");
    expect(source).toContain("new UnavailableCredentialStore()");
    expect(source).toContain("assertCredentialStore(options.credentials)");
  });

  it("never exposes a secret in the configuration snapshot", async () => {
    const harness = await boot();
    const response = await fetch(`${harness.baseUrl}/v1/config`);
    const text = await response.text();
    expect(text).toContain(T28_CREDENTIAL_REF);
    expect(text).not.toContain(T28_SECRET);
  });

  it("never exposes a secret in the session payload or the event history", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody());

    const session = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}`);
    const sessionText = await session.text();
    const events = await fetch(`${harness.baseUrl}/v1/sessions/${sessionId}/events`);
    const eventsText = await events.text();

    for (const text of [sessionText, eventsText]) {
      expect(text).not.toContain(T28_SECRET);
      expect(text).not.toContain("x-api-key");
      expect(text).not.toContain(T28_BASE_URL);
    }
  });

  it("never exposes a secret or the provider URL in the NDJSON stream", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(result.raw).not.toContain(T28_SECRET);
    expect(result.raw).not.toContain(T28_BASE_URL);
    expect(result.raw).not.toContain(T28_CREDENTIAL_REF);
  });

  it("never writes a secret into the configuration file", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    const onDisk = readFileSync(temp?.filePath as string, "utf8");
    expect(onDisk).not.toContain(T28_SECRET);
  });

  it("keeps the credential ref out of the Desktop event view model", () => {
    const viewModel = createEventViewModel({
      type: "route_selected",
      requestId: "t",
      routeId: T28_ROUTE_ID,
      model: T28_MODEL,
    });
    expect(Object.keys(viewModel)).toEqual(["type"]);

    const toolCall = createEventViewModel({
      type: "tool_call",
      requestId: "t",
      id: "call-1",
      name: "read_file",
      input: { apiKey: "T28_SYNTHETIC_VALUE" },
    });
    expect(JSON.stringify(toolCall)).not.toContain("apiKey");
    expect(toolCall).not.toHaveProperty("input");
  });
});

describe("Task 28 final security: credential store boundary", () => {
  it("accepts an explicit in-memory store and returns the stored value", async () => {
    const store = new InMemoryCredentialStore();
    await store.set(T28_CREDENTIAL_REF, T28_SECRET);
    expect(await store.get(T28_CREDENTIAL_REF)).toBe(T28_SECRET);
  });

  it("returns undefined for an unknown reference instead of throwing", async () => {
    const store = new InMemoryCredentialStore();
    expect(await store.get("credential:unknown")).toBeUndefined();
  });

  it("rejects an invalid credential reference", async () => {
    const store = new InMemoryCredentialStore();
    await expect(store.set("not-a-ref", T28_SECRET)).rejects.toThrow();
  });

  it("requires an explicitly injected backend", () => {
    expect(() => createSecureCredentialStore({ backend: null as never })).toThrow();
    expect(() => createSecureCredentialStore({ backend: {} as never })).toThrow();
  });

  it("rejects an invalid reference and an invalid secret before the backend", async () => {
    const calls: string[] = [];
    const store = createSecureCredentialStore({
      backend: {
        get(ref) {
          calls.push(ref);
          return undefined;
        },
        set() {},
        has() {
          return false;
        },
        delete() {},
      },
    });
    await expect(store.get("bad ref")).rejects.toThrow();
    await expect(store.set(T28_CREDENTIAL_REF, "   ")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("collapses a backend exception into the fixed error", async () => {
    const store = createSecureCredentialStore({
      backend: {
        get() {
          throw new Error("backend exploded at /secret/path");
        },
        set() {},
        has() {
          return false;
        },
        delete() {},
      },
    });
    await expect(store.get(T28_CREDENTIAL_REF)).rejects.toMatchObject({
      code: "credential_backend_failed",
    });
  });

  it("fails closed with the default unavailable store", async () => {
    const store: CredentialStore = new UnavailableCredentialStore();
    expect(await store.get(T28_CREDENTIAL_REF)).toBeUndefined();
    expect(await store.has(T28_CREDENTIAL_REF)).toBe(false);
  });
});

describe("Task 28 final security: no ambient secret or network sources", () => {
  const PROVIDER_FACING_DIRS = [
    "apps/local-agent-host/src",
    "packages/model-gateway/src",
    "packages/provider-registry/src",
    "packages/agent-backend/src",
    "apps/desktop/src",
    "apps/desktop/src-tauri/src",
  ];

  it("never reads an API key from environment variables or key-like process arguments", () => {
    for (const dir of PROVIDER_FACING_DIRS) {
      for (const file of listSourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toContain("process.env");
        expect(text, file).not.toMatch(/env::var/);
        expect(text.toLowerCase(), file).not.toMatch(/--(?:api[-_]?key|token|secret)\b/);
      }
    }
  });

  it("never performs a direct outbound fetch from the host, backend or renderer", () => {
    for (const dir of [
      "apps/local-agent-host/src",
      "packages/agent-backend/src",
      "packages/provider-registry/src",
      "apps/desktop/src",
    ]) {
      for (const file of listSourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toMatch(/\bfetch\s*\(/);
        expect(text, file).not.toContain("node:https");
        expect(text, file).not.toContain("node:http");
        expect(text, file).not.toContain("WebSocket");
      }
    }
  });

  it("never accepts an arbitrary URL, host or header at the native boundary", () => {
    const proxy = readRepoFile("apps/desktop/src-tauri/src/proxy.rs");
    expect(proxy).toContain('const SIDECAR_HOST: &str = "127.0.0.1"');
    expect(proxy).not.toMatch(/fn\s+\w+\s*\([^)]*url\s*:\s*&?str/);
    expect(proxy).toContain("encode_path_segment");
    expect(proxy).not.toContain("Host: {header}");
  });

  it("keeps the CLI rejecting every sensitive command line argument", () => {
    const cliArgs = readRepoFile("apps/cli/src/args.ts");
    for (const flag of ["apiKey", "token", "secret", "authorization"]) {
      expect(cliArgs.toLowerCase()).toContain(flag.toLowerCase());
    }
  });

  it("keeps every native error message free of dynamic content", () => {
    const errors = readRepoFile("apps/desktop/src-tauri/src/errors.rs");
    // Messages are fixed &'static str constants: no format!/println!
    // interpolation of runtime values can reach the IPC boundary.
    expect(errors).not.toContain("format!");
    expect(errors).not.toMatch(/message:\s*&?format!/);
    expect(errors).toContain("pub message: &'static str");
    expect(errors).not.toContain("String::from");
  });

  it("keeps the native config commands validating before delegating", () => {
    const commands = readRepoFile("apps/desktop/src-tauri/src/commands.rs");
    expect(commands).toContain("validation::validate_provider_config(&provider)?");
    expect(commands).toContain("validation::validate_route_config(&route)?");
    expect(commands).toContain("validation::validate_config_id(&provider_id)?");
  });

  it("keeps the security scan configuration unchanged", () => {
    const scan = readRepoFile("scripts/security-scan.mjs");
    expect(scan).toContain("process.exit(1)");
    expect(scan).toContain("SYNTHETIC_ALLOWLIST");
    expect(scan).not.toContain("process.exit(0) //");
  });

  it("never enables a remote dev server or an external CDN", () => {
    const conf = readRepoFile("apps/desktop/src-tauri/tauri.conf.json");
    expect(conf).not.toContain("devUrl");
    expect(conf).not.toContain("cdn");
    const html = readRepoFile("apps/desktop/public/index.html");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("never registers a shell, fs or http plugin in the native host", () => {
    const cargo = readRepoFile("apps/desktop/src-tauri/Cargo.toml");
    expect(cargo).not.toContain("plugin-shell");
    expect(cargo).not.toContain("plugin-fs");
    expect(cargo).not.toContain("plugin-http");
    expect(cargo).not.toContain("plugin-sql");
    const capabilities = readRepoFile("apps/desktop/src-tauri/capabilities/default.json");
    expect(capabilities).not.toContain("shell");
    expect(capabilities).not.toContain("fs:");
    expect(capabilities).not.toContain("http:");
  });

  it("keeps the provider id out of the emitted events", async () => {
    const harness = await boot();
    const sessionId = await createSession(harness.baseUrl);
    const result = await runTurn(harness.baseUrl, sessionId, t28TurnBody());
    expect(result.raw).not.toContain(T28_PROVIDER_ID);
  });
});
