import { exec } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import {
  CARGO_MANIFEST_PATH,
  DESKTOP_ROOT,
  REPO_ROOT,
} from "./helpers/tauri-native-fixtures.js";

const CARGO_TIMEOUT = 20 * 60 * 1000;
const BUILD_TIMEOUT = 10 * 60 * 1000;
const STALE_NATIVE_TARGET = join(DESKTOP_ROOT, "src-tauri", "target");
const ROOT_TARGET = join(REPO_ROOT, "target");

interface ExecResult {
  readonly code: number;
  readonly output: string;
}

interface BuildState {
  readonly steps: Record<string, ExecResult>;
  readonly desktopBuilt: boolean;
}

/**
 * Runs a command with `CARGO_TARGET_DIR` explicitly REMOVED from the
 * environment: the repository-level `.cargo/config.toml` must alone decide
 * where build output goes, without any shell-local temporary setting.
 *
 * Uses async `exec` (not execSync) so the vitest worker keeps answering RPC
 * pings while the heavy native build runs.
 */
async function runWithoutCargoEnv(
  command: string,
  cwd: string,
  timeout: number,
): Promise<ExecResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  return new Promise((resolvePromise) => {
    exec(
      command,
      { cwd, timeout, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolvePromise({ code, output: `${String(stdout)}\n${String(stderr)}` });
      },
    );
  });
}

let state: BuildState | undefined;

beforeAll(async () => {
  rmSync(STALE_NATIVE_TARGET, { recursive: true, force: true });
  const desktop = await runWithoutCargoEnv("corepack pnpm build:desktop", REPO_ROOT, BUILD_TIMEOUT);
  // The repository-level Cargo config is the prerequisite for every native
  // build step below; without it the whole file reports the gap honestly.
  const config = readFileSync(join(REPO_ROOT, ".cargo", "config.toml"), "utf8");
  if (!config.includes('target-dir = "target"')) {
    throw new Error(".cargo/config.toml must pin target-dir = \"target\"");
  }
  const check = await runWithoutCargoEnv(
    `cargo check --manifest-path ${CARGO_MANIFEST_PATH}`,
    REPO_ROOT,
    CARGO_TIMEOUT,
  );
  const test = await runWithoutCargoEnv(
    `cargo test --manifest-path ${CARGO_MANIFEST_PATH}`,
    REPO_ROOT,
    CARGO_TIMEOUT,
  );
  const nativeBuild = await runWithoutCargoEnv(
    "corepack pnpm exec tauri build --no-bundle",
    DESKTOP_ROOT,
    CARGO_TIMEOUT,
  );
  const scan = await runWithoutCargoEnv("corepack pnpm security:scan", REPO_ROOT, BUILD_TIMEOUT);
  state = {
    steps: { desktop, check, test, nativeBuild, scan },
    desktopBuilt: existsSync(join(DESKTOP_ROOT, "dist", "index.html")),
  };
}, CARGO_TIMEOUT);

describe("Task 19: repository-level Cargo target directory", () => {
  test(".cargo/config.toml exists and pins target-dir to the repository root", () => {
    expect(existsSync(join(REPO_ROOT, ".cargo", "config.toml"))).toBe(true);
    const config = readFileSync(join(REPO_ROOT, ".cargo", "config.toml"), "utf8");
    expect(config).toContain("[build]");
    expect(config).toContain('target-dir = "target"');
  });

  test("the repository root target/ directory is git-ignored", async () => {
    const check = await runWithoutCargoEnv("git check-ignore target", REPO_ROOT, 30_000);
    expect(check.code).toBe(0);
  });

  test("cargo commands resolve the target directory without CARGO_TARGET_DIR", () => {
    const result = state?.steps.check ?? { code: 1, output: "not run" };
    expect(result.code, `cargo check failed:\n${result.output}`).toBe(0);
    expect(existsSync(join(ROOT_TARGET, "debug"))).toBe(true);
  });

  test("native build output never reappears under src-tauri", () => {
    expect(existsSync(STALE_NATIVE_TARGET)).toBe(false);
  });

  test("cargo test passes with the runtime boundary", () => {
    const result = state?.steps.test ?? { code: 1, output: "not run" };
    expect(result.code, `cargo test failed:\n${result.output}`).toBe(0);
    expect(result.output).toMatch(/test result: ok/);
  });

  test("tauri build from apps/desktop inherits the repository target directory", () => {
    const result = state?.steps.nativeBuild ?? { code: 1, output: "not run" };
    expect(result.code, `tauri build failed:\n${result.output}`).toBe(0);
    expect(existsSync(join(ROOT_TARGET, "release", "agent-routebench.exe"))).toBe(true);
    expect(existsSync(STALE_NATIVE_TARGET)).toBe(false);
  });

  test("security scan runs cleanly while build artifacts exist", () => {
    const result = state?.steps.scan ?? { code: 1, output: "not run" };
    expect(result.code, `security:scan failed:\n${result.output}`).toBe(0);
    expect(existsSync(join(ROOT_TARGET, "release", "agent-routebench.exe"))).toBe(true);
  });

  test("desktop build output remains intact for the Tauri frontend", () => {
    expect(state?.desktopBuilt ?? false).toBe(true);
  });
});
