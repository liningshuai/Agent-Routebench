import { describe, expect, test } from "vitest";
import { loadCapabilities, loadTauriConfig, readRepoFile } from "./helpers/tauri-native-fixtures.js";

const RUST_SRC = "apps/desktop/src-tauri/src";
const rustFile = (name: string): string => readRepoFile(`${RUST_SRC}/${name}`);

interface CommandRegion {
  readonly body: string;
  readonly helper: string;
}

/**
 * Extracts the source region of one command: from `fn agent_*` up to the next
 * `#[tauri::command]` attribute (or end of file), which covers the command
 * body plus the delegated checked helper that follows it.
 */
function commandRegion(commands: string, name: string): CommandRegion {
  const marker = `fn agent_${name}`;
  const start = commands.indexOf(marker);
  expect(start, `command ${name} must exist`).toBeGreaterThan(-1);
  let end = commands.indexOf("#[tauri::command]", start);
  if (end === -1) end = commands.length;
  const region = commands.slice(start, end);
  const helperStart = region.indexOf(`fn ${name}_checked`);
  return {
    body: helperStart === -1 ? region : region.slice(0, helperStart),
    helper: helperStart === -1 ? "" : region.slice(helperStart),
  };
}

describe("Task 19: validation happens strictly before the backend", () => {
  test("agent_create_session consults the backend after no further input", () => {
    const commands = rustFile("commands.rs");
    const { body } = commandRegion(commands, "create_session");
    expect(body).toContain("create_session_checked");
  });

  test("agent_start_turn validates the payload before delegating", () => {
    const commands = rustFile("commands.rs");
    const { body, helper } = commandRegion(commands, "start_turn");
    const whole = body + helper;
    const validateAt = whole.indexOf("validate_start_turn_payload");
    const delegateAt = whole.indexOf(".start_turn(");
    expect(validateAt).toBeGreaterThan(-1);
    expect(delegateAt).toBeGreaterThan(validateAt);
  });

  test("agent_cancel_turn validates both identifiers before delegating", () => {
    const commands = rustFile("commands.rs");
    const { body, helper } = commandRegion(commands, "cancel_turn");
    const whole = body + helper;
    const sessionAt = whole.indexOf("validate_session_id");
    const turnAt = whole.indexOf("validate_turn_id");
    const delegateAt = whole.indexOf(".cancel_turn(");
    expect(sessionAt).toBeGreaterThan(-1);
    expect(turnAt).toBeGreaterThan(sessionAt);
    expect(delegateAt).toBeGreaterThan(turnAt);
  });

  test("sensitive and unknown field rejection stays ahead of the backend call", () => {
    const validation = rustFile("validation.rs");
    const forbiddenAt = validation.indexOf("FORBIDDEN_FIELDS");
    const unknownAt = validation.indexOf("TURN_FIELDS");
    const backendMentions = validation.indexOf("backend");
    expect(forbiddenAt).toBeGreaterThan(-1);
    expect(unknownAt).toBeGreaterThan(-1);
    // validation.rs performs no backend access at all.
    expect(backendMentions).toBe(-1);
  });
});

