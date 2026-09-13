import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";

const TEST_PORT = 14900;

describe("task 24 streaming behavior", () => {
  it("returns NDJSON content-type on turn start", async () => {
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
    expect(turn.headers.get("content-type")).toContain("application/x-ndjson");
    await turn.text();
    await host.close();
  });

  it("each NDJSON line is a valid JSON object", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
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
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    await host.close();
  });

  it("does not wrap events in a JSON array", async () => {
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
    const text = await turn.text();
    expect(text.trimStart().startsWith("[")).toBe(false);
    expect(text.trimStart().startsWith("{")).toBe(true);
    await host.close();
  });

  it("terminal event appears exactly once", async () => {
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
    const lines = text.split("\n").filter((l) => l.length > 0);
    const events = lines.map(
      (l) => JSON.parse(l) as { type: string },
    );
    const terminal = events.filter(
      (e) => e.type === "completed" || e.type === "error",
    );
    expect(terminal.length).toBe(1);
    await host.close();
  });
});
