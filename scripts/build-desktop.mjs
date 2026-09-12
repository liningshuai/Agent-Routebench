// Deterministic Desktop build for the Tauri native shell.
//
// Output layout (apps/desktop/dist):
//   index.html          built page loading ./tauri-entry.js (module)
//   tauri-entry.js      compiled Tauri entry point
//   *.js                compiled Desktop renderer modules
//   styles.css          copied from public/
//   vendor/             vendored runtime modules the entry imports
//
// The build never bundles. It compiles TypeScript to native ESM and rewrites
// the few bare module specifiers to vendored files so the Tauri webview can
// resolve everything same-origin. Vendor sources are limited to the official
// @tauri-apps/api runtime files and the workspace packages the Desktop
// renderer imports at runtime. Nothing else from node_modules, src or tests
// is exposed to the webview.

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(repoRoot, "apps/desktop");
const distDir = join(desktopDir, "dist");
const publicDir = join(desktopDir, "public");
const tauriApiDir = join(desktopDir, "node_modules/@tauri-apps/api");

const VENDOR_DIR = "vendor";

/** Bare specifier -> file inside apps/desktop/dist. */
const VENDOR_MAP = new Map([
  ["@tauri-apps/api/core", "vendor/@tauri-apps/api/core.js"],
  ["@tauri-apps/api/event", "vendor/@tauri-apps/api/event.js"],
  [
    "@agent-workbench/agent-core",
    "vendor/@agent-workbench/agent-core/index.js",
  ],
  [
    "@agent-workbench/agent-contracts",
    "vendor/@agent-workbench/agent-contracts/index.js",
  ],
  [
    "@agent-workbench/local-agent-client",
    "vendor/@agent-workbench/local-agent-client/index.js",
  ],
]);

/** Runtime files vendored from the official @tauri-apps/api package. */
const TAURI_API_FILES = [
  "core.js",
  "event.js",
  "external/tslib/tslib.es6.js",
];

function run(command, cwd) {
  console.log(`build:desktop run: ${command}`);
  try {
    execSync(command, { cwd, stdio: "inherit" });
  } catch (error) {
    console.error(`build:desktop command failed in ${cwd}: ${error.message}`);
    throw error;
  }
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Synchronous byte copy implemented with plain fs calls. fs.cpSync crashes
 * this Node/Windows combination (exit 0xC0000409), so the build never uses it.
 */
function copyTree(from, to) {
  for (const file of listFiles(from)) {
    const target = join(to, relative(from, file));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file));
  }
}

function toImportPath(fromDir, targetFile) {
  const rel = relative(fromDir, targetFile).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function assertCleanSlate() {
  for (const dir of [desktopDir, publicDir]) {
    if (!existsSync(dir)) {
      throw new Error(`missing expected directory: ${dir}`);
    }
  }
  if (!existsSync(tauriApiDir)) {
    throw new Error(
      "apps/desktop must declare @tauri-apps/api; run corepack pnpm install",
    );
  }
}

function compileDesktop() {
  console.log("build:desktop compiling renderer");
  run("corepack pnpm exec tsc -p tsconfig.json", desktopDir);
}

function compileVendorPackages() {
  console.log("build:desktop compiling vendor runtime packages");
  const rawOut = join(distDir, VENDOR_DIR, "raw");
  const entries = [
    "packages/local-agent-client/src/index.ts",
    "packages/agent-core/src/index.ts",
    "packages/agent-contracts/src/index.ts",
  ].join(" ");
  run(
    `corepack pnpm exec tsc ${entries} --outDir "apps/desktop/dist/vendor/raw" ` +
      "--target es2022 --module nodenext --moduleResolution nodenext " +
      "--strict --skipLibCheck --esModuleInterop",
    repoRoot,
  );
  for (const name of ["agent-core", "agent-contracts", "local-agent-client"]) {
    const from = join(rawOut, name, "src");
    const to = join(distDir, "vendor", "@agent-workbench", name);
    if (!existsSync(from)) {
      throw new Error(`vendor compilation did not emit ${name}`);
    }
    copyTree(from, to);
  }
  rmSync(rawOut, { recursive: true, force: true });
  console.log("build:desktop vendored workspace runtime packages");
}

function vendorTauriApi() {
  console.log("build:desktop vendoring official @tauri-apps/api runtime");
  const target = join(distDir, "vendor", "@tauri-apps", "api");
  mkdirSync(target, { recursive: true });
  for (const file of TAURI_API_FILES) {
    const from = join(tauriApiDir, file);
    if (!existsSync(from)) {
      throw new Error(`@tauri-apps/api is missing ${file}`);
    }
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
}

function rewriteBareImports() {
  const jsFiles = listFiles(distDir).filter((file) => file.endsWith(".js"));
  for (const file of jsFiles) {
    let source = readFileSync(file, "utf8");
    let changed = false;
    for (const [specifier, target] of VENDOR_MAP) {
      const importPath = toImportPath(dirname(file), join(distDir, target));
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*)("|')${escaped}\\2`, "g");
      const replacement = `$1$2${importPath}$2`;
      const next = source.replace(pattern, replacement);
      if (next !== source) {
        changed = true;
        source = next;
      }
    }
    if (changed) {
      writeFileSync(file, source);
    }
  }
}

function assertNoBareImportsRemain() {
  const offenders = [];
  for (const file of listFiles(distDir)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(file, "utf8");
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
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `unresolved bare imports remain in dist:\n${offenders.join("\n")}`,
    );
  }
}

function writeIndexHtml() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src ipc: http://ipc.localhost">
  <title>Agent Routebench</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./tauri-entry.js"></script>
</body>
</html>
`;
  writeFileSync(join(distDir, "index.html"), html);
}

function copyStaticAssets() {
  const target = join(distDir, "styles.css");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(publicDir, "styles.css")));
}

function main() {
  assertCleanSlate();
  console.log("build:desktop cleaning dist");
  rmSync(distDir, { recursive: true, force: true });
  compileDesktop();
  compileVendorPackages();
  vendorTauriApi();
  console.log("build:desktop rewriting bare imports to vendored files");
  rewriteBareImports();
  assertNoBareImportsRemain();
  writeIndexHtml();
  copyStaticAssets();
  console.log("build:desktop wrote apps/desktop/dist (native ESM + vendor)");
}

main();
