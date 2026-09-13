import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfiguredLocalAgentHost } from "../apps/local-agent-host/src/configured-host.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
} from "./helpers/http-fixtures.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-task25-int-"));
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

describe("task 25 config integration", () => {
  it("uses the loaded route, injected credential and fake HTTP client for a turn", async () => {
    const configPath = join(tempDir, "working-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "configured-provider",
            name: "Configured Provider",
            protocol: "anthropic_messages",
            baseUrl: "https://provider.task25.invalid",
            credentialRef: "credential:configured",
            models: ["configured-model"],
            enabled: true,
          },
        ],
        routes: [
          {
            id: "configured-route",
            name: "Configured Route",
            providerId: "configured-provider",
            model: "configured-model",
            enabled: true,
          },
        ],
      }),
      "utf8",
    );
    const http = createScriptedHttpClient([
      anthropicSuccessResponse("configured-offline-response"),
    ]);
    let credentialReads = 0;
    const credentials = {
      async get(ref: string) {
        credentialReads += 1;
        expect(ref).toBe("credential:configured");
        return "fixture-credential-value";
      },
      async set() {},
      async has() {
        return true;
      },
      async delete() {},
    };

    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15610,
      configFilePath: configPath,
      credentials,
      httpClient: http.client,
    });

    try {
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
          routeId: "configured-route",
          model: "configured-model",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }),
      });
      const lines = (await turn.text()).split("\n").filter(Boolean);
      const events = lines.map((line) => JSON.parse(line) as { type: string; text?: string });

      expect(turn.status).toBe(200);
      expect(events.some((event) => event.type === "text_delta" && event.text === "configured-offline-response")).toBe(true);
      expect(events[events.length - 1]?.type).toBe("completed");
      expect(http.calls()).toBe(1);
      expect(credentialReads).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("full lifecycle: create session, start turn, get events", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15600,
      configFilePath: configPath,
    });
    const address = host.address();

    // Health
    const health = await fetch(`${address}/health`);
    expect(health.status).toBe(200);

    // The configured bootstrap must expose the same loaded registry through
    // the configuration bridge before any turn is started.
    const config = await fetch(`${address}/v1/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual(VALID_CONFIG);

    // Create session
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    // Start turn (will fail at gateway due to no real credential, but must
    // produce a safe error stream, not a hang or crash).
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
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const event = JSON.parse(line) as { type: string };
      expect(["error", "completed", "text_delta", "tool_call", "usage", "route_selected"]).toContain(
        event.type,
      );
    }

    // Events endpoint
    const events = await fetch(`${address}/v1/sessions/${session.id}/events`);
    expect(events.status).toBe(200);

    await host.close();
  });

  it("config with no providers and no routes starts successfully", async () => {
    const configPath = join(tempDir, "empty.json");
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, providers: [], routes: [] }),
      "utf8",
    );
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15601,
      configFilePath: configPath,
    });
    expect(host.state()).toBe("running");
    await host.close();
  });

  it("config with disabled provider starts successfully", async () => {
    const configPath = join(tempDir, "disabled.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "disabled-provider",
            name: "Disabled",
            protocol: "openai_compatible",
            baseUrl: "https://api.example.invalid/v1",
            credentialRef: null,
            models: ["m1"],
            enabled: false,
          },
        ],
        routes: [],
      }),
      "utf8",
    );
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15602,
      configFilePath: configPath,
    });
    expect(host.state()).toBe("running");
    await host.close();
  });

  it("config with multiple providers and routes loads correctly", async () => {
    const configPath = join(tempDir, "multi.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "provider-a",
            name: "Provider A",
            protocol: "openai_compatible",
            baseUrl: "https://a.example.invalid/v1",
            credentialRef: "credential:provider-a",
            models: ["model-a", "model-b"],
            enabled: true,
          },
          {
            id: "provider-b",
            name: "Provider B",
            protocol: "anthropic_messages",
            baseUrl: "https://b.example.invalid",
            credentialRef: "credential:provider-b",
            models: ["model-b"],
            enabled: true,
          },
        ],
        routes: [
          {
            id: "route-a",
            name: "Route A",
            providerId: "provider-a",
            model: "model-a",
            enabled: true,
          },
          {
            id: "route-b",
            name: "Route B",
            providerId: "provider-b",
            model: "model-b",
            enabled: true,
            fallbackProviderIds: ["provider-a"],
          },
        ],
      }),
      "utf8",
    );
    const host = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15603,
      configFilePath: configPath,
    });
    expect(host.state()).toBe("running");
    await host.close();
  });

  it("two sequential hosts on different ports work independently", async () => {
    const configPath = join(tempDir, "config.json");
    await writeFile(configPath, JSON.stringify(VALID_CONFIG), "utf8");

    const a = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15604,
      configFilePath: configPath,
    });
    expect(a.state()).toBe("running");
    await a.close();

    const b = await createConfiguredLocalAgentHost({
      host: "127.0.0.1",
      port: 15605,
      configFilePath: configPath,
    });
    expect(b.state()).toBe("running");
    await b.close();
  });
});
