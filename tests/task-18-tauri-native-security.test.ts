import { describe, expect, test } from "vitest";
import {
  ALLOWED_CARGO_DEPENDENCIES,
  CAPABILITIES_PATH,
  CARGO_MANIFEST_PATH,
  FORBIDDEN_CARGO_DEPENDENCIES,
  FORBIDDEN_TURN_FIELDS,
  HOST_NOT_READY_CODE,
  HOST_NOT_READY_MESSAGE,
  TAURI_API_CLIENT_PATH,
  TAURI_ENTRY_PATH,
  extractPublicFnNames,
  loadCapabilities,
  loadTauriConfig,
  readRepoFile,
  tsCommandNames,
} from "./helpers/tauri-native-fixtures.js";

const RUST_SRC = "apps/desktop/src-tauri/src";
const rustFile = (name: string): string => readRepoFile(`${RUST_SRC}/${name}`);

function rustCoreSource(): string {
  return ["backend.rs", "commands.rs", "errors.rs", "runtime.rs", "validation.rs"]
    .map(rustFile)
    .join("\n");
}

describe("Task 18: Tauri native security — dependency boundary", () => {
  test("Cargo.toml declares only the allowlisted dependencies", () => {
    const cargo = readRepoFile(CARGO_MANIFEST_PATH);
    const declared = new Set<string>();
    let inDeps = false;
    for (const line of cargo.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        inDeps = /\[(?:build-)?dependencies\]/.test(line);
        continue;
      }
      if (inDeps) {
        const match = line.match(/^([A-Za-z0-9_-]+)\s*=/);
        if (match?.[1]) declared.add(match[1]);
      }
    }
    for (const name of declared) {
      expect(ALLOWED_CARGO_DEPENDENCIES.has(name), `unexpected crate ${name}`).toBe(true);
    }
  });

  test("Cargo.toml declares no dangerous plugin or network crates", () => {
    const cargo = readRepoFile(CARGO_MANIFEST_PATH);
    for (const forbidden of FORBIDDEN_CARGO_DEPENDENCIES) {
      expect(cargo).not.toContain(forbidden);
    }
  });

  test("Rust host registers no Tauri plugins", () => {
    const lib = rustFile("lib.rs");
    expect(lib).not.toContain(".plugin(");
    expect(lib).not.toContain("tauri_plugin");
  });

  test("desktop package.json depends only on the official Tauri 2 packages", () => {
    const pkg = JSON.parse(readRepoFile("apps/desktop/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allowed = new Set([
      "@agent-workbench/agent-core",
      "@agent-workbench/local-agent-api",
      "@agent-workbench/local-agent-client",
      // Task 27 uses these workspace packages for type-only configuration
      // contracts at the renderer boundary.
      "@agent-workbench/local-persistence",
      "@agent-workbench/provider-registry",
      "@tauri-apps/api",
    ]);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(allowed.has(name), `unexpected runtime dependency ${name}`).toBe(true);
    }
    const allowedDev = new Set(["typescript", "@tauri-apps/cli"]);
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
      expect(allowedDev.has(name), `unexpected dev dependency ${name}`).toBe(true);
    }
  });
});

