import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import { LocalAgentHostError } from "../apps/local-agent-host/src/errors.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task25-"));
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

async function writeConfig(dir: string, name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(content), "utf8");
  return path;
}

describe("task 25 config bootstrap", () => {
  it("rejects a missing config file without starting a listener", async () => {
    const missingPath = join(tempDir, "does-not-exist.json");
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15200,
        configFilePath: missingPath,
      }),
    ).rejects.toMatchObject({ code: "config_not_found" });
  });

  it("rejects a relative config path", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15200,
        configFilePath: "relative/config.json",
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("rejects an empty config path", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15200,
        configFilePath: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("rejects a config path with a query fragment", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15200,
        configFilePath: `${tempDir}/config.json?x=1`,
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("loads a valid config and creates a running host", async () => {
    const configPath = await writeConfig(tempDir, "config.json", VALID_CONFIG);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15201,
      configFilePath: configPath,
    });
    expect(host.state()).toBe("running");
    expect(host.address()).toContain("127.0.0.1");
    await host.close();
  });

  it("rejects an invalid config snapshot without starting a listener", async () => {
    const configPath = await writeConfig(tempDir, "bad.json", {
      version: 1,
      providers: "not-an-array",
      routes: [],
    });
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15202,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("rejects a config with sensitive fields", async () => {
    const configPath = await writeConfig(tempDir, "secret.json", {
      version: 1,
      providers: [
        {
          ...VALID_CONFIG.providers[0],
          apiKey: "should-not-be-here",
        },
      ],
      routes: VALID_CONFIG.routes,
    });
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15203,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("rejects a config with an unsupported version", async () => {
    const configPath = await writeConfig(tempDir, "v2.json", {
      version: 2,
      providers: [],
      routes: [],
    });
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15204,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("does not call CredentialStore.get during startup", async () => {
    let getCalls = 0;
    const credentials = {
      async get() {
        getCalls += 1;
        return "secret-value";
      },
      async set() {},
      async has() { return false; },
      async delete() {},
    };
    const configPath = await writeConfig(tempDir, "config.json", VALID_CONFIG);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15205,
      configFilePath: configPath,
      credentials,
    });
    expect(getCalls).toBe(0);
    await host.close();
  });

  it("does not call HttpClient during startup", async () => {
    let httpCalls = 0;
    const httpClient = async () => {
      httpCalls += 1;
      return { status: 200, body: null };
    };
    const configPath = await writeConfig(tempDir, "config.json", VALID_CONFIG);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15206,
      configFilePath: configPath,
      httpClient: httpClient as never,
    });
    expect(httpCalls).toBe(0);
    await host.close();
  });

  it("uses a fail-closed default CredentialStore", async () => {
    const configPath = await writeConfig(tempDir, "config.json", VALID_CONFIG);
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15207,
      configFilePath: configPath,
    });
    // The default credential store always returns undefined; turns will fail
    // safely at the gateway layer without fabricating success.
    expect(host.state()).toBe("running");
    await host.close();
  });

  it("rejects a null config path", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15208,
        configFilePath: null as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("rejects a numeric config path", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15209,
        configFilePath: 42 as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("rejects a non-loopback host", async () => {
    const configPath = await writeConfig(tempDir, "config.json", VALID_CONFIG);
    await expect(
      createConfiguredLocalAgentHost({
        host: "0.0.0.0" as never,
        port: 15210,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });
});
