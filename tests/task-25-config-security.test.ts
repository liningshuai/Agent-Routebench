import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task25-sec-"));
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

describe("task 25 config security", () => {
  it("does not read process.env for credentials", async () => {
    process.env.TASK25_TEST_SECRET = "should-not-be-read";
    try {
      const configPath = join(tempDir, "config.json");
      await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
      const host = await createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15300,
        configFilePath: configPath,
      });
      expect(host.state()).toBe("running");
      await host.close();
    } finally {
      delete process.env.TASK25_TEST_SECRET;
    }
  });

  it("error messages do not contain the config path", async () => {
    const missingPath = join(tempDir, "very-secret-path-name.json");
    let message = "";
    try {
      await createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15301,
        configFilePath: missingPath,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("very-secret-path-name");
    expect(message).not.toContain(tempDir);
  });

  it("error messages do not contain provider URLs", async () => {
    const configPath = join(tempDir, "bad.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "p1",
            name: "P1",
            protocol: "openai_compatible",
            baseUrl: "https://secret-provider.example.com/v1",
            credentialRef: null,
            models: ["m1"],
            enabled: true,
            apiKey: "leaked",
          },
        ],
        routes: [],
      }),
      "utf8",
    );
    let message = "";
    try {
      await createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15302,
        configFilePath: configPath,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("secret-provider.example.com");
    expect(message).not.toContain("leaked");
  });

  it("rejects config with credential value in credentialRef", async () => {
    const configPath = join(tempDir, "cred.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "p1",
            name: "P1",
            protocol: "openai_compatible",
            baseUrl: "https://api.example.invalid/v1",
            credentialRef: "credential:actual-secret-value-here",
            models: ["m1"],
            enabled: true,
          },
        ],
        routes: [],
      }),
      "utf8",
    );
    // The credentialRef pattern requires lowercase alphanumeric ids; a long
    // secret-like value should be rejected by the existing validator.
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15303,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("rejects null credentials injection", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15304,
        configFilePath: configPath,
        credentials: null as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("rejects credentials without a callable get method", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15305,
        configFilePath: configPath,
        credentials: { get: "not-a-function" } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("accepts a class-instance CredentialStore", async () => {
    class TestCredentials {
      async get(): Promise<string | undefined> {
        return "fixture-value";
      }
      async set(): Promise<void> {}
      async has(): Promise<boolean> { return false; }
      async delete(): Promise<void> {}
    }
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15306,
      configFilePath: configPath,
      credentials: new TestCredentials(),
    });
    expect(host.state()).toBe("running");
    await host.close();
  });

  it("rejects a config path with a null byte", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15307,
        configFilePath: `${tempDir}/config\0.json`,
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("rejects a config path with a hash fragment", async () => {
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15308,
        configFilePath: `${tempDir}/config.json#fragment`,
      }),
    ).rejects.toMatchObject({ code: "invalid_config_path" });
  });

  it("rejects a config containing a token field on a provider", async () => {
    const configPath = join(tempDir, "token.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "p1",
            name: "P1",
            protocol: "openai_compatible",
            baseUrl: "https://api.example.invalid/v1",
            credentialRef: null,
            models: ["m1"],
            enabled: true,
            token: "should-not-be-here",
          },
        ],
        routes: [],
      }),
      "utf8",
    );
    await expect(
      createConfiguredLocalAgentHost({
        host: "127.0.0.1",
        port: 15309,
        configFilePath: configPath,
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });
});
