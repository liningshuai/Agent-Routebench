import { exec } from "node:child_process";
import { describe, expect, test } from "vitest";
import { CARGO_MANIFEST_PATH, REPO_ROOT, readRepoFile } from "./helpers/tauri-native-fixtures.js";

const rustFile = (name: string): string =>
  readRepoFile(`apps/desktop/src-tauri/src/${name}`);

async function runCargoTest(filter: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CARGO_TARGET_DIR;
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
    exec(
      `cargo test --manifest-path ${CARGO_MANIFEST_PATH} ${filter}`,
      { cwd: REPO_ROOT, timeout: 10 * 60 * 1000, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${String(stdout)}\n${String(stderr)}`;
        resolvePromise(
          output.includes(`0 failed`) && !output.includes("error[") ? 0 : 1,
        );
      },
    );
  });
}

describe("Task 19 response boundary: typed backend results", () => {
  test("the HostBackend trait no longer returns open serde_json::Value successes", () => {
    const backend = rustFile("backend.rs");
    const traitRegion = backend.slice(0, backend.indexOf("pub struct NotReadyBackend"));
    expect(traitRegion).not.toContain("Result<serde_json::Value");
    expect(traitRegion).toContain("Result<CreateSessionResponse, HostError>");
    expect(traitRegion).toContain("Result<StartTurnResponse, HostError>");
    expect(traitRegion).toContain("Result<CancelTurnResponse, HostError>");
  });

  test("the request input stays serde_json::Value on start_turn", () => {
    const backend = rustFile("backend.rs");
    expect(backend).toMatch(
      /start_turn\s*\(\s*&self,\s*session_id:\s*&str,\s*request:\s*&serde_json::Value/,
    );
  });

  test("CreateSessionResponse wraps exactly one session field", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(
      backend.indexOf("pub struct CreateSessionResponse"),
      backend.indexOf("pub struct StartTurnResponse"),
    );
    expect(region).toMatch(/pub struct CreateSessionResponse\s*\{[^}]*session:\s*HostSession[^}]*\}/s);
  });

  test("HostSession allows only the five contract fields", () => {
    const backend = rustFile("backend.rs");
    // Start from the enum so the serde attributes above the struct are included.
    const region = backend.slice(
      backend.indexOf("pub enum HostSessionStatus"),
      backend.indexOf("pub struct CreateSessionResponse"),
    );
    for (const field of ["id", "status", "created_at", "updated_at", "active_turn_id"]) {
      expect(region).toContain(field);
    }
    expect(region).toMatch(
      /skip_serializing_if\s*=\s*"Option::is_none"/,
    );
    expect(region).toMatch(/rename_all\s*=\s*"camelCase"/);
  });

  test("session status is a closed five-variant enum", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(
      backend.indexOf("pub enum HostSessionStatus"),
      backend.indexOf("pub struct HostSession"),
    );
    for (const variant of ["Idle", "Running", "Completed", "Cancelled", "Failed"]) {
      expect(region).toContain(variant);
    }
  });

  test("StartTurnResponse carries only turn_id", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(
      backend.indexOf("pub struct StartTurnResponse"),
      backend.indexOf("pub struct CancelTurnResponse"),
    );
    expect(region).toMatch(/pub struct StartTurnResponse\s*\{[^}]*turn_id:\s*String[^}]*\}/s);
    expect(region).not.toContain("session");
  });

  test("CancelTurnResponse carries only ok and is always true", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(backend.indexOf("pub struct CancelTurnResponse"));
    expect(region).toMatch(/pub struct CancelTurnResponse\s*\{[^}]*ok:\s*bool[^}]*\}/s);
    expect(region).toMatch(/ok:\s*true/);
  });

  test("response structs expose no public fields for Value-style assembly", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(
      backend.indexOf("pub enum HostSessionStatus"),
      backend.indexOf("pub trait HostBackend"),
    );
    // Response fields are private; only validated constructors build them.
    expect(region).not.toMatch(/pub\s+(?:id|status|created_at|updated_at|active_turn_id|turn_id|ok|session):/);
  });
});

describe("Task 19 response boundary: validated constructors and fixed errors", () => {
  test("constructors reject empty ids, non-finite times and empty turn ids", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(0, backend.indexOf("#[cfg(test)]"));
    expect(region).toMatch(/is_finite/);
    expect(region).toMatch(/is_empty/);
  });

  test("a fixed invalid_response error exists with a static message", () => {
    const errors = rustFile("errors.rs");
    expect(errors).toContain("invalid_response");
    expect(errors).toContain("Agent host response is invalid.");
  });

  test("success responses never embed credential or URL material", () => {
    const backend = rustFile("backend.rs");
    const region = backend.slice(0, backend.indexOf("#[cfg(test)]")).toLowerCase();
    for (const forbidden of [
      "apikey",
      "api_key",
      "token",
      "secret",
      "password",
      "authorization",
      "bearer",
      "credential",
      "provider",
      "http://",
      "https://",
    ]) {
      expect(region, `backend.rs must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("Task 19 response boundary: behavior unchanged", () => {
  test("NotReadyBackend still fails all three operations with host_not_ready", () => {
    const backend = rustFile("backend.rs");
    const implStart = backend.indexOf("impl HostBackend for NotReadyBackend");
    const implBody = backend.slice(implStart, backend.indexOf("#[cfg(test)]", implStart));
    expect(implBody.split("Err(HostError::host_not_ready())").length - 1).toBe(3);
    expect(implBody).not.toContain("Ok(");
  });

  test("command delegation and validation-before-backend order are preserved", () => {
    const commands = rustFile("commands.rs");
    expect(commands).toMatch(/runtime\s*\.\s*backend\s*\(\s*\)\s*\.\s*create_session\s*\(\s*\)/);
    expect(commands).toMatch(/runtime\s*\.\s*backend\s*\(\s*\)\s*\.\s*start_turn\s*\(/);
    expect(commands).toMatch(/runtime\s*\.\s*backend\s*\(\s*\)\s*\.\s*cancel_turn\s*\(/);
    const start = commands.indexOf("fn start_turn_checked");
    const region = commands.slice(start, commands.indexOf("\n}", start));
    const validateAt = region.indexOf("validate_start_turn_payload");
    const delegateAt = region.indexOf(".start_turn(");
    expect(validateAt).toBeGreaterThan(-1);
    expect(delegateAt).toBeGreaterThan(validateAt);
  });

  test("the input request is never echoed into a success response", () => {
    const backend = rustFile("backend.rs");
    // The trait keeps the request input; the response types must not.
    const responses = backend.slice(
      backend.indexOf("pub enum HostSessionStatus"),
      backend.indexOf("pub trait HostBackend"),
    );
    expect(responses).not.toContain("request");
  });

  test("agent_health still takes no state and reads no backend", () => {
    const commands = rustFile("commands.rs");
    const start = commands.indexOf("fn agent_health");
    const end = commands.indexOf("\n}", start);
    const body = commands.slice(start, end);
    expect(body).not.toContain("backend");
    expect(body).not.toContain("State<");
  });
});

describe("Task 19 response boundary: Rust behavioral evidence", () => {
  test("Rust unit tests pin the exact serialized JSON of all three responses", () => {
    const backend = rustFile("backend.rs");
    const tests = backend.slice(backend.indexOf("#[cfg(test)]"));
    for (const marker of [
      "create_session_response_serializes_exactly",
      "start_turn_response_serializes_exactly",
      "cancel_turn_response_serializes_exactly",
      "host_session_serializes_exactly_and_omits_unset_active_turn",
      "host_session_rejects_empty_id_and_non_finite_times",
      "start_turn_response_rejects_empty_turn_id",
    ]) {
      expect(tests).toContain(marker);
    }
  });

  test("cargo test backend::tests passes with the typed responses", async () => {
    expect(await runCargoTest("backend::tests")).toBe(0);
  }, 10 * 60 * 1000);
});
