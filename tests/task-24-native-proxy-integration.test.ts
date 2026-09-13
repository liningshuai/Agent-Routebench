import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";

const TEST_PORT = 15100;

describe("task 24 integration", () => {
  it("full session lifecycle through loopback API", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
    await host.start();
    const address = host.address();

    // Health
    const health = await fetch(`${address}/health`);
    expect(health.status).toBe(200);

    // Create session
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: { id: string; status: string };
    };
    expect(session.status).toBe("idle");

    // Start turn
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
    expect(turn.status).toBe(200);
    const turnId = turn.headers.get("x-agent-turn-id");
    expect(turnId).toBeTruthy();
    await turn.text();

    // Query events
    const events = await fetch(`${address}/v1/sessions/${session.id}/events`);
    expect(events.status).toBe(200);
    const body = (await events.json()) as { events: unknown[] };
    expect(body.events.length).toBeGreaterThan(0);

    // Session status after turn
    const sessionRes = await fetch(`${address}/v1/sessions/${session.id}`);
    const sessionBody = (await sessionRes.json()) as {
      session: { status: string };
    };
    // NotReady runner produces runner_error, so session should be failed.
    expect(["failed", "completed"]).toContain(sessionBody.session.status);

    await host.close();
  });

  it("multiple sessions are isolated", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    await host.start();
    const address = host.address();

    const a = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const b = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session: sessionA } = (await a.json()) as { session: { id: string } };
    const { session: sessionB } = (await b.json()) as { session: { id: string } };
    expect(sessionA.id).not.toBe(sessionB.id);

    const turnA = await fetch(`${address}/v1/sessions/${sessionA.id}/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "a" }] }],
      }),
    });
    await turnA.text();

    const eventsB = await fetch(`${address}/v1/sessions/${sessionB.id}/events`);
    const bodyB = (await eventsB.json()) as { events: unknown[] };
    expect(bodyB.events).toEqual([]);

    await host.close();
  });
});