describe("Task 18: Tauri native security — host environment isolation", () => {
  test("core Tauri modules never read environment variables", () => {
    const source = rustCoreSource();
    expect(source).not.toContain("std::env");
    expect(source).not.toContain("env::var");
    expect(source).not.toContain("env!(");
  });

  test("core Tauri modules never spawn processes", () => {
    const source = rustCoreSource();
    expect(source).not.toContain("std::process");
    expect(source).not.toContain("Command::new");
  });

  test("Rust command/runtime modules perform no filesystem traversal", () => {
    // Task 27's Tauri setup intentionally creates the app-scoped config
    // directory/file in lib.rs. The command and runtime modules remain free
    // of filesystem access; config persistence is delegated to the Node host.
    const source = ["main.rs", "commands.rs", "errors.rs", "validation.rs"]
      .map(rustFile)
      .join("\n");
    expect(source).not.toContain("std::fs");
    expect(source).not.toContain("fs::read");
    expect(source).not.toContain("fs::write");
    expect(source).not.toContain("canonicalize");
  });

  test("core Tauri modules open no network client", () => {
    const source = rustCoreSource();
    expect(source).not.toContain("TcpStream");
    expect(source).not.toContain("reqwest");
    expect(source).not.toContain("ureq");
    expect(source).not.toContain("HttpClient");
  });

  test("core backend modules never touch credentials or keychains", () => {
    const source = [rustFile("backend.rs"), rustFile("errors.rs"), rustFile("runtime.rs")].join("\n");
    for (const forbidden of [
      "keyring",
      "keychain",
      "CredentialStore",
      "credential_ref",
      "apiKey",
      "api_key",
      "Bearer",
      "Authorization",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("frontend entry reads no environment or credential values", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    for (const forbidden of [
      "process.env",
      "apiKey",
      "api_key",
      "token",
      "secret",
      "Bearer",
      "Authorization",
    ]) {
      expect(entry.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("frontend entry constructs no network client and renders no raw HTML", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    expect(entry).not.toContain("fetch(");
    expect(entry).not.toContain("XMLHttpRequest");
    expect(entry).not.toContain("WebSocket");
    expect(entry).not.toContain("innerHTML");
    expect(entry).not.toContain("document.write");
  });

  test("the Task 17 bridge remains the only IPC implementation", () => {
    const client = readRepoFile(TAURI_API_CLIENT_PATH);
    expect(client).toContain("TAURI_COMMANDS");
    expect(client).toContain("TAURI_EVENTS");
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    expect(entry).not.toMatch(/\bfetch\s*\(/);
    expect(entry).toContain("createTauriDesktopApiClient");
  });
});

describe("Task 18: Tauri native security — config isolation", () => {
  test("tauri.conf.json references no remote origin", () => {
    const raw = readRepoFile("apps/desktop/src-tauri/tauri.conf.json");
    const origins = raw.match(/https?:\/\/[^\s"'\\]+/g) ?? [];
    for (const origin of origins) {
      expect(origin, `config must not reference remote origin ${origin}`).toBe(
        "http://ipc.localhost",
      );
    }
  });

  test("capabilities enable no filesystem, shell, http, process or sql access", () => {
    const capability = loadCapabilities();
    const permissions = (capability.permissions ?? []).join("\n");
    expect(permissions).not.toMatch(/shell|fs:|http:|process:|sql:|path:/);
    expect(permissions).not.toContain("core:default");
  });

  test("tauri.conf.json loads no CDN or external scripts", () => {
    const config = loadTauriConfig();
    expect(JSON.stringify(config)).not.toContain("cdn");
    expect(JSON.stringify(config)).not.toContain("unpkg");
    expect(JSON.stringify(config)).not.toContain("jsdelivr");
  });
});

describe("Task 18: Tauri native security — request validation", () => {
  test("validation.rs rejects every sensitive turn field with forbidden_field", () => {
    const validation = rustFile("validation.rs");
    for (const field of FORBIDDEN_TURN_FIELDS) {
      expect(validation).toContain(`"${field}"`);
    }
    expect(validation).toContain("forbidden_field");
  });

  test("validation.rs rejects unknown turn fields", () => {
    const validation = rustFile("validation.rs");
    expect(validation).toContain("invalid_request");
  });

  test("validation.rs validates session and turn identifiers", () => {
    const validation = rustFile("validation.rs");
    expect(extractPublicFnNames(validation)).toContain("validate_session_id");
    expect(extractPublicFnNames(validation)).toContain("validate_turn_id");
    expect(validation).toContain("invalid_session_id");
    expect(validation).toContain("invalid_turn_id");
  });

  test("validation.rs validates messages, tools and maxTokens", () => {
    const validation = rustFile("validation.rs");
    expect(validation).toContain("validate_messages");
    expect(validation).toContain("validate_tools");
    expect(validation).toContain("validate_max_tokens");
  });

  test("start turn validation runs before any host behaviour", () => {
    const commands = rustFile("commands.rs");
    const startFn = commands.slice(commands.indexOf("fn agent_start_turn"));
    expect(startFn).toContain("validate_start_turn_payload");
  });
});

describe("Task 18: Tauri native security — no fabricated backend", () => {
  test("agent_create_session returns the fixed host_not_ready error", () => {
    const commands = rustFile("commands.rs");
    const fnStart = commands.indexOf("fn agent_create_session");
    const fnEnd = commands.indexOf("#[tauri::command]", fnStart);
    const body = commands.slice(
      fnStart,
      fnEnd === -1 ? commands.length : fnEnd,
    );
    expect(body).toContain(HOST_NOT_READY_CODE);
    expect(body).not.toMatch(/\bOk\s*\(/);
  });

  test("agent_start_turn returns host_not_ready and emits no fabricated events", () => {
    const commands = rustFile("commands.rs");
    const fnStart = commands.indexOf("fn agent_start_turn");
    const fnEnd = commands.indexOf("#[tauri::command]", fnStart);
    const body = commands.slice(fnStart, fnEnd === -1 ? commands.length : fnEnd);
    expect(body).toContain(HOST_NOT_READY_CODE);
    for (const fabricated of ["text_delta", "tool_call", "usage", "completed"]) {
      expect(body).not.toContain(fabricated);
    }
  });

  test("agent_cancel_turn validates both identifiers and fabricates no events", () => {
    const commands = rustFile("commands.rs");
    const fnStart = commands.indexOf("fn agent_cancel_turn");
    const body = commands.slice(fnStart);
    expect(body).toContain("validate_session_id");
    expect(body).toContain("validate_turn_id");
    expect(body).not.toContain("emit");
  });

  test("the host defines the turn event name without ever emitting it in the MVP", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toContain("agent_turn_event");
    expect(commands).not.toContain(".emit(");
    expect(commands).not.toContain("emit_to(");
  });

  test("host health reports only the host process, not a backend connection", () => {
    const commands = rustFile("commands.rs");
    const healthStart = commands.indexOf("fn agent_health");
    const healthEnd = commands.indexOf("#[tauri::command]", healthStart);
    const body = commands.slice(healthStart, healthEnd === -1 ? commands.length : healthEnd);
    // The health payload references the fixed host identity constant.
    expect(body).toContain("HOST_SERVICE");
    // The fixed identity lives in commands.rs as a constant.
    expect(commands).toContain("agent-workbench-tauri-host");
    expect(body).not.toContain("provider");
    expect(body).not.toContain("backend connected");
  });
});

describe("Task 18: Tauri native security — error hygiene", () => {
  test("HostError serializes only a fixed code and message", () => {
    const errors = rustFile("errors.rs");
    expect(errors).toContain("pub code");
    expect(errors).toContain("pub message");
    expect(errors).not.toContain("Vec<");
    expect(errors).not.toContain("Box<dyn");
  });

  test("error messages contain no dynamic content, paths or URLs", () => {
    const errors = rustFile("errors.rs");
    expect(errors).not.toContain("format!(");
    expect(errors).not.toContain("{:?}");
    expect(errors).not.toContain("C:\\");
    // Fixed host_not_ready wording must be exact.
    expect(errors).toContain(HOST_NOT_READY_MESSAGE);
  });

  test("commands return Result so no panic path reaches the renderer", () => {
    const commands = rustFile("commands.rs");
    for (const name of tsCommandNames()) {
      const fnStart = commands.indexOf(`fn ${name}`);
      const body = commands.slice(fnStart, fnStart + 2000);
      expect(body, `${name} must return Result`).toMatch(/Result</);
    }
  });

  test("commands never echo raw input into errors", () => {
    const commands = rustFile("commands.rs");
    expect(commands).not.toContain("to_string()");
  });
});
