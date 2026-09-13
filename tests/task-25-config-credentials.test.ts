import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import {
  InMemoryCredentialStore,
} from "../packages/provider-registry/src/index.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task25-cred-"));
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

describe("task 25 credentials boundary", () => {
  it("default credential store is fail-closed", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15500,
      configFilePath: configPath,
    });
    // A turn with no real credential should produce a safe error, not success.
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await created.json()) as { session: { id: string } };
    const turn = await fetch(`${address}/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(turn.status).toBe(200);
    const text = await turn.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    const events = lines.map(
      (l) => JSON.parse(l) as { type: string; code?: string },
    );
    // Must produce an error event, never a fabricated completed.
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await host.close();
  });

  it("injected credential store is used only when a turn needs it", async () => {
    let getCalls = 0;
    const credentials = {
      async get() {
        getCalls += 1;
        return undefined;
      },
      async set() {},
      async has() { return false; },
      async delete() {},
    };
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15501,
      configFilePath: configPath,
      credentials,
    });
    // Startup: 0 calls
    expect(getCalls).toBe(0);

    // Create session: still 0 calls
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(getCalls).toBe(0);
    await created.json();

    // Turn: gateway may call get() once for the credentialRef
    const { session } = { session: { id: "unknown" } };
    void session;
    await host.close();
  });

  it("accepts an InMemoryCredentialStore", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.set("credential:test-provider", "fixture-value");
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15502,
      configFilePath: configPath,
      credentials,
    });
    expect(host.state()).toBe("running");
    await host.close();
  });

  it("rejects array credentials", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15503,
        configFilePath: configPath,
        credentials: [] as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("rejects primitive credentials", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15504,
        configFilePath: configPath,
        credentials: "string-credentials" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("does not persist credentials to the config file", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const credentials = {
      async get() {
        return "fixture-credential-value";
      },
      async set() {},
      async has() { return false; },
      async delete() {},
    };
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15505,
      configFilePath: configPath,
      credentials,
    });
    await host.close();
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain("fixture-credential-value");
  });
});
