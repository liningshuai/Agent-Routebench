import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";
import { NotReadyLocalAgentRunner } from "../apps/local-agent-host/src/host.js";
import { LocalAgentHostError } from "../apps/local-agent-host/src/errors.js";

const TEST_PORT = 14317;

describe("task 23 sidecar launch config validation", () => {
  it("rejects a non-loopback host on the Node host", () => {
    expect(() =>
      createLocalAgentHost({ host: "0.0.0.0" as never, port: TEST_PORT }),
    ).toThrow(LocalAgentHostError);
  });

  it("rejects port zero", () => {
    expect(() => createLocalAgentHost({ port: 0 })).toThrow(LocalAgentHostError);
  });

  it("rejects a port above 65535", () => {
    expect(() => createLocalAgentHost({ port: 70000 })).toThrow(LocalAgentHostError);
  });

  it("rejects unknown top-level fields", () => {
    expect(() =>
      createLocalAgentHost({ port: TEST_PORT, apiKey: "nope" } as never),
    ).toThrow(LocalAgentHostError);
  });

  it("accepts the default loopback host and port", () => {
    expect(() =>
      createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT }),
    ).not.toThrow();
  });
});

describe("task 23 NotReady runner behavior", () => {
  it("throws the fixed not-ready error", async () => {
    const runner = new NotReadyLocalAgentRunner();
    await expect(
      runner.run({
        sessionId: "s",
        turnId: "t",
        messages: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "runner_not_ready" });
  });

  it("does not fabricate completed or text_delta events", async () => {
    const runner = new NotReadyLocalAgentRunner();
    const events: unknown[] = [];
    try {
      const iterable = await runner.run({
        sessionId: "s",
        turnId: "t",
        messages: [],
        signal: new AbortController().signal,
      });
      for await (const event of iterable) {
        events.push(event);
      }
    } catch {
      // expected
    }
    expect(events).toEqual([]);
  });
});

describe("task 23 host lifecycle", () => {
  it("starts and stops a loopback host", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
    await host.start();
    expect(host.state()).toBe("running");
    expect(host.address()).toContain("127.0.0.1");
    await host.close();
    expect(host.state()).toBe("closed");
  });

  it("close is idempotent", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    await host.start();
    await host.close();
    await host.close();
    expect(host.state()).toBe("closed");
  });

  it("two hosts are isolated", async () => {
    const a = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 2 });
    const b = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 3 });
    await a.start();
    expect(a.state()).toBe("running");
    expect(b.state()).toBe("created");
    await a.close();
    expect(b.state()).toBe("created");
  });
});

describe("task 23 loopback API integration", () => {
  it("health returns ok on a running host", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 4 });
    await host.start();
    const address = host.address();
    const response = await fetch(`${address}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("agent-workbench-local-api");
    await host.close();
  });

  it("create session succeeds on a running host", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 5 });
    await host.start();
    const address = host.address();
    const response = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      session: { id: string; status: string };
    };
    expect(body.session.id.length).toBeGreaterThan(0);
    expect(body.session.status).toBe("idle");
    await host.close();
  });

  it("turn on NotReady host produces runner_error, not fabricated success", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 6 });
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
    const text = await turn.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    const events = lines.map(
      (l) => JSON.parse(l) as { type: string; code?: string },
    );
    expect(
      events.some((e) => e.type === "error" && e.code === "runner_error"),
    ).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
    await host.close();
  });

  it("does not leak provider URLs or secrets in events", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 7 });
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
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("credential:");
    expect(text).not.toContain("api.anthropic.com");
    await host.close();
  });
});

describe("task 23 renderer data boundary", () => {
  it("renderer events never contain process command lines", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 8 });
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
    expect(text).not.toContain("dist/main.js");
    expect(text).not.toContain("process.argv");
    await host.close();
  });
});

describe("task 23 error contract", () => {
  it("LocalAgentHostError has fixed messages", () => {
    const error = new LocalAgentHostError("start_failed");
    expect(error.message).toBe("Local agent host failed to start.");
    expect(error.message).not.toContain("127.0.0.1");
    expect(error.message).not.toContain("4317");
  });
});
