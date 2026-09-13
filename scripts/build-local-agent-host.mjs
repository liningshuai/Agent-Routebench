// Builds the Node Local Agent Host as a self-contained native ESM resource.
// The Tauri host can therefore launch the resource without relying on the
// repository's workspace symlinks or exposing source files in the bundle.

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(repoRoot, "apps", "local-agent-host");
const distDir = join(appDir, "dist");
const stagingDir = join(appDir, "dist-staging");
const rawVendorDir = join(stagingDir, "vendor", "raw");

const PACKAGE_ENTRIES = [
  ["agent-contracts", "packages/agent-contracts/src/index.ts"],
  ["agent-core", "packages/agent-core/src/index.ts"],
  ["agent-runtime", "packages/agent-runtime/src/index.ts"],
  ["model-gateway", "packages/model-gateway/src/index.ts"],
  ["provider-registry", "packages/provider-registry/src/index.ts"],
  ["local-agent-api", "packages/local-agent-api/src/index.ts"],
  ["agent-backend", "packages/agent-backend/src/index.ts"],
  ["local-persistence", "packages/local-persistence/src/index.ts"],
];

function run(command, cwd) {
  console.log(`build:local-agent-host run: ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function compileHost() {
  run(
    'corepack pnpm exec tsc -p tsconfig.json --outDir "dist-staging"',
    appDir,
  );
}

function compileWorkspacePackages() {
  mkdirSync(rawVendorDir, { recursive: true });
  const entries = PACKAGE_ENTRIES.map(([, entry]) => entry).join(" ");
  run(
    `corepack pnpm exec tsc ${entries} --outDir "apps/local-agent-host/dist-staging/vendor/raw" ` +
      "--target es2022 --module nodenext --moduleResolution nodenext " +
      "--strict --skipLibCheck --esModuleInterop",
    repoRoot,
  );

  for (const [name] of PACKAGE_ENTRIES) {
    const source = join(rawVendorDir, name, "src");
    const target = join(stagingDir, "vendor", name, "src");
    if (!existsSync(source)) {
      throw new Error(`sidecar vendor compilation did not emit ${name}`);
    }
    // Relocate instead of copy+delete. The raw dump is a byproduct of a single
    // multi-entry tsc run; moving each compiled `src` subtree leaves only empty
    // directories behind, so the cleanup below stays a bounded delete instead
    // of depending on one large recursive removal.
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
  }
  removeQuietly(rawVendorDir);
}

function importPath(fromDirectory, targetFile) {
  const path = relative(fromDirectory, targetFile).split("\\").join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function rewriteWorkspaceImports() {
  const targets = new Map(
    PACKAGE_ENTRIES.map(([name]) => [
      `@agent-workbench/${name}`,
      join(stagingDir, "vendor", name, "src", "index.js"),
    ]),
  );
  const files = listFiles(stagingDir).filter((file) => file.endsWith(".js"));
  for (const file of files) {
    let source = readFileSync(file, "utf8");
    for (const [specifier, target] of targets) {
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `(\\bfrom\\s*|\\bimport\\s*\\(\\s*)(["'])${escaped}\\2`,
        "g",
      );
      source = source.replace(
        pattern,
        `$1$2${importPath(dirname(file), target)}$2`,
      );
    }
    writeFileSync(file, source);
  }
}

function assertNoBareImportsRemain() {
  const offenders = [];
  for (const file of listFiles(stagingDir)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(file, "utf8");
    for (const line of source.split(/\r?\n/)) {
      if (line.trimStart().startsWith("//")) continue;
      for (const match of line.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (
          !specifier.startsWith("./") &&
          !specifier.startsWith("../") &&
          !specifier.startsWith("node:")
        ) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`unresolved sidecar imports:\n${offenders.join("\n")}`);
  }
}

function writeRuntimePackageMetadata() {
  writeFileSync(
    join(stagingDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
}

/**
 * Best-effort recursive delete. A transient output directory that cannot be
 * removed (interrupted run, locked file, platform restriction) must never
 * fail a build whose real result is already in place.
 */
function removeQuietly(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leftover transient directories are git-ignored and cleaned up on the
    // next run; the swapped-in dist stays valid either way.
  }
}

/**
 * Removes staging/retiring leftovers from earlier interrupted runs.
 * Only ever touches the build's own transient directories.
 */
function cleanupStaleOutputs() {
  let entries;
  try {
    entries = readdirSync(appDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "dist-staging" || entry.startsWith("dist-retiring")) {
      removeQuietly(join(appDir, entry));
    }
  }
}

function main() {
  if (!existsSync(join(appDir, "src"))) {
    throw new Error("local-agent-host source directory is missing");
  }
  cleanupStaleOutputs();
  rmSync(stagingDir, { recursive: true, force: true });
  compileHost();
  compileWorkspacePackages();
  rewriteWorkspaceImports();
  assertNoBareImportsRemain();
  writeRuntimePackageMetadata();
  // Atomic swap: the outgoing dist is moved to a unique retiring name so a
  // leftover from an interrupted run can never block a later build, and its
  // removal is best-effort. Concurrent readers never see a missing dist.
  const retiringDir = `${distDir}-retiring-${process.pid}-${Date.now()}`;
  if (existsSync(distDir)) {
    renameSync(distDir, retiringDir);
  }
  renameSync(stagingDir, distDir);
  removeQuietly(retiringDir);
  cleanupStaleOutputs();
  console.log("build:local-agent-host wrote a self-contained dist resource");
}

main();
