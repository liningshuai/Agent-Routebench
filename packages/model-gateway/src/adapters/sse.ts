import { AdapterError, AdapterStreamError } from "./errors.js";
import { DEFAULT_MAX_FRAME_BYTES } from "./types.js";

/** One dispatched Server-Sent Events frame. */
export interface SseEvent {
  readonly event: string | null;
  readonly data: string;
  readonly id: string | null;
  readonly retry: number | null;
}

export interface SseParserOptions {
  readonly maxFrameBytes?: number;
}

const LF = 0x0a;
const CR = 0x0d;
const EMPTY = new Uint8Array(0);

export function normalizeMaxFrameBytes(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_MAX_FRAME_BYTES;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AdapterError("invalid_adapter_options");
  }
  return value;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

interface FoundLine {
  readonly lineEnd: number;
  readonly next: number;
}

/**
 * Finds the next complete line inside `buffer`.
 *
 * Line terminators are single byte ASCII, so scanning bytes can never cut a
 * multi-byte UTF-8 sequence in half. A CR that is the last buffered byte is held
 * back because it may still turn out to be part of a CRLF pair.
 */
function findLineEnd(
  buffer: Uint8Array,
  start: number,
  atEof: boolean,
): FoundLine | null {
  for (let index = start; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === LF) {
      return { lineEnd: index, next: index + 1 };
    }
    if (byte === CR) {
      if (index + 1 < buffer.length) {
        return {
          lineEnd: index,
          next: buffer[index + 1] === LF ? index + 2 : index + 1,
        };
      }
      if (atEof) {
        return { lineEnd: index, next: index + 1 };
      }
      return null;
    }
  }

  if (atEof && buffer.length > start) {
    return { lineEnd: buffer.length, next: buffer.length };
  }
  return null;
}

