import { failDiscovery } from "./errors.js";
import type { ModelCatalogEntry, ProviderModelCatalog } from "./types.js";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function parseModelEntry(raw: unknown): ModelCatalogEntry {
  if (!isPlainObject(raw)) {
    failDiscovery("providerProtocolError");
  }
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    failDiscovery("providerProtocolError");
  }

  const entry: {
    id: string;
    created?: number;
    createdAt?: string;
    ownedBy?: string;
    displayName?: string;
  } = { id };

  const created = raw.created;
  if (created !== undefined) {
    if (typeof created !== "number" || !Number.isFinite(created)) {
      failDiscovery("providerProtocolError");
    }
    entry.created = created;
  }

  const createdAt = raw.created_at;
  if (createdAt !== undefined) {
    if (typeof createdAt !== "string") {
      failDiscovery("providerProtocolError");
    }
    entry.createdAt = createdAt;
  }

  const ownedBy = raw.owned_by;
  if (ownedBy !== undefined) {
    if (typeof ownedBy !== "string") {
      failDiscovery("providerProtocolError");
    }
    entry.ownedBy = ownedBy;
  }

  const displayName = raw.display_name;
  if (displayName !== undefined) {
    if (typeof displayName !== "string") {
      failDiscovery("providerProtocolError");
    }
    entry.displayName = displayName;
  }

  return entry;
}

/**
 * Parses a provider `/models` JSON document into a normalized catalog.
 *
 * Only standardized fields are returned. Unknown fields are ignored. Duplicate
 * model ids are rejected.
 */
export function parseModelCatalogDocument(
  text: string,
  providerId: string,
  protocol: ProviderModelCatalog["protocol"],
  checkedAt: number,
): ProviderModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failDiscovery("providerProtocolError");
  }

  if (!isPlainObject(parsed)) {
    failDiscovery("providerProtocolError");
  }

  const data = parsed.data;
  if (!Array.isArray(data)) {
    failDiscovery("providerProtocolError");
  }

  const seen = new Set<string>();
  const models: ModelCatalogEntry[] = [];
  for (const item of data) {
    const entry = parseModelEntry(item);
    if (seen.has(entry.id)) {
      failDiscovery("duplicateModelId");
    }
    seen.add(entry.id);
    models.push(entry);
  }

  return {
    providerId,
    protocol,
    models,
    checkedAt,
  };
}

/** Reads a UTF-8 body with a hard byte limit. */
export async function readBodyText(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let size = 0;

  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (isAborted(signal)) {
        failDiscovery("aborted");
      }

      const raced = await Promise.race([
        iterator.next().then(
          (result) => ({ kind: "next" as const, result }),
          () => ({ kind: "error" as const }),
        ),
        new Promise<{ kind: "abort" }>((resolve) => {
          if (isAborted(signal)) {
            resolve({ kind: "abort" });
            return;
          }
          signal?.addEventListener("abort", () => resolve({ kind: "abort" }), {
            once: true,
          });
        }),
      ]);

      if (raced.kind === "abort" || raced.kind === "error") {
        failDiscovery(raced.kind === "abort" ? "aborted" : "providerProtocolError");
      }

      if (raced.result.done === true) {
        break;
      }

      const value = raced.result.value;
      if (
        !(value instanceof Uint8Array) &&
        Object.prototype.toString.call(value) !== "[object Uint8Array]"
      ) {
        failDiscovery("providerProtocolError");
      }
      size += value.byteLength;
      if (size > maxBytes) {
        failDiscovery("responseTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    try {
      const returned = iterator.return?.();
      if (
        returned !== undefined &&
        typeof (returned as Promise<unknown>).then === "function"
      ) {
        void (returned as Promise<unknown>).then(
          () => undefined,
          () => undefined,
        );
      }
    } catch {
      // best effort
    }
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decoder.decode(merged);
  } catch {
    // Invalid UTF-8 must not become a replacement-character catalog.
    failDiscovery("providerProtocolError");
  }
}
