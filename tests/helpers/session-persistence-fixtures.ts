import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