function parseRetry(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Incremental Server-Sent Events frame parser.
 *
 * It owns byte-to-frame framing only; interpreting the JSON inside a frame is
 * the provider decoder's job.
 *
 * Size accounting: `maxFrameBytes` bounds **one frame**, not one source chunk.
 * A frame is measured as the UTF-8 bytes of all of its lines, including every
 * line terminator and the terminating blank line. Each frame restarts the count,
 * so a chunk holding many small frames may legitimately exceed the limit in
 * total.
 */
export class SseFrameParser {
  readonly #maxFrameBytes: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  /** Bytes of the current *incomplete* line only, never of later frames. */
  #pending: Uint8Array = EMPTY;
  /** Bytes already consumed by the current frame, reset when it is dispatched. */
  #frameBytes = 0;
  #event: string | null = null;
  #data: string[] = [];
  #id: string | null = null;
  #retry: number | null = null;
  #sawData = false;

  constructor(options: SseParserOptions = {}) {
    this.#maxFrameBytes = normalizeMaxFrameBytes(options.maxFrameBytes);
  }

  /** Eager convenience view: drains the chunk and returns every frame. */
  push(chunk: Uint8Array): SseEvent[] {
    return [...this.framesFrom(chunk)];
  }

  /**
   * Lazy view used by the provider decoders.
   *
   * Frames are produced on demand, so a consumer that reaches a terminal event
   * can abandon the iterator and the remaining bytes of the same chunk are
   * never parsed. Once abandoned, the parser must not be reused.
   *
   * A CR held back at the end of the previous chunk is resolved by the byte
   * that immediately follows it, never by the next newline found somewhere in
   * this chunk: a following LF belongs to the same CRLF terminator, anything
   * else ends the previous line on the CR alone, and an empty chunk keeps
   * waiting without losing that state.
   */
  *framesFrom(chunk: Uint8Array): Generator<SseEvent> {
    let cursor = 0;

    if (
      this.#pending.length > 0 &&
      this.#pending[this.#pending.length - 1] === CR
    ) {
      if (chunk.length === 0) {
        return;
      }

      const consumesLf = chunk[0] === LF;
      const line = this.#pending.subarray(0, this.#pending.length - 1);
      this.#pending = EMPTY;
      this.#frameBytes += line.length + (consumesLf ? 2 : 1);
      if (this.#frameBytes > this.#maxFrameBytes) {
        throw this.#overflow();
      }

      yield* this.#consumeLine(this.#decodeLine(line));
      cursor = consumesLf ? 1 : 0;
    }

    while (cursor < chunk.length) {
      const found = findLineEnd(chunk, cursor, false);
      if (found === null) {
        break;
      }

      const prefix = this.#pending;
      const segment = chunk.subarray(cursor, found.lineEnd);
      const terminatorLength = found.next - found.lineEnd;

      this.#pending = EMPTY;
      this.#frameBytes += prefix.length + segment.length + terminatorLength;
      if (this.#frameBytes > this.#maxFrameBytes) {
        throw this.#overflow();
      }

      const lineBytes =
        prefix.length === 0 ? segment : concatBytes(prefix, segment);

      yield* this.#consumeLine(this.#decodeLine(lineBytes));

      cursor = found.next;
    }

    if (cursor < chunk.length) {
      // Only the trailing partial line may be buffered, and it belongs to the
      // current frame: check the bound *before* copying it into the cache.
      const remaining = chunk.length - cursor;
      if (
        this.#frameBytes + this.#pending.length + remaining >
        this.#maxFrameBytes
      ) {
        throw this.#overflow();
      }
      this.#pending = concatBytes(this.#pending, chunk.subarray(cursor));
    }
  }

  /** Flushes the tail. A frame that never got its blank line is a truncation. */
  finish(): SseEvent[] {
    const out: SseEvent[] = [];
    const tail = this.#pending;
    this.#pending = EMPTY;

    if (tail.length > 0) {
      let cursor = 0;
      while (cursor < tail.length) {
        const found = findLineEnd(tail, cursor, true);
        if (found === null) {
          break;
        }
        const segment = tail.subarray(cursor, found.lineEnd);
        this.#frameBytes += segment.length + (found.next - found.lineEnd);
        if (this.#frameBytes > this.#maxFrameBytes) {
          throw this.#overflow();
        }
        out.push(...this.#consumeLine(this.#decodeLine(segment)));
        cursor = found.next;
      }

      if (cursor < tail.length) {
        const rest = tail.subarray(cursor);
        this.#frameBytes += rest.length;
        if (this.#frameBytes > this.#maxFrameBytes) {
          throw this.#overflow();
        }
        out.push(...this.#consumeLine(this.#decodeLine(rest)));
      }
    }

    try {
      // Flushes decoder state; a dangling partial sequence is malformed.
      this.#decoder.decode();
    } catch {
      throw this.#overflow();
    }

    if (this.#sawData || this.#frameBytes > 0) {
      // The stream stopped in the middle of a frame.
      throw this.#overflow();
    }

    return out;
  }

  #overflow(): AdapterStreamError {
    return new AdapterStreamError("provider_protocol_error");
  }

  #decodeLine(lineBytes: Uint8Array): string {
    try {
      return this.#decoder.decode(lineBytes, { stream: true });
    } catch {
      throw this.#overflow();
    }
  }

  #consumeLine(line: string): SseEvent[] {
    if (line === "") {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      // Comment / keep-alive line: never model content.
      return [];
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data.push(value);
        this.#sawData = true;
        break;
      case "id":
        if (!value.includes("\u0000")) {
          this.#id = value;
        }
        break;
      case "retry":
        this.#retry = parseRetry(value);
        break;
      default:
        // Unknown fields are ignored per the SSE field semantics.
        break;
    }

    return [];
  }

  #dispatch(): SseEvent[] {
    const out: SseEvent[] = [];

    if (this.#sawData) {
      const data = this.#data.join("\n");
      if (data !== "") {
        out.push({
          event: this.#event,
          data,
          id: this.#id,
          retry: this.#retry,
        });
      }
    }

    this.#event = null;
    this.#data = [];
    this.#id = null;
    this.#retry = null;
    this.#sawData = false;
    this.#frameBytes = 0;

    return out;
  }
}

/** Convenience wrapper that frames an existing byte stream. */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array>,
  options: SseParserOptions = {},
): AsyncIterable<SseEvent> {
  const parser = new SseFrameParser(options);
  for await (const chunk of source) {
    yield* parser.framesFrom(chunk);
  }
  yield* parser.finish();
}
