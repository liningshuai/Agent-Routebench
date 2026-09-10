import { fail } from "./errors.js";
import { validateConfigSnapshot } from "./snapshot.js";
import type { PersistedConfigV1 } from "./types.js";

export interface JsonConfigStore {
  load(): Promise<PersistedConfigV1 | undefined>;
  save(snapshot: unknown): Promise<void>;
}

function cloneSnapshot(snapshot: PersistedConfigV1): PersistedConfigV1 {
  return structuredClone(snapshot);
}

/**
 * In-memory JSON config store for offline tests.
 *
 * Deep-copies both directions, validates before every write and serializes
 * concurrent saves so they cannot interleave.
 */
export class InMemoryJsonConfigStore implements JsonConfigStore {
  #current: PersistedConfigV1 | undefined;
  #queue: Promise<void> = Promise.resolve();

  async load(): Promise<PersistedConfigV1 | undefined> {
    if (this.#current === undefined) {
      return undefined;
    }
    return cloneSnapshot(this.#current);
  }

  async save(snapshot: unknown): Promise<void> {
    const run = this.#queue.then(async () => {
      const validated = validateConfigSnapshot(snapshot);
      this.#current = cloneSnapshot(validated);
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }
}

export function isValidPersistedSnapshot(
  value: unknown,
): value is PersistedConfigV1 {
  try {
    validateConfigSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

export function rejectInvalidSnapshot(): never {
  return fail("invalidPersistedConfig");
}
