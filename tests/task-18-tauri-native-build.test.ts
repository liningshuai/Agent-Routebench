import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CARGO_MANIFEST_PATH,
  DESKTOP_ROOT,
  REPO_ROOT,
  TAURI_ROOT,
  readRepoFile,
} from "./helpers/tauri-native-fixtures.js";

const DIST = join(DESKTOP_ROOT, "dist");
const CARGO_TIMEOUT = 20 * 60 * 1000;
const BUILD_TIMEOUT = 5 * 60 * 1000;

interface ExecResult {
  readonly code: number;
  readonly output: string;
}

/**
 * Rust build output lives at the repository root (git-ignored `target/`,
 * outside the security-scan roots). It must never be written under
 * apps/desktop/src-tauri because security:scan reads every file under
 * apps/ and the debug staticlib exceeds Node's string size limit.
 */
const CARGO_TARGET_DIR = join(REPO_ROOT, "target");

function run(command: string, cwd: string, timeout: number): ExecResult {
  try {
    const output = execSync(command, {
      cwd,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        CARGO_TARGET_DIR,
      },
    });
    return { code: 0, output: String(output ?? "") };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      output: `${String(err.stdout ?? "")}\n${String(err.stderr ?? "")}`,
    };
  }
}

function listRelativeFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listRelativeFiles(full, base));
    } else {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

let desktopBuilt = false;

function buildDesktop(): void {
  if (desktopBuilt) return;
  const result = run("corepack pnpm build:desktop", REPO_ROOT, BUILD_TIMEOUT);
  expect(result.code, `build:desktop failed:\n${result.output}`).toBe(0);
  desktopBuilt = true;
}

beforeAll(() => {
  buildDesktop();
});

afterAll(() => {
  // Built artifacts stay in place; the repository never commits dist or target.
});

describe("Task 18: Desktop build output", () => {
  test("corepack pnpm build:desktop produces dist/index.html", () => {
    expect(existsSync(join(DIST, "index.html"))).toBe(true);
  });

  test("dist/index.html loads ./tauri-entry.js as a module script", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    expect(html).toContain("./tauri-entry.js");
    expect(html).toContain('type="module"');
  });

  test("dist/index.html loads ./styles.css", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    expect(html).toContain("./styles.css");
  });

  test("dist contains tauri-entry.js and styles.css", () => {
    expect(existsSync(join(DIST, "tauri-entry.js"))).toBe(true);
    expect(existsSync(join(DIST, "styles.css"))).toBe(true);
  });

  test("dist exposes no source, tests, node_modules or .superpowers content", () => {
    const files = listRelativeFiles(DIST);
    for (const file of files) {
      expect(file.includes("node_modules"), file).toBe(false);
      expect(file.startsWith("src"), file).toBe(false);
      expect(file.includes(".superpowers"), file).toBe(false);
      expect(file.endsWith(".test.js"), file).toBe(false);
    }
  });

  test("every import specifier in built JS resolves locally (no bare specifiers)", () => {
    const files = listRelativeFiles(DIST).filter((file) => file.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(DIST, file), "utf8");
      for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("//")
        ) {
          continue; // JSDoc examples may reference package specifiers.
        }
        for (const match of line.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
          const specifier = match[1] ?? "";
          expect(
            specifier.startsWith("./") || specifier.startsWith("../"),
            `${file} still imports ${specifier}`,
          ).toBe(true);
        }
      }
    }
  });

  test("dist/index.html references no external origin", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    expect(html).not.toMatch(/src=["']https?:\/\//);
    expect(html).not.toMatch(/href=["']https?:\/\//);
  });
});

describe("Task 18: Rust host verification", () => {
  test("cargo check --manifest-path passes", () => {
    const result = run(
      `cargo check --manifest-path ${CARGO_MANIFEST_PATH}`,
      REPO_ROOT,
      CARGO_TIMEOUT,
    );
    expect(result.code).toBe(0);
  }, CARGO_TIMEOUT);

  test("cargo test --manifest-path passes", () => {
    const result = run(
      `cargo test --manifest-path ${CARGO_MANIFEST_PATH}`,
      REPO_ROOT,
      CARGO_TIMEOUT,
    );
    expect(result.code, `cargo test failed:\n${result.output}`).toBe(0);
  }, CARGO_TIMEOUT);

  test("tauri native build (debug, no bundle) completes", () => {
    const result = run(
      "corepack pnpm exec tauri build --debug --no-bundle",
      DESKTOP_ROOT,
      CARGO_TIMEOUT,
    );
    expect(result.code, `tauri build failed:\n${result.output}`).toBe(0);
  }, CARGO_TIMEOUT);

  test("Cargo.lock is present for reproducible Rust builds", () => {
    expect(existsSync(join(TAURI_ROOT, "Cargo.lock"))).toBe(true);
  });
});

describe("Task 18: build tooling wiring", () => {
  test("root build:desktop delegates to scripts/build-desktop.mjs", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:desktop"]).toContain("scripts/build-desktop.mjs");
  });

  test("apps/desktop declares the official Tauri dependencies", () => {
    const pkg = JSON.parse(readRepoFile("apps/desktop/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@tauri-apps/api"]).toMatch(/^\^?2\./);
    expect(pkg.devDependencies?.["@tauri-apps/cli"]).toMatch(/^\^?2\./);
  });

  test("scripts/build-desktop.mjs emits vendor assets only from official sources", () => {
    const script = readRepoFile("scripts/build-desktop.mjs");
    expect(script).toContain("@tauri-apps/api");
    expect(script).toContain("local-agent-client");
    expect(script).toContain("agent-core");
    expect(script).not.toContain("eval(");
    expect(script).not.toContain("child_process.exec(");
  });
});
