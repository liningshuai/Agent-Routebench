import type { AgentMessage } from "../../packages/agent-core/src/index.js";
import {
  InMemoryMemoryStore,
  type MemoryEntry,
  type MemoryKind,
} from "../../packages/agent-memory/src/index.js";

export function userText(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export function systemText(text: string): AgentMessage {
  return { role: "system", content: [{ type: "text", text }] };
}

export function assistantText(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

export function assistantToolCall(id: string, name = "read_file"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, input: { path: "a.txt" } }],
  };
}

export function toolResult(toolCallId: string, content = "ok"): AgentMessage {
  return {
    role: "tool",
    content: [{ type: "tool_result", toolCallId, content }],
  };
}

export function makeMemoryStore(
  overrides: ConstructorParameters<typeof InMemoryMemoryStore>[0] = {},
): InMemoryMemoryStore {
  return new InMemoryMemoryStore(overrides);
}

export function saveFact(
  store: InMemoryMemoryStore,
  scopeId: string,
  content: string,
  tags: string[] = [],
  kind: MemoryKind = "fact",
): MemoryEntry {
  return store.save({ scopeId, kind, content, tags });
}

export function makeMemoryEntry(
  overrides: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    id: "mem-1",
    scopeId: "scope-a",
    kind: "fact",
    content: "likes TypeScript",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function scriptedSummarizer(
  text: string,
  options?: {
    onCall?: () => void;
    delayMs?: number;
    rejectWith?: unknown;
    signalSeen?: AbortSignal | undefined;
  },
): {
  summarize: (
    request: { messages: readonly AgentMessage[]; omittedMessageCount: number },
    signal?: AbortSignal,
  ) => Promise<string>;
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async summarize(_request, signal) {
      calls += 1;
      options?.onCall?.();
      if (options?.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      if (options?.rejectWith !== undefined) {
        throw options.rejectWith;
      }
      if (options?.signalSeen) {
        // no-op, used for type inference
      }
      void signal;
      return text;
    },
  };
}
