import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import {
  httpJson,
  httpNdjson,
  makeCompletedEvent,
  makeTextEvent,
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

function gatedRunner(gates: Map<string, () => void>): Parameters<typeof startServer>[0] {
  return {
    runner: {
      async run(request): Promise<AsyncIterable<AgentEvent>> {
        const gate = new Promise<void>((resolve) => {
          gates.set(request.sessionId, resolve);
        });
        return {
          async *[Symbol.asyncIterator]() {
            yield makeTextEvent(`start-${request.sessionId}`);
            await gate;
            yield makeCompletedEvent();
          },
        };
      },
    },
  };
}

describe("task 9 concurrency", () => {
  it("returns session_busy when two turns share one session", async () => {
    const gates = new Map<string, () => void>();
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;

        const first = httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("a")],
        });
        // Wait until the first turn is running.
        await new Promise((r) => setTimeout(r, 40));

        const second = await httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("b")],
        });
        expect(second.status).toBe(409);
        expect(
          (second.events as unknown as { error: { code: string } }) ??
            JSON.parse(JSON.stringify(second.events)),
        ).toBeDefined();

        const finish = gates.get(id);
        finish?.();
        const firstResult = await first;
        expect(firstResult.status).toBe(200);
      },
      gatedRunner(gates),
    );
  });

  it("reports session_busy with a fixed error body", async () => {
    const gates = new Map<string, () => void>();
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const first = httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("a")],
        });
        await new Promise((r) => setTimeout(r, 40));

        const { request } = await import("node:http");
        const raw = await new Promise<{ status: number; text: string }>(
          (resolve, reject) => {
            const payload = JSON.stringify({ messages: [userMessage("b")] });
            const req = request(
              {
                host: "127.0.0.1",
                port,
                method: "POST",
                path: `/v1/sessions/${id}/turns`,
                headers: {
                  "content-type": "application/json",
                  accept: "application/x-ndjson",
                  "content-length": Buffer.byteLength(payload),
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
            req.write(payload);
            req.end();
          },
        );
        expect(raw.status).toBe(409);
        expect(JSON.parse(raw.text)).toEqual({
          error: { code: "session_busy", message: "Session is busy." },
        });

        gates.get(id)?.();
        await first;
      },
      gatedRunner(gates),
    );
  });

  it("allows two sessions to run in parallel without event crosstalk", async () => {
    const gates = new Map<string, () => void>();
    await withServer(
      async (port) => {
        const a = await httpJson(port, "POST", "/v1/sessions", {});
        const b = await httpJson(port, "POST", "/v1/sessions", {});
        const idA = (a.json() as { session: { id: string } }).session.id;
        const idB = (b.json() as { session: { id: string } }).session.id;

        const turnA = httpNdjson(port, `/v1/sessions/${idA}/turns`, {
          messages: [userMessage("a")],
        });
        const turnB = httpNdjson(port, `/v1/sessions/${idB}/turns`, {
          messages: [userMessage("b")],
        });
        await new Promise((r) => setTimeout(r, 40));
        gates.get(idA)?.();
        gates.get(idB)?.();
        const [ra, rb] = await Promise.all([turnA, turnB]);

        expect(ra.status).toBe(200);
        expect(rb.status).toBe(200);
        expect(JSON.stringify(ra.events)).toContain(`start-${idA}`);
        expect(JSON.stringify(ra.events)).not.toContain(`start-${idB}`);
        expect(JSON.stringify(rb.events)).toContain(`start-${idB}`);
        expect(JSON.stringify(rb.events)).not.toContain(`start-${idA}`);

        const eventsA = await httpJson(port, "GET", `/v1/sessions/${idA}/events`);
        const eventsB = await httpJson(port, "GET", `/v1/sessions/${idB}/events`);
        expect(JSON.stringify(eventsA.json())).not.toContain(`start-${idB}`);
        expect(JSON.stringify(eventsB.json())).not.toContain(`start-${idA}`);
      },
      gatedRunner(gates),
    );
  });

  it("cancelling one session does not affect another", async () => {
    const gates = new Map<string, () => void>();
    await withServer(
      async (port) => {
        const a = await httpJson(port, "POST", "/v1/sessions", {});
        const b = await httpJson(port, "POST", "/v1/sessions", {});
        const idA = (a.json() as { session: { id: string } }).session.id;
        const idB = (b.json() as { session: { id: string } }).session.id;

        const turnA = httpNdjson(port, `/v1/sessions/${idA}/turns`, {
          messages: [userMessage("a")],
        });
        const turnB = httpNdjson(port, `/v1/sessions/${idB}/turns`, {
          messages: [userMessage("b")],
        });
        await new Promise((r) => setTimeout(r, 40));

        await httpJson(port, "POST", `/v1/sessions/${idA}/cancel`);
        gates.get(idB)?.();

        const [ra, rb] = await Promise.all([turnA, turnB]);
        expect(ra.status).toBe(200);
        expect(rb.status).toBe(200);
        expect(JSON.stringify(rb.events)).toContain('"completed"');

        const sessionA = await httpJson(port, "GET", `/v1/sessions/${idA}`);
        const sessionB = await httpJson(port, "GET", `/v1/sessions/${idB}`);
        expect(
          (sessionA.json() as { session: { status: string } }).session.status,
        ).toBe("cancelled");
        expect(
          (sessionB.json() as { session: { status: string } }).session.status,
        ).toBe("completed");
      },
      gatedRunner(gates),
    );
  });

  it("tracks session status transitions", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      expect(
        (
          (await httpJson(port, "GET", `/v1/sessions/${id}`)).json() as {
            session: { status: string };
          }
        ).session.status,
      ).toBe("idle");

      await httpNdjson(port, `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
      });
      expect(
        (
          (await httpJson(port, "GET", `/v1/sessions/${id}`)).json() as {
            session: { status: string };
          }
        ).session.status,
      ).toBe("completed");
    });
  });

  it("returns a defensive copy of events", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      await httpNdjson(port, `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
      });
      const first = await httpJson(port, "GET", `/v1/sessions/${id}/events`);
      const body = first.json() as { events: unknown[] };
      body.events.push({ type: "injected" });
      const second = await httpJson(port, "GET", `/v1/sessions/${id}/events`);
      expect((second.json() as { events: unknown[] }).events).toHaveLength(
        2,
      );
    });
  });

  it("keeps multiple server instances isolated", async () => {
    const one = await startServer();
    const two = await startServer();
    try {
      const created = await httpJson(one.port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(two.port, "GET", `/v1/sessions/${id}`);
      expect(res.status).toBe(404);
    } finally {
      await one.server.close();
      await two.server.close();
    }
  });
});

