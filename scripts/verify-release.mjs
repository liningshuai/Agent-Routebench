// Final release-readiness gate for Agent Routebench.
//
// This entry point exists so the whole acceptance surface can be re-run with
// one command. It performs no work of its own beyond sequencing the existing
// scripts and asserting the release invariants that a green test run alone
// does not prove:
//
//   1. the workspace layout and TypeScript build are intact,
//   2. both runnable entry points (Local Agent Host, Desktop) still build,
//   3. the full offline test suite, the secret scan and the deterministic
//      eval suite all pass,
//   4. the Rust host formats, checks and unit-tests,
//   5. the Rust build output never reappears under apps/desktop/src-tauri,
//   6. the working tree carries no unexpected untracked content.
//
// Every step propagates its real exit code: the script can never print a
// success line after a failing step.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

let failed = 0;

/**
 * Resolves how to re-invoke pnpm from inside a pnpm script.
 *
 * `npm_execpath` may point either at a JavaScript CLI (older pnpm / corepack
 * shim) or at a native executable (`pnpm-native.exe`). Passing a native binary
 * to `node` fails with ERR_UNKNOWN_FILE_EXTENSION, so the two shapes are
 * distinguished before spawning.
 */
function resolvePnpm() {
  const execpath = process.env.npm_execpath;
  if (typeof execpath === "string" && execpath.length > 0) {
    if (/\.(c?js|mjs)$/i.test(execpath)) {
      return { executable: process.execPath, prefix: [execpath] };
    }
    return { executable: execpath, prefix: [] };
  }
  return { executable: "pnpm", prefix: [] };
}

function report(label, result) {
  const status = result.status === 0 ? "ok  " : "FAIL";
  console.log(`[verify:release] ${status} ${label} (exit ${result.status ?? "signal"})`);
  if (result.status !== 0) {
    failed += 1;
  }
}

function runPnpm(label, args) {
  const { executable, prefix } = resolvePnpm();
  report(
    label,
    spawnSync(executable, [...prefix, ...args], { cwd: root, stdio: "inherit" }),
  );
}

function runBinary(label, executable, args) {
  report(label, spawnSync(executable, args, { cwd: root, stdio: "inherit" }));
}

const cargoManifest = join("apps", "desktop", "src-tauri", "Cargo.toml");

runPnpm("verify:layout", ["verify:layout"]);
runPnpm("typecheck", ["typecheck"]);
runPnpm("build:local-agent-host", ["build:local-agent-host"]);
runPnpm("build:desktop", ["build:desktop"]);
runPnpm("test", ["test"]);
runPnpm("security:scan", ["security:scan"]);
runPnpm("evals:deterministic", ["evals:deterministic"]);
runBinary("cargo fmt --check", "cargo", [
  "fmt",
  "--manifest-path",
  cargoManifest,
  "--",
  "--check",
]);
runBinary("cargo check", "cargo", ["check", "--manifest-path", cargoManifest]);
runBinary("cargo test --lib", "cargo", [
  "test",
  "--manifest-path",
  cargoManifest,
  "--lib",
]);

// ── Release invariants ───────────────────────────────────────────────────

function assertInvariant(label, condition) {
  console.log(`[verify:release] ${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) {
    failed += 1;
  }
}

assertInvariant(
  "apps/desktop/src-tauri/target must not exist",
  !existsSync(join(root, "apps", "desktop", "src-tauri", "target")),
);

const cargoConfig = readFileSync(join(root, ".cargo", "config.toml"), "utf8");
assertInvariant(
  '.cargo/config.toml pins target-dir to the repository root "target"',
  /target-dir\s*=\s*"target"/.test(cargoConfig),
);

const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status === 0) {
  const unexpected = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes(".superpowers/"));
  assertInvariant(
    "no unexpected untracked or modified files",
    unexpected.length === 0,
  );
  if (unexpected.length > 0) {
    for (const line of unexpected) {
      console.log(`[verify:release]      ${line}`);
    }
  }
} else {
  assertInvariant("git status is readable", false);
}

if (failed > 0) {
  console.error(`[verify:release] ${failed} step(s) failed.`);
  process.exit(1);
}

console.log("[verify:release] all release gates passed.");
