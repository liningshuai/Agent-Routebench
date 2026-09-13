import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readRepoFile, REPO_ROOT } from "./helpers/tauri-native-fixtures.js";
import { createStartedTestHost } from "./helpers/local-agent-host-fixtures.js";
import { createLocalAgentHost } from "../apps/local-agent-host/src/index.js";

const HOST_SRC = "apps/local-agent-host/src";
const hostFile = (name: string): string => readRepoFile(`${HOST_SRC}/${name}`);

function hostPackageJson(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "apps/local-agent-host/package.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("Task 20: loopback-only boundary", () => {
  test("the listening address is always loopback", async () => {
    const { host, dispose } = await createStartedTestHost({ host: "localhost" });
    try {
      const address = host.address() ?? "";
      expect(
        address.startsWith("http://127.0.0.1") || address.startsWith("http://localhost"),
      ).toBe(true);
    } finally {
      await dispose();
    }
  });

  test("responses carry no CORS header", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await dispose();
    }
  });

  test("host source never opens outbound clients, sockets or subprocesses", () => {
    for (const file of ["host.ts", "main.ts", "validation.ts", "errors.ts", "types.ts", "index.ts"]) {
      const source = hostFile(file);
      for (const forbidden of [
        "node:http",
        "node:https",
        "node:net",
        "node:child_process",
        "axios",
        "undici",
        "WebSocket",
        "fetch(",
        "process.env",
        "exec(",
        "spawn(",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("host source never touches credentials, tokens or persistence", () => {
    for (const file of ["host.ts", "main.ts", "validation.ts", "errors.ts"]) {
      const source = hostFile(file).toLowerCase();
      for (const forbidden of [
        "credentialstore",
        "apikey",
        "api_key",
        "token",
        "authorization",
        "bearer",
        "writefile",
        "fs.write",
        "sqlite",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("the host package depends only on workspace packages and typescript", () => {
    const pkg = hostPackageJson();
    const dependencies = Object.keys((pkg.dependencies ?? {}) as Record<string, string>);
    const devDependencies = Object.keys((pkg.devDependencies ?? {}) as Record<string, string>);
    for (const name of dependencies) {
      expect(
        ["@agent-workbench/local-agent-api", "@agent-workbench/agent-core", "@agent-workbench/agent-backend"].includes(name),
        `unexpected dependency ${name}`,
      ).toBe(true);
    }
    for (const name of devDependencies) {
      expect(name, `unexpected dev dependency ${name}`).toBe("typescript");
    }
  });

  test("the local agent api server core file is not modified by this task", () => {
    // The host must reuse, not fork, the Task 9 server implementation.
    const server = readRepoFile("packages/local-agent-api/src/server.ts");
    expect(server).toContain("export function createLocalAgentApiServer");
  });
});

describe("Task 20: fixed error vocabulary", () => {
  test("every host error has a fixed code and a short static message", () => {
    const errors = hostFile("errors.ts");
    for (const code of [
      "invalid_options",
      "host_not_loopback",
      "invalid_port",
      "already_started",
      "start_failed",
      "close_failed",
      "runner_not_ready",
    ]) {
      expect(errors).toContain(code);
    }
    expect(errors).not.toContain("format(");
  });

  test("start failures never echo the underlying bind error", async () => {
    const first = await createStartedTestHost();
    try {
      const second = createLocalAgentHost({ port: first.port });
      const error = await second.start().then(
        () => null,
        (candidate: { message?: string }) => candidate,
      );
      expect(error).not.toBeNull();
      expect(error?.message).toBe("Local agent host failed to start.");
      expect(error?.message).not.toContain("EADDRINUSE");
      expect(second.state()).not.toBe("running");
    } finally {
      await first.dispose();
    }
  });
});

describe("Task 20: documentation boundary", () => {
  test("docs/tauri.md no longer describes the current backend as returning Result<serde_json::Value, HostError>", () => {
    const tauriDoc = readRepoFile("docs/tauri.md");
    expect(tauriDoc).not.toContain("Result<serde_json::Value, HostError>");
    expect(tauriDoc).toContain("command-specific typed response");
  });

  test("docs/tauri.md keeps the request-input carve-out explicit", () => {
    const tauriDoc = readRepoFile("docs/tauri.md");
    expect(tauriDoc).toContain("agent_start_turn");
  });
});
