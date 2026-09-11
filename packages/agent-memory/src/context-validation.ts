import type { AgentMessage } from "@agent-workbench/agent-core";
import { validateAgentMessages } from "@agent-workbench/agent-core";
import { failContext } from "./errors.js";
import type {
  BuildContextOptions,
  ContextSummarizer,
  MemoryEntry,
} from "./types.js";
import { DEFAULT_MAX_SUMMARY_BYTES } from "./types.js";

const ALLOWED_OPTION_FIELDS = new Set([
  "messages",
  "memoryEntries",
  "maxContextBytes",
  "maxSummaryBytes",
  "summarizer",
  "signal",
]);

const SENSITIVE_FIELDS = new Set([
  "apikey",
  "api_key",
  "token",
  "authorization",
  "headers",
  "baseurl",
  "base_url",
  "endpoint",
  "secret",
  "credential",
  "password",
]);

const MEMORY_ALLOWED_FIELDS = new Set([
  "id",
  "scopeId",
  "kind",
  "content",
  "tags",
  "createdAt",
  "updatedAt",
]);

const KINDS = new Set(["fact", "preference", "decision", "todo"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

export function estimateContextBytes(messages: readonly AgentMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export function assertSummarizer(
  value: unknown,
): asserts value is ContextSummarizer {
  if (typeof value !== "object" || value === null) {
    failContext("invalidOptions");
  }
  const method = (value as Record<string, unknown>).summarize;
  if (typeof method !== "function") {
    failContext("invalidOptions");
  }
}

export function assertMemoryEntry(
  input: unknown,
): asserts input is MemoryEntry {
  if (!isPlainObject(input)) {
    failContext("invalidMemory");
  }
  for (const key of Object.keys(input)) {
    if (!MEMORY_ALLOWED_FIELDS.has(key) || SENSITIVE_FIELDS.has(key.toLowerCase())) {
      failContext("invalidMemory");
    }
  }
  if (typeof input.id !== "string" || input.id.length === 0) {
    failContext("invalidMemory");
  }
  if (typeof input.scopeId !== "string" || input.scopeId.length === 0) {
    failContext("invalidMemory");
  }
  if (typeof input.kind !== "string" || !KINDS.has(input.kind)) {
    failContext("invalidMemory");
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    failContext("invalidMemory");
  }
  if (!Array.isArray(input.tags)) {
    failContext("invalidMemory");
  }
  if (
    typeof input.createdAt !== "number" ||
    !Number.isFinite(input.createdAt) ||
    typeof input.updatedAt !== "number" ||
    !Number.isFinite(input.updatedAt)
  ) {
    failContext("invalidMemory");
  }
}

export function parseBuildOptions(
  options: BuildContextOptions,
): {
  messages: readonly AgentMessage[];
  memoryEntries: readonly MemoryEntry[];
  maxContextBytes: number;
  maxSummaryBytes: number;
  summarizer: ContextSummarizer | undefined;
  signal: AbortSignal | undefined;
} {
  if (
    options === null ||
    options === undefined ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    failContext("invalidOptions");
  }
  const raw = options as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_OPTION_FIELDS.has(key) || SENSITIVE_FIELDS.has(key.toLowerCase())) {
      failContext("invalidOptions");
    }
  }

  const messages = raw.messages;
  if (!Array.isArray(messages)) {
    failContext("invalidMessages");
  }
  try {
    validateAgentMessages(messages as AgentMessage[]);
  } catch {
    failContext("invalidMessages");
  }

  const maxContextBytes = raw.maxContextBytes;
  if (
    typeof maxContextBytes !== "number" ||
    !Number.isInteger(maxContextBytes) ||
    maxContextBytes <= 0
  ) {
    failContext("invalidOptions");
  }

  let maxSummaryBytes = DEFAULT_MAX_SUMMARY_BYTES;
  if (raw.maxSummaryBytes !== undefined) {
    if (
      typeof raw.maxSummaryBytes !== "number" ||
      !Number.isInteger(raw.maxSummaryBytes) ||
      raw.maxSummaryBytes <= 0
    ) {
      failContext("invalidOptions");
    }
    maxSummaryBytes = raw.maxSummaryBytes;
  }

  let summarizer: ContextSummarizer | undefined;
  if (raw.summarizer !== undefined) {
    assertSummarizer(raw.summarizer);
    summarizer = raw.summarizer;
  }

  const memoryEntriesRaw = raw.memoryEntries;
  const memoryEntries: MemoryEntry[] = [];
  if (memoryEntriesRaw !== undefined) {
    if (!Array.isArray(memoryEntriesRaw)) {
      failContext("invalidMemory");
    }
    const seen = new Set<string>();
    for (const entry of memoryEntriesRaw) {
      assertMemoryEntry(entry);
      if (seen.has(entry.id)) {
        failContext("invalidMemory");
      }
      seen.add(entry.id);
      memoryEntries.push({
        id: entry.id,
        scopeId: entry.scopeId,
        kind: entry.kind,
        content: entry.content,
        tags: [...entry.tags],
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
  }

  const signal = raw.signal;
  if (signal !== undefined && signal !== null) {
    if (typeof signal !== "object" || typeof (signal as AbortSignal).aborted !== "boolean") {
      failContext("invalidOptions");
    }
  }

  return {
    messages: structuredClone(messages) as AgentMessage[],
    memoryEntries,
    maxContextBytes,
    maxSummaryBytes,
    summarizer,
    signal: signal as AbortSignal | undefined,
  };
}

export function renderMemoryMessage(entries: readonly MemoryEntry[]): AgentMessage {
  const lines = entries.map((entry) => `- [${entry.kind}] ${entry.content}`);
  return {
    role: "system",
    content: [{ type: "text", text: `[Retrieved memory]\n${lines.join("\n")}` }],
  };
}
