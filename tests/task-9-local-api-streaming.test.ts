import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import {
  httpJson,
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

interface StreamingProbe {
  readonly status: number;
  readonly lines: string[];
  readonly firstChunkAt: number;
  readonly lastChunkAt: number;
  readonly chunks: number;
}

function streamTurn(
  port: number,
  sessionId: string,
  body: unknown,
): Promise<StreamingProbe> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/v1/sessions/${sessionId}/turns`,
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const lines: string[] = [];
        let buffer = "";
        let chunks = 0;
        let firstChunkAt = 0;
        let lastChunkAt = 0;
        res.on("data", (chunk: Buffer) => {
          chunks += 1;
          if (firstChunkAt === 0) {
            firstChunkAt = Date.now();
          }
          lastChunkAt = Date.now();
          buffer += chunk.toString("utf8");
          let idx = buffer.indexOf("\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx);
            if (line.length > 0) {
              lines.push(line);
            }
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (buffer.length > 0) {
            lines.push(buffer);
          }
          resolve({
            status: res.statusCode ?? 0,
            lines,
            firstChunkAt,
            lastChunkAt,
            chunks,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
    void startedAt;
  });
}

describe("task 9 streaming", () => {
  it("emits each AgentEvent as its own NDJSON line", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const probe = await streamTurn(port, id, {
          messages: [userMessage("hi")],
        });
        expect(probe.status).toBe(200);
        expect(probe.lines).toEqual([
          JSON.stringify(makeTextEvent("one")),
          JSON.stringify(makeTextEvent("two")),
          JSON.stringify(makeCompletedEvent()),
        ]);
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("one");
                yield makeTextEvent("two");
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });

  it("delivers the first text_delta before the stream ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;

        const probePromise = streamTurn(port, id, {
          messages: [userMessage("hi")],
        });
        // First event should arrive while the runner is still gated.
        await new Promise((r) => setTimeout(r, 50));
        release();
        const probe = await probePromise;
        expect(probe.lines[0]).toBe(JSON.stringify(makeTextEvent("early")));
        expect(probe.lines).toHaveLength(2);
        expect(probe.firstChunkAt).toBeLessThanOrEqual(probe.lastChunkAt);
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("early");
                await gate;
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });

  it("preserves chinese and emoji in UTF-8", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const probe = await streamTurn(port, id, {
          messages: [userMessage("你好")],
        });
        expect(probe.lines[0]).toBe(
          JSON.stringify(makeTextEvent("你好 🚀 世界")),
        );
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("你好 🚀 世界");
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });

  it("emits completed only once", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const probe = await streamTurn(port, id, {
          messages: [userMessage("hi")],
        });
        const completed = probe.lines.filter((line) =>
          line.includes('"completed"'),
        );
        expect(completed).toHaveLength(1);
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("a");
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });

  it("stops after a runner error event", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const probe = await streamTurn(port, id, {
          messages: [userMessage("hi")],
        });
        expect(probe.lines).toHaveLength(1);
        const event = JSON.parse(probe.lines[0]!) as { type: string; code: string };
        expect(event.type).toBe("error");
        expect(event.code).toBe("runner_error");
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "error",
                  requestId: "req-1",
                  code: "runner_error",
                  message: "Runner failed.",
                  retryable: false,
                } satisfies AgentEvent;
              },
            };
          },
        },
      },
    );
  });

  it("releases the iterator after the stream ends", async () => {
    let released = false;
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const probe = await streamTurn(port, id, {
          messages: [userMessage("hi")],
        });
        expect(probe.status).toBe(200);
        expect(released).toBe(true);
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
            return {
              async *[Symbol.asyncIterator]() {
                try {
                  yield makeTextEvent("a");
                  yield makeCompletedEvent();
                } finally {
                  released = true;
                }
              },
            };
          },
        },
      },
    );
  });

  it("does not wrap events in a JSON array", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const probe = await streamTurn(port, id, {
          messages: [userMessage("hi")],
        });
        expect(probe.lines[0]!.startsWith("{")).toBe(true);
        expect(probe.lines[0]!.startsWith("[")).toBe(false);
      },
      {
        runner: {
          async run(): Promise<AsyncIterable<AgentEvent>> {
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
});
