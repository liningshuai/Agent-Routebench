import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";
import type { AgentEvent } from "../packages/agent-core/src/index.js";

const TEST_PORT = 14600;

describe("task 23 renderer data boundary", () => {
  it("turn events contain only safe AgentEvent fields", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
    await host.start();
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
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    });
    const text = await turn.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l) as AgentEvent);

    for (const event of events) {
      const allowed = new Set(["type", "requestId", "code", "message", "retryable"]);
      for (const key of Object.keys(event)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    await host.close();
  });

  it("session metadata contains only id, status, timestamps", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    await host.start();
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await created.json()) as { session: Record<string, unknown> };
    const allowed = new Set(["id", "status", "createdAt", "updatedAt", "activeTurnId"]);
    for (const key of Object.keys(body.session)) {
      expect(allowed.has(key)).toBe(true);
    }
    await host.close();
  });

  it("events query returns only sessionId and events", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 2 });
    await host.start();
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await created.json()) as { session: { id: string } };
    const events = await fetch(`${address}/v1/sessions/${session.id}/events`);
    const body = (await events.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["events", "sessionId"]);
    await host.close();
  });

  it("health response contains only ok, service, version", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 3 });
    await host.start();
    const address = host.address();
    const response = await fetch(`${address}/health`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "service", "version"]);
    await host.close();
  });

  it("does not expose internal paths in any response", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 4 });
    await host.start();
    const address = host.address();
    const health = await fetch(`${address}/health`);
    const healthText = await health.text();
    expect(healthText).not.toContain("C:\\");
    expect(healthText).not.toContain("/home/");
    expect(healthText).not.toContain("node_modules");

    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const createdText = await created.text();
    expect(createdText).not.toContain("C:\\");
    expect(createdText).not.toContain("/home/");
    await host.close();
  });
});
