import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";
import { LocalAgentHostError } from "../apps/local-agent-host/src/errors.js";

const TEST_PORT = 14800;

describe("task 24 proxy security boundaries", () => {
  it("rejects non-loopback host in launch config", () => {
    expect(() =>
      createLocalAgentHost({ host: "0.0.0.0" as never, port: TEST_PORT }),
    ).toThrow(LocalAgentHostError);
  });

  it("turn body does not contain credential fields", async () => {
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
    const text = await turn.text();
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("credential:");
    expect(text).not.toContain("Authorization");
    await host.close();
  });

  it("error events contain only safe fields", async () => {
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
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      const allowed = new Set(["type", "requestId", "code", "message", "retryable"]);
      for (const key of Object.keys(event)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    await host.close();
  });

  it("does not expose internal paths in error messages", () => {
    const error = new LocalAgentHostError("start_failed");
    expect(error.message).not.toContain("/");
    expect(error.message).not.toContain("\\");
    expect(error.message).not.toContain("C:");
  });

  it("rejects forbidden fields in turn request", async () => {
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
        apiKey: "nope",
      }),
    });
    expect(turn.status).toBe(400);
    await turn.text();
    await host.close();
  });
});
