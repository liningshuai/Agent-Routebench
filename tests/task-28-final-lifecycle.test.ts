import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalAgentHost,
  NotReadyLocalAgentRunner,
} from "../apps/local-agent-host/src/host.js";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import { createLocalAgentApiServer } from "../packages/local-agent-api/src/index.js";
import type { LocalAgentApiServer } from "../packages/local-agent-api/src/index.js";
import {
  createTempConfigDir,
  freeLoopbackPort,
  t28Snapshot,
  writeSnapshot,
  type TempConfig,
} from "./helpers/task-28-fixtures.js";

/* ------------------------------------------------------------------ *
 * Task 28 — final lifecycle and native startup chain.
 *
 * The Rust sidecar/native boundary is asserted statically (it is compiled
 * and unit-tested by `cargo test`), while the Node host lifecycle, the
 * fixed health contract, the fail-closed default runner and the renderer
 * boundary are exercised behaviourally.
 * ------------------------------------------------------------------ */

const repoRoot = resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

const DESKTOP_SOURCES = [
  "apps/desktop/src/ui.ts",
  "apps/desktop/src/controller.ts",
  "apps/desktop/src/view-model.ts",
  "apps/desktop/src/render.ts",
  "apps/desktop/src/config-client.ts",
  "apps/desktop/src/tauri-api-client.ts",
  "apps/desktop/src/local-api-client.ts",
  "apps/desktop/src/tauri-entry.ts",
  "apps/desktop/src/browser-entry.ts",
  "apps/desktop/src/index.ts",
  "apps/desktop/src/errors.ts",
  "apps/desktop/src/types.ts",
];

let apiServer: LocalAgentApiServer | undefined;
let host: Awaited<ReturnType<typeof createConfiguredLocalAgentHost>> | undefined;
let temp: TempConfig | undefined;

afterEach(async () => {
  await apiServer?.close();
  apiServer = undefined;
  await host?.close();
  host = undefined;
  await temp?.dispose();
  temp = undefined;
});

