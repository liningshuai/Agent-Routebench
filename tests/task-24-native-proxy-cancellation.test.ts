import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";

const TEST_PORT = 15000;

describe("task 24 cancellation", () => {
  it("cancel on idle session returns not_running", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
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
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(true);
    expect(body.code).toBe("not_running");
    await host.close();
  });

  it("cancel on missing session returns 404", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    await host.start();
    const address = host.address();
    const cancel = await fetch(`${address}/v1/sessions/missing-id/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(cancel.status).toBe(404);
    await cancel.text();
    await host.close();
  });

  it("cancel after turn completes returns not_running", async () => {
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
    await turn.text();
    const cancel = await fetch(`${address}/v1/sessions/${session.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { code: string };
    expect(body.code).toBe("not_running");
    await host.close();
  });
});
