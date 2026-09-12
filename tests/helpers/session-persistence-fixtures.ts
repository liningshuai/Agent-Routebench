import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileLocalAgentSessionStore,
  type FileSessionStoreOptions,
} from "../../packages/session-persistence/src/index.js";
import type { LocalAgentSession } from "../../packages/local-agent-api/src/index.js";
import type { AgentEvent } from "../../packages/agent-core/src/index.js";

export function makeKey(): Uint8Array {
  return randomBytes(32);
}

// Node's fetch rejects a small set of browser-dangerous ports. When the API
// integration test asks the OS for an ephemeral port, avoid those values so
// the test remains deterministic instead of failing with "bad port".
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 2049, 3659, 4045, 6000, 6566,
]);

function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port) || (port >= 6665 && port <= 6669) || port === 10080;
}

export async function getSafeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const probe = createTcpServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address !== null && typeof address !== "string") {
          resolve(address.port);
          return;
        }
        reject(new Error("failed to allocate a loopback port"));
      });
    });

    await new Promise<void>((resolve, reject) => {
      probe.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    if (!isFetchBlockedPort(port)) {
      return port;
    }
  }

  throw new Error("failed to allocate a fetch-safe loopback port");
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-workbench-task11-"));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function userEvent(text: string, requestId = "req-1"): AgentEvent {
  return { type: "text_delta", requestId, text };
}

export function completedEvent(requestId = "req-1"): AgentEvent {
  return { type: "completed", requestId };
}

export function usageEvent(
  inputTokens = 3,
  outputTokens = 5,
  requestId = "req-1",
): AgentEvent {
  return { type: "usage", requestId, inputTokens, outputTokens };
}

export function toolCallEvent(
  id = "call-1",
  name = "read_file",
  requestId = "req-1",
): AgentEvent {
  return {
    type: "tool_call",
    requestId,
    id,
    name,
    input: { path: "a.txt" },
  };
}

export function routeSelectedEvent(
  routeId = "route-a",
  model = "model-a",
  requestId = "req-1",
): AgentEvent {
  return { type: "route_selected", requestId, routeId, model };
}

export function errorEvent(
  code = "runner_error",
  message = "Agent runner failed.",
  requestId = "req-1",
): AgentEvent {
  return { type: "error", requestId, code, message, retryable: false };
}

export function makeStore(
  dir: string,
  name: string,
  overrides: Partial<FileSessionStoreOptions> = {},
): LocalAgentSessionStoreLike {
  return createFileLocalAgentSessionStore({
    filePath: join(dir, name),
    encryptionKey: makeKey(),
    ...overrides,
  });
}

export type LocalAgentSessionStoreLike = ReturnType<
  typeof createFileLocalAgentSessionStore
>;

export function withSession(
  store: LocalAgentSessionStoreLike,
  run: (session: LocalAgentSession) => void,
): void {
  const session = store.create();
  run(session);
}

export async function withTempDir(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await makeTempDir();
  try {
    await run(dir);
  } finally {
    await cleanupDir(dir);
  }
}

export function expectRejection(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
