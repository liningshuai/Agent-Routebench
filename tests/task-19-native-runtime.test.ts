import { describe, expect, test } from "vitest";
import {
  extractTauriCommandNames,
  loadCapabilities,
  loadTauriConfig,
  readRepoFile,
  tsCommandNames,
  tsEventNames,
} from "./helpers/tauri-native-fixtures.js";

const RUST_SRC = "apps/desktop/src-tauri/src";
const rustFile = (name: string): string => readRepoFile(`${RUST_SRC}/${name}`);

describe("Task 19: HostBackend boundary", () => {
  test("backend.rs defines the injectable HostBackend trait", () => {
    const backend = rustFile("backend.rs");
    expect(backend).toContain("pub trait HostBackend: Send + Sync");
  });

  test("the trait exposes exactly the three backend-shaped methods", () => {
    const backend = rustFile("backend.rs");
    expect(backend).toMatch(
      /fn\s+create_session\s*\(\s*&self\s*\)\s*->\s*Result<CreateSessionResponse,\s*HostError>/,
    );
    expect(backend).toMatch(
      /fn\s+start_turn\s*\(\s*&self,\s*session_id:\s*&str,\s*request:\s*&serde_json::Value\s*,?\s*\)\s*->\s*Result<StartTurnResponse,\s*HostError>/,
    );
    expect(backend).toMatch(
      /fn\s+cancel_turn\s*\(\s*&self,\s*session_id:\s*&str,\s*turn_id:\s*&str\s*,?\s*\)\s*->\s*Result<CancelTurnResponse,\s*HostError>/,
    );
  });

  test("NotReadyBackend is the production default implementation", () => {
    const backend = rustFile("backend.rs");
    expect(backend).toContain("pub struct NotReadyBackend");
    expect(backend).toMatch(/impl\s+HostBackend\s+for\s+NotReadyBackend/);
  });

  test("NotReadyBackend fails all three operations with the fixed host_not_ready error", () => {
    const backend = rustFile("backend.rs");
    const implStart = backend.indexOf("impl HostBackend for NotReadyBackend");
    const implBody = backend.slice(implStart, backend.indexOf("#[cfg(test)]", implStart));
    const errCount = implBody.split("Err(HostError::host_not_ready())").length - 1;
    expect(errCount).toBe(3);
  });

  test("fake backends exist only inside test-gated code", () => {
    for (const file of ["backend.rs", "runtime.rs"]) {
      const source = rustFile(file);
      const testGate = source.indexOf("#[cfg(test)]");
      expect(testGate, `${file} must gate its tests`).toBeGreaterThan(-1);
      const fakeUse = source.indexOf("TestBackend");
      if (fakeUse !== -1) {
        expect(fakeUse, `${file} must only reference TestBackend in tests`).toBeGreaterThan(
          testGate,
        );
      }
    }
  });

  test("Rust unit tests cover the backend and runtime modules", () => {
    for (const file of ["backend.rs", "runtime.rs"]) {
      expect(rustFile(file)).toContain("#[cfg(test)]");
    }
  });
});

describe("Task 19: HostRuntime container", () => {
  test("runtime.rs defines HostRuntime holding an Arc<dyn HostBackend>", () => {
    const runtime = rustFile("runtime.rs");
    expect(runtime).toContain("pub struct HostRuntime");
    expect(runtime).toMatch(/backend:\s*(?:pub\s+)?(?:Arc<dyn HostBackend>|std::sync::Arc<dyn HostBackend>)/);
  });

  test("HostRuntime::not_ready() builds a fresh NotReadyBackend per instance", () => {
    const runtime = rustFile("runtime.rs");
    const factory = runtime.slice(runtime.indexOf("fn not_ready"));
    expect(factory).toContain("Arc::new(NotReadyBackend)");
  });

  test("HostRuntime supports explicit backend injection", () => {
    const runtime = rustFile("runtime.rs");
    expect(runtime).toMatch(/fn\s+with_backend/);
    expect(runtime).toMatch(/fn\s+backend\s*\(\s*&self\s*\)\s*->\s*&(?:dyn\s+)?HostBackend/);
  });

  test("lib.rs registers the default not-ready runtime as Tauri state", () => {
    const lib = rustFile("lib.rs");
    expect(lib).toContain(".manage(HostRuntime::not_ready())");
    expect(lib).toContain("mod backend;");
    expect(lib).toContain("mod runtime;");
  });

  test("lib.rs registers no fake backend and no second runtime", () => {
    const lib = rustFile("lib.rs");
    expect(lib).not.toContain("TestBackend");
    expect(lib.split("manage(").length - 1).toBe(1);
  });

  test("no global mutable backend state exists in the Rust host", () => {
    for (const file of ["backend.rs", "runtime.rs", "commands.rs", "lib.rs"]) {
      const source = rustFile(file);
      expect(source, file).not.toContain("static mut");
      expect(source, file).not.toMatch(/static\s+[A-Z_]*BACKEND/i);
      expect(source, file).not.toContain("lazy_static");
      expect(source, file).not.toContain("once_cell");
    }
  });
});

describe("Task 19: command delegation", () => {
  test("agent_create_session delegates to the runtime backend", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toMatch(
      /runtime\s*\.\s*backend\s*\(\s*\)\s*\.\s*create_session\s*\(\s*\)/,
    );
  });

  test("agent_start_turn delegates to the runtime backend", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toMatch(
      /runtime\s*\.\s*backend\s*\(\s*\)\s*\.\s*start_turn\s*\(/,
    );
  });

  test("agent_cancel_turn delegates to the runtime backend", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toMatch(
      /runtime\s*\.\s*backend\s*\(\s*\)\s*\.\s*cancel_turn\s*\(/,
    );
  });

  test("the four command names are completely unchanged", () => {
    const commands = rustFile("commands.rs");
    expect(extractTauriCommandNames(commands).sort()).toEqual([
      ...tsCommandNames(),
    ].sort());
  });

  test("the reserved turn event name is unchanged", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toContain(tsEventNames()[0] ?? "agent_turn_event");
  });

  test("command parameter names are unchanged", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toMatch(
      /fn\s+agent_start_turn\s*\(\s*session_id:\s*String,\s*request:\s*Value/,
    );
    expect(commands).toMatch(
      /fn\s+agent_cancel_turn\s*\(\s*session_id:\s*String,\s*turn_id:\s*String/,
    );
  });

  test("agent_health stays decoupled from the backend", () => {
    const commands = rustFile("commands.rs");
    const healthStart = commands.indexOf("fn agent_health");
    // The health function body ends at its own closing brace; nothing after
    // it belongs to this command.
    const healthEnd = commands.indexOf("\n}", healthStart);
    const body = commands.slice(healthStart, healthEnd === -1 ? commands.length : healthEnd);
    expect(body).not.toContain("backend");
    expect(body).not.toContain("State<");
    expect(body).not.toContain("runtime");
  });
});
