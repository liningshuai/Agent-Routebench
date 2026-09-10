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

interface LineSlice {
  readonly line: Uint8Array;
  readonly consumed: number;
}

/**
 * Finds the next complete line.
 *
 * Line terminators are single byte ASCII, so scanning bytes can never cut a
 * multi-byte UTF-8 sequence in half. A CR that is the last buffered byte is
 * held back because it may still turn out to be part of a CRLF pair.
 */
function takeLine(buffer: Uint8Array, atEof: boolean): LineSlice | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === LF) {
      return { line: buffer.subarray(0, index), consumed: index + 1 };
    }
    if (byte === CR) {
      if (index + 1 < buffer.length) {
        const terminator = buffer[index + 1] === LF ? 2 : 1;
        return { line: buffer.subarray(0, index), consumed: index + terminator };
      }
      if (atEof) {
        return { line: buffer.subarray(0, index), consumed: index + 1 };
      }
      return null;
    }
  }

  if (atEof && buffer.length > 0) {
    return { line: buffer.subarray(0, buffer.length), consumed: buffer.length };
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
 * the provider decoder's job. Frames are streamed out as soon as their
 * terminating blank line arrives, and the parser never retains a frame after it
 * has been dispatched.
 */
export class SseFrameParser {
  readonly #maxFrameBytes: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  #pending: Uint8Array = new Uint8Array(0);
  #frameBytes = 0;
  #event: string | null = null;
  #data: string[] = [];
  #id: string | null = null;
  #retry: number | null = null;
  #sawData = false;

  constructor(options: SseParserOptions = {}) {
    this.#maxFrameBytes = normalizeMaxFrameBytes(options.maxFrameBytes);
  }

  push(chunk: Uint8Array): SseEvent[] {
    const out: SseEvent[] = [];
    this.#pending = concatBytes(this.#pending, chunk);
    this.#drain(out, false);
    return out;
  }

  finish(): SseEvent[] {
    const out: SseEvent[] = [];
    this.#drain(out, true);

    try {
      // Flushes any decoder state; a dangling partial sequence is malformed.
      this.#decoder.decode();
    } catch {
      throw new AdapterStreamError("provider_protocol_error");
    }

    if (this.#sawData || this.#frameBytes > 0 || this.#pending.length > 0) {
      // The stream stopped in the middle of a frame.
      throw new AdapterStreamError("provider_protocol_error");
    }

    return out;
  }

  #drain(out: SseEvent[], atEof: boolean): void {
    for (;;) {
      const slice = takeLine(this.#pending, atEof);
      if (slice === null) {
        break;
      }
      this.#pending = this.#pending.slice(slice.consumed);
      this.#frameBytes += slice.consumed;
      this.#consumeLine(this.#decodeLine(slice.line), out);
      this.#assertWithinLimit();
    }
    this.#assertWithinLimit();
  }

  #assertWithinLimit(): void {
    // Checked continuously, not only once a whole frame has arrived, so an
    // unterminated frame cannot grow without bound.
    if (this.#frameBytes + this.#pending.length > this.#maxFrameBytes) {
      throw new AdapterStreamError("provider_protocol_error");
    }
  }

  #decodeLine(lineBytes: Uint8Array): string {
    try {
      return this.#decoder.decode(lineBytes, { stream: true });
    } catch {
      throw new AdapterStreamError("provider_protocol_error");
    }
  }

  #consumeLine(line: string, out: SseEvent[]): void {
    if (line === "") {
      this.#dispatch(out);
      return;
    }
    if (line.startsWith(":")) {
      // Comment / keep-alive line: never model content.
      return;
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
  }

  #dispatch(out: SseEvent[]): void {
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
  }
}

/** Convenience wrapper that frames an existing byte stream. */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array>,
  options: SseParserOptions = {},
): AsyncIterable<SseEvent> {
  const parser = new SseFrameParser(options);
  for await (const chunk of source) {
    for (const frame of parser.push(chunk)) {
      yield frame;
    }
  }
  for (const frame of parser.finish()) {
    yield frame;
  }
}
