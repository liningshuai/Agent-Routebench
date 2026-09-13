import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("Task 23 Tauri sidecar integration", () => {
  it("constructs and owns a NodeHostSupervisor during Tauri setup", () => {
    const source = readRepoFile("apps/desktop/src-tauri/src/lib.rs");

    expect(source).toContain("NodeHostSupervisor");
    expect(source).toContain("SidecarLaunchConfig");
    expect(source).toContain(".setup(");
    expect(source).toContain("app.manage(supervisor)");
  });

  it("stops the sidecar when the Tauri application exits", () => {
    const source = readRepoFile("apps/desktop/src-tauri/src/lib.rs");

    expect(source).toContain("RunEvent::Exit");
    expect(source).toContain("supervisor.stop()");
  });

  it("ships a real local-agent-host entry for the native supervisor", () => {
    const packageJson = JSON.parse(
      readRepoFile("apps/local-agent-host/package.json"),
    ) as { scripts?: Record<string, string>; exports?: Record<string, string> };

    expect(packageJson.scripts?.build).toBeDefined();
    expect(packageJson.scripts?.start).toBe("node dist/main.js");
    expect(packageJson.exports?.["./main"]).toBe("./dist/main.js");

    const mainSource = readRepoFile("apps/local-agent-host/src/main.ts");
    expect(mainSource).toContain("process.argv[1]");
    expect(mainSource).toContain("runLocalAgentHostMain()");
    expect(mainSource).toContain("process.exitCode = exitCode");
  });

  it("declares the sidecar script as a Tauri resource", () => {
    const config = JSON.parse(
      readRepoFile("apps/desktop/src-tauri/tauri.conf.json"),
    ) as { bundle?: { resources?: unknown } };

    expect(JSON.stringify(config.bundle?.resources)).toContain(
      "../../local-agent-host/dist",
    );
  });

  it("does not leave child output pipes capable of blocking the supervisor", () => {
    const source = readRepoFile("apps/desktop/src-tauri/src/sidecar.rs");

    expect(source).toContain(".stdout(Stdio::null())");
    expect(source).toContain(".stderr(Stdio::null())");
  });

  it("keeps the renderer on the validated Tauri IPC bridge", () => {
    const source = readRepoFile("apps/desktop/src/tauri-entry.ts");

    expect(source).toContain("createTauriDesktopApiClient({ invoke, listen })");
    expect(source).toMatch(/mountDesktopUi\(container, client(?:, configClient)?\)/);
  });

  it("builds a self-contained ESM sidecar resource", () => {
    const packageJson = JSON.parse(
      readRepoFile("apps/local-agent-host/package.json"),
    ) as { scripts?: Record<string, string> };
    const buildScript = readRepoFile("scripts/build-local-agent-host.mjs");

    expect(packageJson.scripts?.build).toBe(
      "node ../../scripts/build-local-agent-host.mjs",
    );
    expect(buildScript).toContain("vendor");
    expect(buildScript).toContain("assertNoBareImportsRemain");
    expect(buildScript).toContain('type: "module"');
  });
});
