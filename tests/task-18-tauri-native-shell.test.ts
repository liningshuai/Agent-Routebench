import { describe, expect, test } from "vitest";
import {
  ALLOWED_CAPABILITY_PERMISSIONS,
  BROWSER_PREVIEW_PATH,
  CAPABILITIES_PATH,
  DANGEROUS_PERMISSION_MARKERS,
  PUBLIC_INDEX_PATH,
  REQUIRED_CSP_DIRECTIVES,
  REPO_ROOT,
  TAURI_CONFIG_PATH,
  TAURI_ENTRY_PATH,
  TAURI_LOOPBACK_ORIGINS,
  extractStaticImportSpecifiers,
  extractTauriCommandNames,
  loadCapabilities,
  loadTauriConfig,
  readRepoFile,
  repoFileExists,
  tsCommandNames,
  tsEventNames,
} from "./helpers/tauri-native-fixtures.js";
import { join } from "node:path";

describe("Task 18: Tauri native shell — tauri.conf.json", () => {
  test("tauri.conf.json exists and is valid JSON", () => {
    expect(() => loadTauriConfig()).not.toThrow();
  });

  test("productName is exactly 'Agent Routebench'", () => {
    expect(loadTauriConfig().productName).toBe("Agent Routebench");
  });

  test("identifier is the stable reverse-domain identifier", () => {
    const config = loadTauriConfig();
    expect(config.identifier).toBe("com.liningshuai.agentroutebench");
  });

  test("frontendDist points at the built Desktop static assets", () => {
    expect(loadTauriConfig().build?.frontendDist).toBe("../dist");
  });

  test("no remote devUrl is configured", () => {
    const devUrl = loadTauriConfig().build?.devUrl;
    expect(devUrl === undefined || devUrl === "").toBe(true);
  });

  test("window config matches the required geometry and label", () => {
    const windows = loadTauriConfig().app?.windows ?? [];
    expect(windows).toHaveLength(1);
    const win = windows[0] ?? {};
    expect(win.label).toBe("main");
    expect(win.title).toBe("Agent Routebench");
    expect(win.width).toBe(1440);
    expect(win.height).toBe(960);
    expect(win.minWidth).toBe(1024);
    expect(win.minHeight).toBe(700);
    expect(win.resizable).toBe(true);
  });

  test("CSP is present and locks default/script/style to 'self'", () => {
    const csp = loadTauriConfig().app?.security?.csp;
    expect(typeof csp).toBe("string");
    const directives = String(csp).split(";").map((part) => part.trim());
    for (const required of REQUIRED_CSP_DIRECTIVES) {
      const directive = directives.find((item) => item.startsWith(`${required} `));
      expect(directive, `CSP must contain ${required}`).toBeDefined();
      expect(directive?.split(/\s+/).slice(1)).toContain("'self'");
    }
  });

  test("CSP does not allow external resources or unsafe script execution", () => {
    const csp = String(loadTauriConfig().app?.security?.csp ?? "");
    const origins = csp.match(/https?:\/\/[^\s;'"]+/g) ?? [];
    for (const origin of origins) {
      expect(
        TAURI_LOOPBACK_ORIGINS.has(origin),
        `CSP must not allow external origin ${origin}`,
      ).toBe(true);
    }
    const scriptDirective = csp
      .split(";")
      .map((part) => part.trim())
      .find((item) => item.startsWith("script-src "));
    expect(scriptDirective).toBeDefined();
    expect(scriptDirective).not.toContain("unsafe-inline");
    expect(scriptDirective).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
  });
});

describe("Task 18: Tauri native shell — capabilities", () => {
  test("capabilities/default.json exists and is valid JSON", () => {
    expect(() => loadCapabilities()).not.toThrow();
  });

  test("capabilities apply only to the main window", () => {
    const capability = loadCapabilities();
    expect(capability.windows).toEqual(["main"]);
  });

  test("capabilities only enable allowlisted core permissions", () => {
    const permissions = loadCapabilities().permissions ?? [];
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) {
      expect(ALLOWED_CAPABILITY_PERMISSIONS.has(permission), permission).toBe(true);
    }
  });

  test("capabilities contain no dangerous permission markers", () => {
    const permissions = (loadCapabilities().permissions ?? []).join(" ");
    for (const marker of DANGEROUS_PERMISSION_MARKERS) {
      expect(permissions.toLowerCase()).not.toContain(marker);
    }
  });

  test("capabilities allow no remote URLs or local file access patterns", () => {
    const raw = readRepoFile(CAPABILITIES_PATH);
    expect(raw).not.toContain("http://");
    expect(raw).not.toContain("https://");
    expect(raw.toLowerCase()).not.toContain("remote");
  });
});

describe("Task 18: Tauri native shell — command contract", () => {
  const commandSources = [
    "apps/desktop/src-tauri/src/commands.rs",
    "apps/desktop/src-tauri/src/lib.rs",
  ];

  test("Rust host defines exactly the four fixed commands", () => {
    const rustCommands = extractTauriCommandNames(readRepoFile(commandSources[0]!));
    expect(rustCommands.sort()).toEqual([...tsCommandNames()].sort());
  });

  test("each fixed command is registered exactly once in invoke_handler", () => {
    const lib = readRepoFile(commandSources[1]!);
    for (const name of tsCommandNames()) {
      const occurrences = lib.split(name).length - 1;
      expect(occurrences, `${name} must be registered exactly once`).toBe(1);
    }
  });

  test("Rust command names match the TypeScript contract without spelling drift", () => {
    const rustCommands = extractTauriCommandNames(readRepoFile(commandSources[0]!));
    const tsCommands = tsCommandNames();
    expect(rustCommands).toHaveLength(tsCommands.length);
    for (const name of tsCommands) {
      expect(rustCommands).toContain(name);
    }
  });

  test("the fixed turn event name exists in the Rust host as a constant", () => {
    const rustSource = [
      readRepoFile(commandSources[0]!),
      readRepoFile(commandSources[1]!),
    ].join("\n");
    expect(rustSource).toContain(tsEventNames()[0] ?? "agent_turn_event");
  });

  test("no duplicate command contract exists in the desktop package", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    for (const name of tsCommandNames()) {
      expect(entry.includes(`"${name}"`), `${name} must come from the shared contract`).toBe(
        false,
      );
    }
  });
});