describe("Task 28 final lifecycle: native startup chain", () => {
  it("creates exactly one Node sidecar supervisor at Tauri setup", () => {
    const lib = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
    expect(lib.match(/NodeHostSupervisor::new\(/g)).toHaveLength(1);
    expect(lib.match(/create_sidecar_supervisor\(/g)).toHaveLength(2);
    expect(lib).toContain("app.manage(supervisor)");
    expect(lib).toContain("RunEvent::Exit");
    expect(lib).toContain("supervisor.stop()");
  });

  it("launches the sidecar without a shell and with discarded output streams", () => {
    const sidecar = readRepoFile("apps/desktop/src-tauri/src/sidecar.rs");
    expect(sidecar).toContain("Command::new(&config.executable)");
    // No interpreter is ever inserted between the host and the Node child.
    expect(sidecar).not.toMatch(/Command::new\(\s*"cmd"/i);
    expect(sidecar).not.toMatch(/Command::new\(\s*"(powershell|bash|sh|wsl)"/i);
    expect(sidecar).not.toContain('"/c"');
    expect(sidecar).not.toContain("Command::new(\"sh\")");
    expect(sidecar.match(/Stdio::null\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("uses only the fixed loopback host and passes an absolute config path", () => {
    const sidecar = readRepoFile("apps/desktop/src-tauri/src/sidecar.rs");
    const lib = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
    expect(sidecar).toContain('pub const SIDECAR_LOOPBACK_HOST: &str = "127.0.0.1"');
    expect(sidecar).toContain("Path::new(&path).is_absolute()");
    expect(sidecar).toContain('.arg("--host")');
    expect(sidecar).toContain('.arg("--port")');
    expect(sidecar).toContain('.arg("--config")');
    expect(sidecar).toContain('.arg("--create-if-missing")');
    expect(lib).toContain("with_config_path");
    expect(lib).toContain("with_create_config_if_missing(true)");
  });

  it("only creates an empty first-run config when that is explicitly allowed", () => {
    const lib = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
    const host = readRepoFile("apps/local-agent-host/src/configured-host.ts");
    expect(lib).toContain("if !config_path.exists()");
    expect(host).toContain("options.createIfMissing === true");
    expect(host).toContain('"config_not_found"');
  });

  it("requires the exact fixed /health payload before reporting running", () => {
    const sidecar = readRepoFile("apps/desktop/src-tauri/src/sidecar.rs");
    expect(sidecar).toContain('"agent-workbench-local-api"');
    expect(sidecar).toContain("payload.len() == 3");
    expect(sidecar).toContain('payload.get("ok") == Some(&serde_json::Value::Bool(true))');
    expect(sidecar).toContain("SidecarState::Failed");
  });

  it("serves exactly the fixed health contract from the Local Agent API", async () => {
    apiServer = createLocalAgentApiServer({ port: 0, runner: new NotReadyLocalAgentRunner() });
    await apiServer.start();
    const response = await fetch(`${apiServer.address()}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "agent-workbench-local-api",
      version: 1,
    });
  });

  it("rejects a non-GET health method with a fixed 405", async () => {
    apiServer = createLocalAgentApiServer({ port: 0, runner: new NotReadyLocalAgentRunner() });
    await apiServer.start();
    const response = await fetch(`${apiServer.address()}/health`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("Task 28 final lifecycle: host start/stop behaviour", () => {
  it("moves created → running → closed and drops its address on close", async () => {
    const port = await freeLoopbackPort();
    const created = createLocalAgentHost({ port });
    expect(created.state()).toBe("created");
    expect(created.address()).toBeUndefined();
    await created.start();
    expect(created.state()).toBe("running");
    expect(created.address()).toBe(`http://127.0.0.1:${port}`);
    await created.close();
    expect(created.state()).toBe("closed");
    expect(created.address()).toBeUndefined();
  });

  it("rejects a second start with the fixed already_started error", async () => {
    const port = await freeLoopbackPort();
    const created = createLocalAgentHost({ port });
    await created.start();
    await expect(created.start()).rejects.toMatchObject({ code: "already_started" });
    await created.close();
  });

  it("stops idempotently", async () => {
    const port = await freeLoopbackPort();
    const created = createLocalAgentHost({ port });
    await created.start();
    await created.close();
    await created.close();
    expect(created.state()).toBe("closed");
  });

  it("releases the listening port after close", async () => {
    const port = await freeLoopbackPort();
    const created = createLocalAgentHost({ port });
    await created.start();
    await created.close();

    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  });

  it("rejects a non-loopback host before any listener exists", () => {
    expect(() => createLocalAgentHost({ host: "0.0.0.0", port: 4317 } as never)).toThrowError(
      /loopback/i,
    );
    expect(() => createLocalAgentHost({ port: 0 })).toThrowError(/port/i);
  });

  it("never fabricates a session, text or completed event with the default runner", async () => {
    apiServer = createLocalAgentApiServer({ port: 0, runner: new NotReadyLocalAgentRunner() });
    await apiServer.start();
    const created = await fetch(`${apiServer.address()}/v1/sessions`, { method: "POST" });
    const session = (await created.json()) as { session: { id: string } };
    const turn = await fetch(
      `${apiServer.address()}/v1/sessions/${session.session.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      },
    );
    const raw = await turn.text();
    expect(raw).toContain('"code":"runner_error"');
    expect(raw).not.toContain('"type":"text_delta"');
    expect(raw).not.toContain('"type":"completed"');
  });

  it("fails the configured bootstrap without binding a port when the config is missing", async () => {
    temp = await createTempConfigDir();
    const port = await freeLoopbackPort();
    await expect(
      createConfiguredLocalAgentHost({
        port,
        configFilePath: temp.filePath,
      }),
    ).rejects.toMatchObject({ code: "config_not_found" });

    // Nothing is listening on the port the failed bootstrap would have used.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  });

  it("fails the configured bootstrap without binding a port when the config is invalid", async () => {
    temp = await createTempConfigDir();
    await writeSnapshot(temp.filePath, { version: 2 } as never);
    const port = await freeLoopbackPort();
    await expect(
      createConfiguredLocalAgentHost({ port, configFilePath: temp.filePath }),
    ).rejects.toMatchObject({ code: "config_invalid" });

    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  });

  it("starts from a valid config file and answers health on loopback only", async () => {
    temp = await createTempConfigDir();
    await writeSnapshot(temp.filePath, t28Snapshot());
    const port = await freeLoopbackPort();
    host = await createConfiguredLocalAgentHost({ port, configFilePath: temp.filePath });
    expect(host.address()).toBe(`http://127.0.0.1:${port}`);
    const response = await fetch(`${host.address()}/health`);
    expect(response.status).toBe(200);
  });
});

describe("Task 28 final lifecycle: renderer boundary", () => {
  it("never imports Node built-ins or the filesystem from the renderer", () => {
    for (const source of DESKTOP_SOURCES) {
      const text = readRepoFile(source);
      expect(text, source).not.toMatch(/from\s+"node:/);
      expect(text, source).not.toContain("require(");
      expect(text, source).not.toContain("child_process");
      expect(text, source).not.toContain("readFileSync");
      expect(text, source).not.toContain("writeFileSync");
    }
  });

  it("never constructs a provider registry, credential store or persistence store", () => {
    for (const source of DESKTOP_SOURCES) {
      const text = readRepoFile(source);
      expect(text, source).not.toContain("InMemoryProviderRegistry");
      expect(text, source).not.toContain("createSecureCredentialStore");
      expect(text, source).not.toContain("createFileJsonConfigStore");
      expect(text, source).not.toContain("createRoutedHttpModelGateway");
      expect(text, source).not.toContain("createAgentBackend");
    }
  });

  it("keeps Tauri capabilities minimal and the CSP strict", () => {
    const capabilities = JSON.parse(
      readRepoFile("apps/desktop/src-tauri/capabilities/default.json"),
    ) as { windows: string[]; permissions: string[] };
    expect(capabilities.windows).toEqual(["main"]);
    expect(capabilities.permissions).toEqual(["core:event:default"]);

    const conf = JSON.parse(readRepoFile("apps/desktop/src-tauri/tauri.conf.json")) as {
      build: Record<string, unknown>;
      app: { security: { csp: string }; windows: { label: string }[] };
    };
    expect(conf.build.frontendDist).toBe("../dist");
    expect(conf.build).not.toHaveProperty("devUrl");
    const csp = conf.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    // The only allowed connection target is the Tauri IPC origin itself:
    // no external host, no wildcard and no remote asset origin.
    expect(csp).not.toContain("*");
    expect(csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
    expect(csp).toContain("connect-src ipc: http://ipc.localhost");
    expect(conf.app.windows).toHaveLength(1);
  });

  it("keeps the Rust build output pinned to the repository root target directory", () => {
    const cargoConfig = readRepoFile(".cargo/config.toml");
    expect(cargoConfig).toContain('target-dir = "target"');
    expect(existsSync(resolve(repoRoot, "apps/desktop/src-tauri/target"))).toBe(false);
  });

  it("never exposes the Node sidecar script path to the renderer", () => {
    for (const source of DESKTOP_SOURCES) {
      const text = readRepoFile(source);
      expect(text, source).not.toContain("local-agent-host/dist");
      expect(text, source).not.toContain("app_config_dir");
    }
  });

  it("wires the configuration client through the Tauri entry point", () => {
    const entry = readRepoFile("apps/desktop/src/tauri-entry.ts");
    expect(entry).toContain("createDesktopConfigClient");
    expect(entry).toContain("const configClient =");
    expect(entry).toContain("createDesktopCredentialClient");
    expect(entry).toContain("mountDesktopUi(container, client, configClient, credentialClient)");
    // The renderer reaches configuration only through the injected client.
    expect(entry).not.toContain("fetch(");
    expect(entry).not.toContain("createLocalAgentApiServer");
  });

  it("forwards only fixed loopback configuration paths through the native proxy", () => {
    const proxy = readRepoFile("apps/desktop/src-tauri/src/proxy.rs");
    expect(proxy).toContain("impl ConfigBackend for NodeSidecarBackend");
    for (const path of ["/v1/config", "/v1/providers", "/v1/routes"]) {
      expect(proxy, path).toContain(`"${path}"`);
    }
    // Ids are percent-encoded into the fixed path, never concatenated raw.
    expect(proxy).toContain("encode_path_segment");
  });
});

describe("Task 28 final lifecycle: build output hygiene", () => {
  it("ignores the transient Desktop build directories", () => {
    const gitignore = readRepoFile(".gitignore");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("dist-staging/");
    expect(gitignore).toContain("dist-retiring*/");
  });

  it("never lets a stale retiring directory block the Desktop build", () => {
    const script = readRepoFile("scripts/build-desktop.mjs");
    // The outgoing directory is moved to a unique name...
    expect(script).toMatch(/-retiring-\$\{process\.pid\}-\$\{Date\.now\(\)\}/);
    // ...and its removal is best-effort, so a locked leftover cannot abort a
    // build whose real result is already swapped in.
    expect(script).toContain("function removeQuietly(");
    expect(script).toContain("function cleanupStaleOutputs(");
    expect(script).not.toMatch(/^\s*rmSync\(retiringDir/m);
  });

  it("never lets a stale retiring directory block the Local Agent Host build", () => {
    const script = readRepoFile("scripts/build-local-agent-host.mjs");
    expect(script).toMatch(/-retiring-\$\{process\.pid\}-\$\{Date\.now\(\)\}/);
    expect(script).toContain("function removeQuietly(");
    expect(script).toContain("function cleanupStaleOutputs(");
    expect(script).not.toMatch(/^\s*rmSync\(retiringDir/m);
    expect(script).not.toMatch(/^\s*rmSync\(distDir/m);
  });

  it("relocates vendor output instead of copying then bulk-deleting it", () => {
    const desktop = readRepoFile("scripts/build-desktop.mjs");
    const host = readRepoFile("scripts/build-local-agent-host.mjs");
    // A single multi-entry tsc run dumps the compiled packages into a raw
    // directory; each package subtree is *moved* into place so the leftover
    // cleanup stays a bounded delete rather than one large recursive removal.
    expect(desktop).toContain("renameSync(from, to)");
    expect(desktop).toContain("removeQuietly(rawOut)");
    expect(desktop).not.toContain("copyTree");
    expect(host).toContain("renameSync(source, target)");
    expect(host).toContain("removeQuietly(rawVendorDir)");
    expect(host).not.toContain("copyTree");
    for (const [name, script] of [
      ["build-desktop", desktop],
      ["build-local-agent-host", host],
    ] as const) {
      expect(script, name).not.toMatch(/rmSync\(raw(Out|VendorDir)/);
    }
  });

  it("cleans only the build's own transient directories", () => {
    const script = readRepoFile("scripts/build-desktop.mjs");
    const cleanup = script.slice(script.indexOf("function cleanupStaleOutputs("));
    const body = cleanup.slice(0, cleanup.indexOf("\n}\n"));
    expect(body).toContain('entry === "dist-staging"');
    expect(body).toContain('entry.startsWith("dist-retiring")');
    expect(body).not.toContain('"dist"');
  });

  it("gives build hooks room to finish instead of cutting them off", () => {
    const config = readRepoFile("vitest.config.ts");
    // A cold Desktop/Rust build inside a hook far exceeds vitest's 10s default.
    expect(config).toMatch(/hookTimeout:\s*20\s*\*\s*60\s*\*\s*1000/);
  });

  it("keeps no transient build directory in the working tree", () => {
    expect(existsSync(resolve(repoRoot, "apps/desktop/dist-staging"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "apps/desktop/dist-retiring"))).toBe(false);
  });
});
