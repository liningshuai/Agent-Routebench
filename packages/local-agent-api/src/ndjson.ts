import type { Writable } from "node:stream";

/** Writes one NDJSON line. Returns false when the socket is backed up. */
export function writeNdjsonLine(res: Writable, value: unknown): boolean {
  return res.write(`${JSON.stringify(value)}\n`);
}