describe("Task 18: Tauri native shell — frontend entry", () => {
  test("tauri-entry.ts exists", () => {
    expect(repoFileExists(TAURI_ENTRY_PATH)).toBe(true);
  });

  test("tauri-entry imports invoke from the official @tauri-apps/api/core", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    expect(entry).toMatch(/import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["']/);
  });

  test("tauri-entry imports listen from the official @tauri-apps/api/event", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    expect(entry).toMatch(/import\s*\{[^}]*\blisten\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/event["']/);
  });

  test("tauri-entry builds the client through the Task 17 bridge factory", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    expect(entry).toContain("createTauriDesktopApiClient");
  });

  test("tauri-entry mounts the existing Desktop UI", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    expect(
      entry.includes("mountDesktopUi") || entry.includes("bootstrapDesktopUi"),
    ).toBe(true);
  });

  test("tauri-entry implements no second IPC contract", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    const specifiers = extractStaticImportSpecifiers(entry);
    const foreign = specifiers.filter(
      (specifier) =>
        !specifier.startsWith("./") &&
        !specifier.startsWith("../") &&
        !specifier.startsWith("@tauri-apps/"),
    );
    expect(foreign).toEqual([]);
  });

  test("tauri-entry never touches provider or persistence packages directly", () => {
    const entry = readRepoFile(TAURI_ENTRY_PATH);
    for (const forbidden of [
      "model-gateway",
      "provider-registry",
      "session-persistence",
    ]) {
      expect(entry).not.toContain(forbidden);
    }
  });

  test("the browser preview entry is preserved for plain browser use", () => {
    const publicIndex = readRepoFile(PUBLIC_INDEX_PATH);
    expect(publicIndex).toContain("../dist/browser-entry.js");
    expect(publicIndex).not.toContain("tauri-entry");
    expect(repoFileExists(BROWSER_PREVIEW_PATH)).toBe(true);
  });

  test("tauri-entry is not wired into the browser preview document", () => {
    const preview = readRepoFile(BROWSER_PREVIEW_PATH);
    expect(preview).not.toContain("tauri-entry");
  });
});

describe("Task 18: Tauri native shell — Rust error contract", () => {
  test("errors.rs defines the five fixed error codes", () => {
    const errors = readRepoFile("apps/desktop/src-tauri/src/errors.rs");
    for (const code of [
      "host_not_ready",
      "invalid_request",
      "invalid_session_id",
      "invalid_turn_id",
      "forbidden_field",
    ]) {
      expect(errors).toContain(code);
    }
  });

  test("errors.rs never formats dynamic content into messages", () => {
    const errors = readRepoFile("apps/desktop/src-tauri/src/errors.rs");
    expect(errors).not.toContain("format!(");
    expect(errors).not.toContain("file!");
    expect(errors).not.toContain("line!");
  });

  test("Rust host ships unit tests alongside the commands and validation", () => {
    for (const file of [
      "apps/desktop/src-tauri/src/commands.rs",
      "apps/desktop/src-tauri/src/validation.rs",
    ]) {
      expect(readRepoFile(file)).toContain("#[cfg(test)]");
    }
  });
});

describe("Task 18: Tauri native shell — project layout", () => {
  test("src-tauri project files exist", () => {
    for (const file of [
      "apps/desktop/src-tauri/Cargo.toml",
      "apps/desktop/src-tauri/build.rs",
      "apps/desktop/src-tauri/src/main.rs",
      "apps/desktop/src-tauri/src/lib.rs",
    ]) {
      expect(repoFileExists(file), file).toBe(true);
    }
  });

  test("main.rs keeps the window subsystem hidden in release builds", () => {
    const main = readRepoFile("apps/desktop/src-tauri/src/main.rs");
    expect(main).toContain("windows_subsystem");
  });

  test("lib.rs registers commands on the Tauri builder", () => {
    const lib = readRepoFile("apps/desktop/src-tauri/src/lib.rs");
    expect(lib).toContain("invoke_handler");
    expect(lib).toContain("tauri::generate_handler!");
  });

  test("bundle packaging stays disabled for the MVP", () => {
    const config = loadTauriConfig();
    expect(config.bundle?.active).toBe(false);
  });

  test("build entrypoint script exists at scripts/build-desktop.mjs", () => {
    expect(repoFileExists("scripts/build-desktop.mjs")).toBe(true);
  });

  test("tauri frontend assets live under apps/desktop", () => {
    const config = loadTauriConfig();
    const frontendDist = String(config.build?.frontendDist ?? "");
    expect(join(REPO_ROOT, "apps/desktop", frontendDist).startsWith(REPO_ROOT)).toBe(true);
  });
});
