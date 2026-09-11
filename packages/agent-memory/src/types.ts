import type { AgentMessage } from "@agent-workbench/agent-core";

export type MemoryKind = "fact" | "preference" | "decision" | "todo";

export interface MemoryEntry {
  readonly id: string;
  readonly scopeId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryInput {
  readonly id?: string;
  readonly scopeId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly tags?: readonly string[];
}

export interface MemorySearchOptions {
  readonly limit?: number;
}

export interface MemoryStore {
  save(input: MemoryInput): MemoryEntry;
  get(scopeId: string, id: string): MemoryEntry | undefined;
  list(scopeId: string): readonly MemoryEntry[];
  search(
    scopeId: string,
    query: string,
    options?: MemorySearchOptions,
  ): readonly MemoryEntry[];
  delete(scopeId: string, id: string): boolean;
  clear(scopeId: string): number;
}

export interface InMemoryMemoryStoreOptions {
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly maxEntriesPerScope?: number;
  readonly maxContentBytes?: number;
  readonly maxTagsPerEntry?: number;
  readonly maxTagBytes?: number;
}

export const DEFAULT_MAX_MEMORY_ENTRIES_PER_SCOPE = 128;
export const DEFAULT_MAX_MEMORY_CONTENT_BYTES = 16 * 1024;
export const DEFAULT_MAX_MEMORY_TAGS = 16;
export const DEFAULT_MAX_MEMORY_TAG_BYTES = 128;

export const MAX_MEMORY_ENTRIES_PER_SCOPE_LIMIT = 4096;
export const MAX_MEMORY_CONTENT_BYTES_LIMIT = 256 * 1024;
export const MAX_MEMORY_TAGS_LIMIT = 64;
export const MAX_MEMORY_TAG_BYTES_LIMIT = 1024;

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 64;

export interface ContextSummaryRequest {
  readonly messages: readonly AgentMessage[];
  readonly omittedMessageCount: number;
}

export interface ContextSummarizer {
  summarize(
    request: ContextSummaryRequest,
    signal?: AbortSignal,
  ): string | Promise<string>;
}

export interface BuildContextOptions {
  readonly messages: readonly AgentMessage[];
  readonly memoryEntries?: readonly MemoryEntry[];
  readonly maxContextBytes: number;
  readonly maxSummaryBytes?: number;
  readonly summarizer?: ContextSummarizer;
  readonly signal?: AbortSignal;
}

export interface BuildContextResult {
  readonly messages: readonly AgentMessage[];
  readonly compressed: boolean;
  readonly summaryIncluded: boolean;
  readonly omittedMessageCount: number;
  readonly includedMemoryIds: readonly string[];
  readonly contextBytes: number;
}

export const DEFAULT_MAX_SUMMARY_BYTES = 8 * 1024;
