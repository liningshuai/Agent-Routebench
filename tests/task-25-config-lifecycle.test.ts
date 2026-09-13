import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task25-life-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const VALID_CONFIG = {
  version: 1,
  providers: [
    {
      id: "test-provider",
      name: "Test Provider",
      protocol: "openai_compatible",
      baseUrl: "https://api.example.invalid/v1",
      credentialRef: "credential:test-provider",
      models: ["model-a"],
      enabled: true,
    },
  ],
  routes: [
    {
      id: "default-route",
      name: "Default Route",
      providerId: "test-provider",
      model: "model-a",
      enabled: true,
    },
  ],
};

async function writeConfig(dir: string): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(VALID_CONFIG), "utf8");
  return path;
}

describe("task 25 config lifecycle", () => {
  it("host is running after successful config load", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15400,
      configFilePath: configPath,
    });
    expect(host.state()).toBe("running");
    await host.close();
    expect(host.state()).toBe("closed");
  });

  it("close is idempotent", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15401,
      configFilePath: configPath,
    });
    await host.close();
    await host.close();
    expect(host.state()).toBe("closed");
  });

  it("two hosts with the same config are isolated", async () => {
    const configPath = await writeConfig(tempDir);
    const a = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15402,
      configFilePath: configPath,
    });
    const b = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15403,
      configFilePath: configPath,
    });
    expect(a.address()).not.toBe(b.address());
    await a.close();
    expect(b.state()).toBe("running");
    await b.close();
  });

  it("port is released after close", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15404,
      configFilePath: configPath,
    });
    const address = host.address();
    await host.close();
    // After close, the port should be free for a new host.
    const host2 = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15404,
      configFilePath: configPath,
    });
    expect(host2.address()).toContain("127.0.0.1");
    await host2.close();
    void address;
  });

  it("address is undefined after close", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15405,
      configFilePath: configPath,
    });
    expect(host.address()).toBeDefined();
    await host.close();
    expect(host.address()).toBeUndefined();
  });

  it("health endpoint responds on a configured host", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15406,
      configFilePath: configPath,
    });
    const address = host.address();
    const response = await fetch(`${address}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    await host.close();
  });

  it("create session works on a configured host", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15407,
      configFilePath: configPath,
    });
    const address = host.address();
    const response = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      session: { id: string; status: string };
    };
    expect(body.session.status).toBe("idle");
    await host.close();
  });

  it("cancel on idle session returns not_running", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15408,
      configFilePath: configPath,
    });
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await created.json()) as { session: { id: string } };
    const cancel = await fetch(`${address}/v1/sessions/${session.id}/cancel`, {
      method: "POST",
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { code: string };
    expect(body.code).toBe("not_running");
    await host.close();
  });

  it("events endpoint returns empty array for new session", async () => {
    const configPath = await writeConfig(tempDir);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15409,
      configFilePath: configPath,
    });
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await created.json()) as { session: { id: string } };
    const events = await fetch(`${address}/v1/sessions/${session.id}/events`);
    expect(events.status).toBe(200);
    const body = (await events.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
    await host.close();
  });

  it("rejects a config with a route referencing a missing provider", async () => {
    const configPath = join(tempDir, "bad-route.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [],
        routes: [
          {
            id: "orphan-route",
            name: "Orphan",
            providerId: "missing-provider",
            model: "m1",
            enabled: true,
          },
        ],
      }),
      "utf8",
    );
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15410,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });
});
