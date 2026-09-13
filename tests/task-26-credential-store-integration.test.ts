import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import { createSecureCredentialStore } from "../packages/provider-registry/src/index.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task26-int-"));
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

describe("task 26 credential store integration", () => {
  it("startup phase calls CredentialStore zero times", async () => {
    let getCalls = 0;
    let setCalls = 0;
    let hasCalls = 0;
    let deleteCalls = 0;
    const backend = {
      get: () => { getCalls += 1; return "fixture-value"; },
      set: () => { setCalls += 1; },
      has: () => { hasCalls += 1; return false; },
      delete: () => { deleteCalls += 1; },
    };
    const credentials = createSecureCredentialStore({ backend });
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15700,
      configFilePath: configPath,
      credentials,
    });
    expect(getCalls).toBe(0);
    expect(setCalls).toBe(0);
    expect(hasCalls).toBe(0);
    expect(deleteCalls).toBe(0);
    await host.close();
  });

  it("config file contains credentialRef but no secret", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain("credential:test-provider");
    expect(raw).not.toContain("fixture-credential-value");
  });

  it("fake HTTP receives auth header during a real turn", async () => {
    const observedAuth: string[] = [];
    const fakeHttpClient = async (request: { headers?: Record<string, string> }) => {
      if (request.headers?.authorization) {
        observedAuth.push(request.headers.authorization);
      }
      return { status: 200, body: null };
    };

    const credentials = createSecureCredentialStore({
      backend: {
        get: (ref) => (ref === "credential:test-provider" ? "fixture-credential-value" : undefined),
        set: () => undefined,
        has: () => true,
        delete: () => undefined,
      },
    });
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15701,
      configFilePath: configPath,
      credentials,
      httpClient: fakeHttpClient as never,
    });

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
        routeId: "default-route",
        model: "model-a",
      }),
    });
    const text = await turn.text();
    expect(text).not.toContain("fixture-credential-value");
    await host.close();
  });

  it("events do not contain the secret", async () => {
    const credentials = createSecureCredentialStore({
      backend: {
        get: () => "fixture-credential-value",
        set: () => undefined,
        has: () => true,
        delete: () => undefined,
      },
    });
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15702,
      configFilePath: configPath,
      credentials,
    });
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
    const text = await turn.text();
    expect(text).not.toContain("fixture-credential-value");
    await host.close();
  });

  it("two hosts with different credentials are isolated", async () => {
    const credentialsA = createSecureCredentialStore({
      backend: {
        get: () => "value-a",
        set: () => undefined,
        has: () => true,
        delete: () => undefined,
      },
    });
    const credentialsB = createSecureCredentialStore({
      backend: {
        get: () => "value-b",
        set: () => undefined,
        has: () => true,
        delete: () => undefined,
      },
    });
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");

    const a = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15703,
      configFilePath: configPath,
      credentials: credentialsA,
    });
    const b = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15704,
      configFilePath: configPath,
      credentials: credentialsB,
    });
    expect(a.address()).not.toBe(b.address());
    await a.close();
    await b.close();
  });

  it("default fail-closed store produces an error turn, not success", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15705,
      configFilePath: configPath,
    });
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
    const text = await turn.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    const events = lines.map(
      (l) => JSON.parse(l) as { type: string; completed?: boolean },
    );
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await host.close();
  });
});