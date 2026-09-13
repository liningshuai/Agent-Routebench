import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";
import { NotReadyLocalAgentRunner } from "../apps/local-agent-host/src/host.js";

const TEST_PORT = 14700;

describe("task 24 x-agent-turn-id header", () => {
  it("returns x-agent-turn-id on a successful turn start", async () => {
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
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(turn.status).toBe(200);
    const turnId = turn.headers.get("x-agent-turn-id");
    expect(turnId).toBeTruthy();
    expect(turnId!.length).toBeGreaterThan(0);
    await turn.text();
    await host.close();
  });

  it("does not add x-agent-turn-id to non-turn endpoints", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    await host.start();
    const address = host.address();
    const health = await fetch(`${address}/health`);
    expect(health.headers.get("x-agent-turn-id")).toBeNull();

    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.headers.get("x-agent-turn-id")).toBeNull();
    await host.close();
  });

  it("turn events requestId matches the header turnId", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 2 });
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
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    const turnId = turn.headers.get("x-agent-turn-id");
    const text = await turn.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const event = JSON.parse(line) as { requestId?: string };
      expect(event.requestId).toBe(turnId);
    }
    await host.close();
  });

  it("does not add turnId to the JSON body of the response", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 3 });
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
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    const text = await turn.text();
    // The NDJSON body should only contain AgentEvents, not a turnId wrapper.
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("turnId");
    }
    await host.close();
  });
});

describe("task 24 NotReady runner through sidecar", () => {
  it("NotReady runner produces runner_error with matching requestId", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 4 });
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
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });
    const turnId = turn.headers.get("x-agent-turn-id");
    const text = await turn.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    const events = lines.map(
      (l) => JSON.parse(l) as { type: string; code?: string; requestId?: string },
    );
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.code).toBe("runner_error");
    expect(errorEvent!.requestId).toBe(turnId);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await host.close();
  });
});
