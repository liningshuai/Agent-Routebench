import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createLocalAgentApiServer,
  type LocalAgentApiServer,
  type LocalAgentApiOptions,
  type LocalAgentRunner,
  type LocalAgentSessionStore,
} from "../../packages/local-agent-api/src/index.js";
import type { AgentEvent, AgentMessage } from "../../packages/agent-core/src/index.js";

export function makeTextEvent(
  text: string,
  requestId = "req-1",
): AgentEvent {
  return { type: "text_delta", requestId, text };
}

export function makeCompletedEvent(requestId = "req-1"): AgentEvent {
  return { type: "completed", requestId };
}

export function scriptedRunner(
  events: readonly AgentEvent[],
): LocalAgentRunner {
  return {
    async run(): Promise<AsyncIterable<AgentEvent>> {
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            yield event;
          }
        },
      };
    },
  };
}

export function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly json: () => unknown;
}

export async function httpJson(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers:
          payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

export interface NdjsonResult {
  readonly status: number;
  readonly lines: string[];
  readonly events: unknown[];
}

export async function httpNdjson(
  port: number,
  path: string,
  body: unknown,
): Promise<NdjsonResult> {
  const payload = JSON.stringify(body);
  return new Promise<NdjsonResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const lines = text.split("\n").filter((line) => line.length > 0);
          const events = lines.map((line) => JSON.parse(line) as unknown);
          resolve({ status: res.statusCode ?? 0, lines, events });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function startServer(
  options?: Partial<LocalAgentApiOptions>,
): Promise<{ server: LocalAgentApiServer; port: number }> {
  const server = createLocalAgentApiServer({
    port: 0,
    runner: scriptedRunner([makeTextEvent("hello"), makeCompletedEvent()]),
    ...options,
  });
  await server.start();
  const address = server.address();
  if (address === undefined) {
    throw new Error("server address missing");
  }
  const port = Number(address.slice(address.lastIndexOf(":") + 1));
  return { server, port };
}

export type { LocalAgentSessionStore };