describe("Task 19: no fabricated results and no leaks", () => {
  test("commands never fabricate a successful value", () => {
    const commands = rustFile("commands.rs");
    expect(commands).not.toMatch(/Ok\s*\(\s*serde_json::json!/);
    expect(commands).not.toMatch(/Ok\s*\(\s*Value::/);
    expect(commands).not.toMatch(/Ok\s*\(\s*json!/);
  });

  test("commands never fabricate session or turn identifiers", () => {
    const commands = rustFile("commands.rs");
    // Only the production region counts; the test module may use synthetic
    // identifiers as data.
    const production = commands.slice(0, commands.indexOf("#[cfg(test)]"));
    expect(production).not.toMatch(/"(session|turn)-[A-Za-z0-9]+"/);
  });

  test("the reserved turn event is never emitted by the host", () => {
    const commands = rustFile("commands.rs");
    expect(commands).not.toContain(".emit(");
    expect(commands).not.toContain("emit_to(");
  });

  test("backend results cannot smuggle raw error text through the boundary", () => {
    const backend = rustFile("backend.rs");
    // The trait's error type is the fixed HostError contract, so dynamic
    // messages are unrepresentable at the boundary. The trait itself declares
    // exactly three typed success signatures and no open Value successes.
    const traitRegion = backend.slice(0, backend.indexOf("pub struct NotReadyBackend"));
    expect(traitRegion.match(/Result<serde_json::Value,\s*HostError>/g)?.length ?? 0).toBe(0);
    expect(traitRegion.match(/Result<CreateSessionResponse,\s*HostError>/g)?.length).toBe(1);
    expect(traitRegion.match(/Result<StartTurnResponse,\s*HostError>/g)?.length).toBe(1);
    expect(traitRegion.match(/Result<CancelTurnResponse,\s*HostError>/g)?.length).toBe(1);
    const commands = rustFile("commands.rs");
    expect(commands).not.toContain("{:?}");
    expect(commands).not.toContain("format!");
    expect(commands).not.toContain("to_string()");
  });

  test("HostRuntime holds no provider, credential, route or URL material", () => {
    for (const file of ["backend.rs", "runtime.rs"]) {
      const source = rustFile(file).toLowerCase();
      for (const forbidden of [
        "provider",
        "credential",
        "route_id",
        "apikey",
        "api_key",
        "secret",
        "password",
        "authorization",
        "bearer",
        "http://",
        "https://",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("Task 19: runtime isolation", () => {
  test("the host uses no process-wide shared runtime", () => {
    for (const file of ["lib.rs", "commands.rs", "runtime.rs", "backend.rs"]) {
      const source = rustFile(file);
      expect(source, file).not.toContain("static mut");
      expect(source, file).not.toMatch(/\bstatic\s+(?:ref\s+)?[A-Z_]+:\s*(?:HostRuntime|Arc<dyn HostBackend>)/);
    }
  });

  test("each HostRuntime owns its own backend instance", () => {
    const runtime = rustFile("runtime.rs").slice(0, rustFile("runtime.rs").indexOf("#[cfg(test)]"));
    expect(rustFile("runtime.rs").indexOf("#[cfg(test)]")).toBeGreaterThan(-1);
    expect(runtime).not.toContain("OnceLock");
    expect(runtime).not.toContain("OnceCell");
    expect(runtime).not.toContain("RwLock");
    expect(runtime).not.toContain("Mutex<");
  });

  test("fake backends cannot become the production default", () => {
    const lib = rustFile("lib.rs");
    expect(lib).not.toContain("with_backend");
    expect(lib).toContain("HostRuntime::not_ready()");
  });
});

describe("Task 19: host security posture is unchanged", () => {
  test("Rust host still performs no network, process, environment or filesystem access", () => {
    for (const file of ["backend.rs", "runtime.rs", "commands.rs"]) {
      const source = rustFile(file);
      for (const forbidden of [
        "std::net",
        "TcpStream",
        "reqwest",
        "ureq",
        "std::process",
        "Command::new",
        "std::env",
        "env::var",
        "std::fs",
        "fs::read",
        "fs::write",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("Cargo dependencies remain within the Task 18 allowlist", () => {
    const cargo = readRepoFile("apps/desktop/src-tauri/Cargo.toml");
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
    expect([...declared].sort()).toEqual(["serde", "serde_json", "tauri", "tauri-build"]);
  });

  test("capabilities stay minimal for the main window", () => {
    const capability = loadCapabilities();
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(["core:event:default"]);
  });

  test("tauri.conf.json keeps the strict CSP and no remote devUrl", () => {
    const config = loadTauriConfig();
    expect(config.build?.devUrl ?? "").toBe("");
    const csp = String(config.app?.security?.csp ?? "");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
  });
});
