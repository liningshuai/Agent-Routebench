import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import { InMemoryLocalAgentSessionStore } from "../packages/local-agent-api/src/index.js";
import {
  httpJson,
  httpNdjson,
  makeCompletedEvent,
  makeTextEvent,
  scriptedRunner,
  startServer,
  userMessage,
} from "./helpers/local-agent-api-fixtures.js";

async function withServer(
  run: (port: number) => Promise<void>,
  options?: Parameters<typeof startServer>[0],
): Promise<void> {
  const { server, port } = await startServer(options);
  try {
    await run(port);
  } finally {
    await server.close();
  }
}

async function rawBody(
  port: number,
  method: string,
  path: string,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          chunks.push(c);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("task 9 local api basics", () => {
  it("serves health", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "GET", "/health");
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        service: "agent-workbench-local-api",
        version: 1,
      });
    });
  });

  it("creates a session", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "POST", "/v1/sessions", {});
      expect(res.status).toBe(201);
      const body = res.json() as {
        session: { id: string; status: string; createdAt: number; updatedAt: number };
      };
      expect(body.session.id.length).toBeGreaterThan(0);
      expect(body.session.status).toBe("idle");
      expect(typeof body.session.createdAt).toBe("number");
      expect(typeof body.session.updatedAt).toBe("number");
    });
  });

  it("creates a session without calling the runner", async () => {
    let called = 0;
    await withServer(
      async (port) => {
        await httpJson(port, "POST", "/v1/sessions", {});
        expect(called).toBe(0);
      },
      {
        runner: {
          async run() {
            called += 1;
            return {
              async *[Symbol.asyncIterator]() {
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });

  it("queries an existing session", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "GET", `/v1/sessions/${id}`);
      expect(res.status).toBe(200);
      expect((res.json() as { session: { id: string } }).session.id).toBe(id);
    });
  });

  it("returns session_not_found for a missing session", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "GET", "/v1/sessions/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.json()).toEqual({
        error: { code: "session_not_found", message: "Session not found." },
      });
    });
  });

  it("returns not_found for unknown paths", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "GET", "/nope");
      expect(res.status).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "not_found",
      );
    });
  });

  it("returns method_not_allowed for unsupported methods", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "DELETE", "/v1/sessions");
      expect(res.status).toBe(405);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "method_not_allowed",
      );
    });
  });

  it("returns invalid_json for malformed bodies", async () => {
    await withServer(async (port) => {
      const res = await rawBody(port, "POST", "/v1/sessions", "{bad");
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text)).toEqual({
        error: {
          code: "invalid_json",
          message: "Request body is not valid JSON.",
        },
      });
    });
  });

  it("returns invalid_request when messages are missing", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {});
      expect(res.status).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "invalid_request",
      );
    });
  });

  it("rejects invalid maxTokens", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        maxTokens: -1,
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects non-string routeId", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        routeId: 123,
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects non-string model", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        model: { name: "x" },
      });
      expect(res.status).toBe(400);
    });
  });

  it("accepts a class Runner", async () => {
    class ClassRunner {
      async run(): Promise<AsyncIterable<AgentEvent>> {
        return {
          async *[Symbol.asyncIterator]() {
            yield makeTextEvent("from-class");
            yield makeCompletedEvent();
          },
        };
      }
    }
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const res = await httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        expect(res.status).toBe(200);
        expect(res.events).toContainEqual(
          expect.objectContaining({ type: "text_delta", text: "from-class" }),
        );
      },
      { runner: new ClassRunner() },
    );
  });

  it("accepts a class Store", async () => {
    class ClassStore extends InMemoryLocalAgentSessionStore {}
    await withServer(
      async (port) => {
        const res = await httpJson(port, "POST", "/v1/sessions", {});
        expect(res.status).toBe(201);
      },
      { store: new ClassStore() },
    );
  });

  it("lists events after a turn", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      await httpNdjson(port, `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
      });
      const res = await httpJson(port, "GET", `/v1/sessions/${id}/events`);
      expect(res.status).toBe(200);
      const body = res.json() as { sessionId: string; events: unknown[] };
      expect(body.sessionId).toBe(id);
      expect(body.events.length).toBeGreaterThan(0);
    });
  });

  it("returns session_not_found for events of a missing session", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "GET", "/v1/sessions/missing/events");
      expect(res.status).toBe(404);
    });
  });

  it("returns not_running when cancelling an idle session", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        code: "not_running",
        message: "No turn is running.",
      });
    });
  });

  it("returns session_not_found when cancelling a missing session", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "POST", "/v1/sessions/missing/cancel");
      expect(res.status).toBe(404);
    });
  });

  it("does not set CORS headers", async () => {
    await withServer(async (port) => {
      const res = await httpJson(port, "GET", "/health");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  it("accepts an empty tools array", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpNdjson(port, `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        tools: [],
      });
      expect(res.status).toBe(200);
    });
  });

  it("accepts optional routeId and model strings", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpNdjson(port, `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        routeId: "route-a",
        model: "model-a",
        maxTokens: 64,
      });
      expect(res.status).toBe(200);
    });
  });
});
