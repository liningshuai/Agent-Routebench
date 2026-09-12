import { describe, expect, test } from "vitest";
import { LocalAgentApiClient } from "../packages/local-agent-client/src/index.js";
import {
  createStartedTestHost,
  SERVER_RUNNER_ERROR_MESSAGE,
  validTurnRequest,
} from "./helpers/local-agent-host-fixtures.js";

describe("Task 20: HTTP integration through the existing Task 16 client", () => {
  test("GET /health is reachable through the host", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const health = (await client.health()) as { ok?: boolean };
      expect(health.ok).toBe(true);
    } finally {
      await dispose();
    }
  });

  test("POST /v1/sessions creates a real session envelope", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const session = await client.createSession();
      expect(session.id).not.toBe("");
      expect(session.status).toBe("idle");
      expect(typeof session.createdAt).toBe("number");
      expect(typeof session.updatedAt).toBe("number");
    } finally {
      await dispose();
    }
  });

  test("GET /v1/sessions/:id returns the created session", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const created = await client.createSession();
      const fetched = await client.getSession(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.status).toBe("idle");
    } finally {
      await dispose();
    }
  });

  test("GET /v1/sessions/:id/events returns the event list through the host", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const created = await client.createSession();
      const events = await client.listEvents(created.id);
      expect(events).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test("an unknown session id keeps the existing fixed error envelope", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      // The Task 16 client maps every non-2xx to its fixed client error.
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const clientError = await client.getSession("does-not-exist").then(
        () => null,
        (candidate: { code?: string }) => candidate,
      );
      expect(clientError?.code).toBe("api_http_error");
      // The server envelope itself still carries the Task 9 fixed code.
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/v1/sessions/does-not-exist`,
      );
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("session_not_found");
    } finally {
      await dispose();
    }
  });

  test("an unknown route produces the existing fixed 404 error", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/nope`);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("not_found");
    } finally {
      await dispose();
    }
  });

  test("a wrong method produces the existing method_not_allowed error", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
        method: "POST",
      });
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("method_not_allowed");
    } finally {
      await dispose();
    }
  });

  test("turn events stream the fixed runner_error and the session ends failed", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const session = await client.createSession();
      const events = [];
      for await (const event of client.runTurn(session.id, validTurnRequest() as never)) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      const failure = events.find((event) => event.type === "error");
      if (failure?.type === "error") {
        expect(failure.code).toBe("runner_error");
        expect(failure.message).toBe(SERVER_RUNNER_ERROR_MESSAGE);
      }
      const after = await client.getSession(session.id);
      expect(after.status).toBe("failed");
    } finally {
      await dispose();
    }
  });

  test("cancel on a session without an active turn keeps existing Task 9 semantics", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const session = await client.createSession();
      const result = await client.cancel(session.id);
      expect(result).toBeDefined();
    } finally {
      await dispose();
    }
  });

  test("closing the host stops serving requests", async () => {
    const { port, host, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      expect((await client.health() as { ok?: boolean }).ok).toBe(true);
      await host.close();
      const failed = await client.health().then(
        () => false,
        () => true,
      );
      expect(failed).toBe(true);
    } finally {
      await dispose().catch(() => undefined);
    }
  });
});
