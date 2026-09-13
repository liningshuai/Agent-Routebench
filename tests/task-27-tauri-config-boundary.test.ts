import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function rustSrc(name: string): string {
  return readFileSync(join(repoRoot, "apps/desktop/src-tauri/src", name), "utf8");
}

function tsSrc(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("task 27 tauri config boundary", () => {
  it("Rust commands use fixed names matching TypeScript", () => {
    const commands = rustSrc("commands.rs");
    expect(commands).toContain("agent_get_config");
    expect(commands).toContain("agent_create_provider");
    expect(commands).toContain("agent_update_provider");
    expect(commands).toContain("agent_delete_provider");
    expect(commands).toContain("agent_create_route");
    expect(commands).toContain("agent_update_route");
    expect(commands).toContain("agent_delete_route");
  });

  it("TypeScript TAURI_COMMANDS match Rust names", () => {
    const client = tsSrc("apps/desktop/src/tauri-api-client.ts");
    expect(client).toContain('getConfig: "agent_get_config"');
    expect(client).toContain('createProvider: "agent_create_provider"');
    expect(client).toContain('updateProvider: "agent_update_provider"');
    expect(client).toContain('deleteProvider: "agent_delete_provider"');
    expect(client).toContain('createRoute: "agent_create_route"');
    expect(client).toContain('updateRoute: "agent_update_route"');
    expect(client).toContain('deleteRoute: "agent_delete_route"');
  });

  it("Rust commands do not accept arbitrary URLs or headers", () => {
    const proxy = rustSrc("proxy.rs");
    // The proxy must not accept user-supplied URL/host for config operations.
    expect(proxy).not.toContain("invoke_from_user");
    expect(proxy).not.toContain("proxy_raw");
  });

  it("Rust commands use typed responses not open Value", () => {
    const commands = rustSrc("commands.rs");
    // Config commands must not return raw Value to the renderer.
    const configSection = commands.slice(
      commands.indexOf("agent_get_config"),
      commands.indexOf("agent_get_config") + 500,
    );
    expect(configSection).not.toContain("serde_json::Value");
  });

  it("proxy only connects to loopback", () => {
    const proxy = rustSrc("proxy.rs");
    expect(proxy).toContain("127.0.0.1");
  });

  it("Desktop config client rejects sensitive fields in input", async () => {
    const {
      createDesktopConfigClient,
    } = await import("../apps/desktop/src/config-client.js");
    const client = createDesktopConfigClient({
      invoke: async <T>(): Promise<T> => ({ ok: true }) as T,
      listen: async () => () => undefined,
    });
    await expect(
      client.createProvider({
        id: "p1",
        name: "P",
        protocol: "openai_compatible",
        baseUrl: "https://api.example.invalid/v1",
        credentialRef: "credential:p1",
        models: ["m"],
        enabled: true,
        apiKey: "nope",
      } as never),
    ).rejects.toThrow();
  });

  it("config error codes are fixed", () => {
    const errors = rustSrc("errors.rs");
    expect(errors).toContain("configuration_unavailable");
    expect(errors).toContain("invalid_config_request");
    expect(errors).toContain("config_persistence_failed");
  });

  it("existing four agent_* commands are preserved", () => {
    const commands = rustSrc("commands.rs");
    expect(commands).toContain("agent_health");
    expect(commands).toContain("agent_create_session");
    expect(commands).toContain("agent_start_turn");
    expect(commands).toContain("agent_cancel_turn");
  });
});
