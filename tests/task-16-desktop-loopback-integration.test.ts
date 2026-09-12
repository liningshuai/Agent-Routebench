import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentApiClient } from "../packages/local-agent-client/src/index.js";
import { createLoopbackDesktopApiClient } from "../apps/desktop/src/local-api-client.js";
import {
  startServer,
  userMessage,
} from "./helpers/local-agent-api-fixtures.js";

describe("Task 16 Desktop loopback integration", () => {
  const servers: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("connects Desktop through the shared client to the real loopback API", async () => {
    const started = await startServer();
    servers.push(started.server);
    const desktopClient = createLoopbackDesktopApiClient({
      baseUrl: `http://127.0.0.1:${String(started.port)}`,
    });

    await desktopClient.load();
    const session = await desktopClient.createSession();
    const events: unknown[] = [];
    for await (const event of desktopClient.submitTurn(session.id, {
      messages: [userMessage("hello from desktop")],
    })) {
      events.push(event);
    }

    expect(session.status).toBe("idle");
    expect(events).toEqual([
      { type: "text_delta", requestId: expect.any(String), text: "hello" },
      { type: "completed", requestId: expect.any(String) },
    ]);
  });

  it("shares session and event validation with the CLI client", async () => {
    const started = await startServer();
    servers.push(started.server);
    const client = new LocalAgentApiClient(
      `http://127.0.0.1:${String(started.port)}`,
    );

    const session = await client.createSession();
    const streamed: unknown[] = [];
    for await (const event of client.runTurn(session.id, {
      messages: [userMessage("hello")],
    })) {
      streamed.push(event);
    }
    const stored = await client.listEvents(session.id);

    expect(stored).toEqual(streamed);
    await expect(client.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      status: "completed",
    });
  });
});
