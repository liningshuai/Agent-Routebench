import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fail } from "./errors.js";
import type { JsonConfigStore } from "./json-store.js";
import { validateConfigSnapshot } from "./snapshot.js";
import type { PersistedConfigV1 } from "./types.js";

export interface FileJsonConfigStoreOptions {
  readonly filePath: string;
}

function assertAbsolutePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== "string" || filePath.length === 0) {
    fail("invalidConfigFilePath");
  }
  if (filePath.includes("\0") || filePath.includes("?") || filePath.includes("#")) {
    fail("invalidConfigFilePath");
  }
  if (!isAbsolute(filePath)) {
    fail("invalidConfigFilePath");
  }
}

function serializeSnapshot(snapshot: PersistedConfigV1): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

class FileJsonConfigStore implements JsonConfigStore {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<PersistedConfigV1 | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      fail("configFileInvalid");
    }

    if (raw.trim().length === 0) {
      fail("configFileInvalid");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail("configFileInvalid");
    }

    return validateConfigSnapshot(parsed);
  }

  async save(snapshot: unknown): Promise<void> {
    const run = this.#queue.then(() => this.#saveOnce(snapshot));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async #saveOnce(snapshot: unknown): Promise<void> {
    const validated = validateConfigSnapshot(snapshot);
    const payload = serializeSnapshot(validated);

    const directory = dirname(this.#filePath);
    const base = basename(this.#filePath);
    const tempPath = join(directory, `.${base}.${Date.now()}.tmp`);

    try {
      await writeFile(tempPath, payload, { encoding: "utf8", flag: "wx" });
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined);
      fail("configFileWriteFailed");
    }

    try {
      await rename(tempPath, this.#filePath);
    } catch {
      await rm(tempPath, { force: true }).catch(() => undefined);
      fail("configFileReplaceFailed");
    }
  }
}

/**
 * Creates a file-backed JSON config store.
 *
 * The path must be a non-empty absolute path without query or hash. Saves
 * are atomic: validate, write a sibling temp file, then rename over the
 * target. Concurrent saves on the same store are serialized.
 */
export function createFileJsonConfigStore(
  options: FileJsonConfigStoreOptions,
): JsonConfigStore {
  if (options === null || typeof options !== "object") {
    fail("invalidConfigFilePath");
  }
  assertAbsolutePath(options.filePath);
  return new FileJsonConfigStore(options.filePath);
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {
    fail("configFileWriteFailed");
  }
}
