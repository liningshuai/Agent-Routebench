export const MEMORY_ERROR_CODES = Object.freeze({
  invalidOptions: "invalid_memory_options",
  invalidEntry: "invalid_memory_entry",
  invalidQuery: "invalid_memory_query",
  memoryLimitExceeded: "memory_limit_exceeded",
  invalidMemoryId: "invalid_memory_id",
} as const);

export type MemoryErrorCodeKey = keyof typeof MEMORY_ERROR_CODES;

const MEMORY_MESSAGES = Object.freeze({
  invalidOptions: "Memory options are invalid.",
  invalidEntry: "Memory entry is invalid.",
  invalidQuery: "Memory query is invalid.",
  memoryLimitExceeded: "Memory limit exceeded.",
  invalidMemoryId: "Memory id is invalid.",
} as const);

export class MemoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

export function memoryError(key: MemoryErrorCodeKey): MemoryError {
  return new MemoryError(MEMORY_ERROR_CODES[key], MEMORY_MESSAGES[key]);
}

export function failMemory(key: MemoryErrorCodeKey): never {
  throw memoryError(key);
}

export const CONTEXT_ERROR_CODES = Object.freeze({
  invalidOptions: "invalid_context_options",
  invalidMessages: "invalid_context_messages",
  invalidMemory: "invalid_context_memory",
  contextBudgetExceeded: "context_budget_exceeded",
  compressionRequired: "context_compression_required",
  compressionFailed: "context_compression_failed",
  summaryInvalid: "context_summary_invalid",
  summaryTooLarge: "context_summary_too_large",
  aborted: "context_aborted",
} as const);

export type ContextErrorCodeKey = keyof typeof CONTEXT_ERROR_CODES;

const CONTEXT_MESSAGES = Object.freeze({
  invalidOptions: "Context options are invalid.",
  invalidMessages: "Context messages are invalid.",
  invalidMemory: "Context memory is invalid.",
  contextBudgetExceeded: "Context budget exceeded.",
  compressionRequired: "Context compression is required.",
  compressionFailed: "Context compression failed.",
  summaryInvalid: "Context summary is invalid.",
  summaryTooLarge: "Context summary exceeds the size limit.",
  aborted: "Context build aborted.",
} as const);

export class ContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

export function contextError(key: ContextErrorCodeKey): ContextError {
  return new ContextError(CONTEXT_ERROR_CODES[key], CONTEXT_MESSAGES[key]);
}

export function failContext(key: ContextErrorCodeKey): never {
  throw contextError(key);
}
