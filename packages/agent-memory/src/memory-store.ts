import { failMemory } from "./errors.js";
import type {
  InMemoryMemoryStoreOptions,
  MemoryEntry,
  MemoryInput,
  MemoryKind,
  MemorySearchOptions,
  MemoryStore,
} from "./types.js";
import {
  DEFAULT_MAX_MEMORY_CONTENT_BYTES,
  DEFAULT_MAX_MEMORY_ENTRIES_PER_SCOPE,
  DEFAULT_MAX_MEMORY_TAGS,
  DEFAULT_MAX_MEMORY_TAG_BYTES,
  DEFAULT_SEARCH_LIMIT,
  MAX_MEMORY_CONTENT_BYTES_LIMIT,
  MAX_MEMORY_ENTRIES_PER_SCOPE_LIMIT,
  MAX_MEMORY_TAGS_LIMIT,
  MAX_MEMORY_TAG_BYTES_LIMIT,
  MAX_SEARCH_LIMIT,
} from "./types.js";

const KINDS = new Set<MemoryKind>(["fact", "preference", "decision", "todo"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_FIELDS = new Set(["id", "scopeId", "kind", "content", "tags"]);
const SENSITIVE_FIELDS = new Set([
  "apikey",
  "api_key",
  "token",
  "authorization",
  "headers",
  "password",
  "secret",
  "credential",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalizeLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    failMemory("invalidOptions");
  }
  return value;
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return {
    id: entry.id,
    scopeId: entry.scopeId,
    kind: entry.kind,
    content: entry.content,
    tags: [...entry.tags],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function assertId(value: unknown, key: "invalidMemoryId" | "invalidEntry"): asserts value is string {
  if (!isNonEmptyString(value) || !ID_PATTERN.test(value)) {
    failMemory(key);
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #maxEntries: number;
  readonly #maxContentBytes: number;
  readonly #maxTags: number;
  readonly #maxTagBytes: number;
  readonly #byScope = new Map<string, Map<string, MemoryEntry>>();

  constructor(options: InMemoryMemoryStoreOptions = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      failMemory("invalidOptions");
    }
    const raw = options as Partial<InMemoryMemoryStoreOptions>;
    const clock = raw.clock ?? Date.now;
    const idFactory = raw.idFactory ?? (() => `mem-${String(Math.random()).slice(2)}`);
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      failMemory("invalidOptions");
    }
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#maxEntries = normalizeLimit(
      raw.maxEntriesPerScope,
      DEFAULT_MAX_MEMORY_ENTRIES_PER_SCOPE,
      MAX_MEMORY_ENTRIES_PER_SCOPE_LIMIT,
    );
    this.#maxContentBytes = normalizeLimit(
      raw.maxContentBytes,
      DEFAULT_MAX_MEMORY_CONTENT_BYTES,
      MAX_MEMORY_CONTENT_BYTES_LIMIT,
    );
    this.#maxTags = normalizeLimit(
      raw.maxTagsPerEntry,
      DEFAULT_MAX_MEMORY_TAGS,
      MAX_MEMORY_TAGS_LIMIT,
    );
    this.#maxTagBytes = normalizeLimit(
      raw.maxTagBytes,
      DEFAULT_MAX_MEMORY_TAG_BYTES,
      MAX_MEMORY_TAG_BYTES_LIMIT,
    );
  }

  save(input: MemoryInput): MemoryEntry {
    if (!isPlainObject(input)) {
      failMemory("invalidEntry");
    }
    const raw = input as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (SENSITIVE_FIELDS.has(key.toLowerCase()) || !ALLOWED_FIELDS.has(key)) {
        failMemory("invalidEntry");
      }
    }

    assertId(raw.scopeId, "invalidEntry");
    if (!KINDS.has(raw.kind as MemoryKind)) {
      failMemory("invalidEntry");
    }
    if (!isNonEmptyString(raw.content) || byteLength(raw.content) > this.#maxContentBytes) {
      failMemory("invalidEntry");
    }
    if (raw.content.includes("\0") || (raw.scopeId as string).includes("\0")) {
      failMemory("invalidEntry");
    }

    const tagsRaw = raw.tags;
    const tags: string[] = [];
    if (tagsRaw !== undefined) {
      if (!Array.isArray(tagsRaw)) {
        failMemory("invalidEntry");
      }
      if (tagsRaw.length > this.#maxTags) {
        failMemory("invalidEntry");
      }
      const seen = new Set<string>();
      for (const tag of tagsRaw) {
        if (!isNonEmptyString(tag) || seen.has(tag) || tag.includes("\0")) {
          failMemory("invalidEntry");
        }
        if (byteLength(tag) > this.#maxTagBytes) {
          failMemory("invalidEntry");
        }
        seen.add(tag);
        tags.push(tag);
      }
    }

    let id: string;
    if (raw.id === undefined) {
      id = this.#idFactory();
    } else {
      id = raw.id as string;
    }
    assertId(id, "invalidMemoryId");
    if (id.includes("\0")) {
      failMemory("invalidMemoryId");
    }

    const scopeId = raw.scopeId as string;
    const kind = raw.kind as MemoryKind;
    const content = raw.content as string;
    let scope = this.#byScope.get(scopeId);
    if (scope === undefined) {
      scope = new Map<string, MemoryEntry>();
      this.#byScope.set(scopeId, scope);
    }

    const existing = scope.get(id);
    if (existing === undefined && scope.size >= this.#maxEntries) {
      failMemory("memoryLimitExceeded");
    }

    const now = this.#clock();
    const entry: MemoryEntry = {
      id,
      scopeId,
      kind,
      content,
      tags: [...tags],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    scope.set(id, entry);
    return cloneEntry(entry);
  }

  get(scopeId: string, id: string): MemoryEntry | undefined {
    const scope = this.#byScope.get(scopeId);
    const entry = scope?.get(id);
    return entry === undefined ? undefined : cloneEntry(entry);
  }

  list(scopeId: string): readonly MemoryEntry[] {
    const scope = this.#byScope.get(scopeId);
    if (scope === undefined) return [];
    const entries = [...scope.values()].map(cloneEntry);
    entries.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return entries;
  }

  search(
    scopeId: string,
    query: string,
    options: MemorySearchOptions = {},
  ): readonly MemoryEntry[] {
    if (typeof query !== "string" || query.trim().length === 0) {
      failMemory("invalidQuery");
    }
    const limitRaw = (options as { limit?: unknown }).limit;
    let limit = DEFAULT_SEARCH_LIMIT;
    if (limitRaw !== undefined) {
      if (
        typeof limitRaw !== "number" ||
        !Number.isInteger(limitRaw) ||
        limitRaw <= 0 ||
        limitRaw > MAX_SEARCH_LIMIT
      ) {
        failMemory("invalidQuery");
      }
      limit = limitRaw;
    }

    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const scope = this.#byScope.get(scopeId);
    if (scope === undefined) return [];

    const scored: { entry: MemoryEntry; score: number }[] = [];
    for (const entry of scope.values()) {
      const haystack = `${entry.content}\n${entry.tags.join("\n")}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 1;
      }
      if (score > 0) scored.push({ entry: cloneEntry(entry), score });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.entry.updatedAt !== b.entry.updatedAt) {
        return b.entry.updatedAt - a.entry.updatedAt;
      }
      return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
    });

    return scored.slice(0, limit).map((s) => s.entry);
  }

  delete(scopeId: string, id: string): boolean {
    const scope = this.#byScope.get(scopeId);
    if (scope === undefined) return false;
    return scope.delete(id);
  }

  clear(scopeId: string): number {
    const scope = this.#byScope.get(scopeId);
    if (scope === undefined) return 0;
    const size = scope.size;
    scope.clear();
    return size;
  }
}
