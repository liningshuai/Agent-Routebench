import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";

const TEST_PORT = 14500;

describe("task 23 host lifecycle edge cases", () => {
  it("start fails when the port is already in use", async () => {
    const first = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
    await first.start();
    const second = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
    await expect(second.start()).rejects.toMatchObject({ code: "start_failed" });
    await first.close();
  });

  it("state transitions created → running → closed", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    expect(host.state()).toBe("created");
    await host.start();
    expect(host.state()).toBe("running");
    await host.close();
    expect(host.state()).toBe("closed");
  });

  it("multiple sequential start/stop cycles work on separate hosts", async () => {
    for (let i = 0; i < 3; i += 1) {
      const host = createLocalAgentHost({
        host: "127.0.0.1",
        port: TEST_PORT + 10 + i,
      });
      await host.start();
      expect(host.state()).toBe("running");
      await host.close();
      expect(host.state()).toBe("closed");
    }
  });

  it("health endpoint responds on the bound address", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 20 });
    await host.start();
    const address = host.address();
    const response = await fetch(`${address}/health`);
    const body = (await response.json()) as { ok: boolean; version: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);
    await host.close();
  });

  it("events endpoint returns empty array for a new session", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 21 });
    await host.start();
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await created.json()) as { session: { id: string } };
    const events = await fetch(`${address}/v1/sessions/${session.id}/events`);
    expect(events.status).toBe(200);
    const body = (await events.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
    await host.close();
  });

  it("cancel on an idle session returns not_running", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 22 });
    await host.start();
    const address = host.address();
    const created = await fetch(`${address}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await created.json()) as { session: { id: string } };
    const cancel = await fetch(`${address}/v1/sessions/${session.id}/cancel`, {
      method: "POST",
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { code: string };
    expect(body.code).toBe("not_running");
    await host.close();
  });
});