describe("task 9 cancellation", () => {
  it("cancels a hanging turn before any further events", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const turn = httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        await new Promise((r) => setTimeout(r, 20));
        await httpJson(port, "POST", `/v1/sessions/${id}/cancel`);
        const res = await turn;
        expect(res.status).toBe(200);
        expect(res.events).toHaveLength(1);
        const event = res.events[0] as { type: string; code: string };
        expect(event.type).toBe("error");
        expect(event.code).toBe("aborted");
      },
      {
        runner: {
          async run(request): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>((resolve) => {
                  request.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                yield {
                  type: "error",
                  requestId: request.turnId,
                  code: "aborted",
                  message: "Turn aborted.",
                  retryable: false,
                };
              },
            };
          },
        },
      },
    );
  });

  it("aborts mid-stream and stops further events", async () => {
    let sawAbort = false;
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;

        const turn = httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        await new Promise((r) => setTimeout(r, 30));
        await httpJson(port, "POST", `/v1/sessions/${id}/cancel`);
        const res = await turn;

        expect(res.status).toBe(200);
        const types = res.events.map((e) => (e as { type: string }).type);
        expect(types).not.toContain("completed");
        expect(sawAbort).toBe(true);
        // The pre-cancel "first" delta is allowed; nothing after cancel may appear.
        const texts = (res.events as { type: string; text?: string }[]).filter(
          (e) => e.type === "text_delta",
        );
        for (const event of texts) {
          expect(event.text).toBe("first");
        }
        const abortedCount = types.filter((t) => t === "error").length;
        expect(abortedCount).toBeLessThanOrEqual(1);
      },
      {
        runner: {
          async run(request): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("first");
                await new Promise<void>((resolve) => {
                  if (request.signal.aborted) {
                    resolve();
                    return;
                  }
                  request.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                sawAbort = true;
                if (request.signal.aborted) {
                  yield {
                    type: "error",
                    requestId: request.turnId,
                    code: "aborted",
                    message: "Turn aborted.",
                    retryable: false,
                  };
                  return;
                }
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });

  it("completes even when runner next() never resolves after abort", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const turn = httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        await new Promise((r) => setTimeout(r, 20));
        await httpJson(port, "POST", `/v1/sessions/${id}/cancel`);
        const res = await Promise.race([
          turn,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 2000),
          ),
        ]);
        expect(res.status).toBe(200);
      },
      {
        runner: {
          async run(request): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("first");
                await new Promise<void>(() => {
                  // never resolves; abort must still unblock the server
                  void request;
                });
              },
            };
          },
        },
      },
    );
  });

  it("does not produce unhandled rejections on late runner failure", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      await withServer(
        async (port) => {
          const created = await httpJson(port, "POST", "/v1/sessions", {});
          const id = (created.json() as { session: { id: string } }).session.id;
          const turn = httpNdjson(port, `/v1/sessions/${id}/turns`, {
            messages: [userMessage("hi")],
          });
          await new Promise((r) => setTimeout(r, 20));
          await httpJson(port, "POST", `/v1/sessions/${id}/cancel`);
          await turn;
          await new Promise((r) => setTimeout(r, 50));
        },
        {
          runner: {
            async run(request): Promise<AsyncIterable<AgentEvent>> {
              return {
                async *[Symbol.asyncIterator]() {
                  yield makeTextEvent("first");
                  await new Promise<void>((resolve) => {
                    request.signal.addEventListener("abort", () => resolve(), {
                      once: true,
                    });
                  });
                  throw new Error("late failure");
                },
              };
            },
          },
        },
      );
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("does not emit text_delta after cancel", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const turn = httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        await new Promise((r) => setTimeout(r, 20));
        await httpJson(port, "POST", `/v1/sessions/${id}/cancel`);
        const res = await turn;
        const texts = (res.events as { type: string; text?: string }[]).filter(
          (e) => e.type === "text_delta",
        );
        for (const event of texts) {
          expect(event.text).toBe("before");
        }
      },
      {
        runner: {
          async run(request): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("before");
                await new Promise<void>((resolve) => {
                  request.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
                if (!request.signal.aborted) {
                  yield makeTextEvent("after");
                }
                yield {
                  type: "error",
                  requestId: request.turnId,
                  code: "aborted",
                  message: "Turn aborted.",
                  retryable: false,
                };
              },
            };
          },
        },
      },
    );
  });
});
