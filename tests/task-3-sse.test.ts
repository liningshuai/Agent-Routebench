import { describe, expect, it } from "vitest";
import {
  AdapterError,
  AdapterStreamError,
} from "../packages/model-gateway/src/adapters/errors.js";
import {
  SseFrameParser,
  parseSseStream,
} from "../packages/model-gateway/src/adapters/sse.js";
import {
  bytes,
  concatBytes,
  fromChunks,
  splitBytes,
} from "./helpers/adapter-fixtures.js";

function parseAll(chunks: readonly Uint8Array[]) {
  const parser = new SseFrameParser();
  const out = [];
  for (const chunk of chunks) {
    out.push(...parser.push(chunk));
  }
  out.push(...parser.finish());
  return out;
}

function streamErrorCode(run: () => unknown): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AdapterStreamError);
  return (caught as AdapterStreamError).code;
}

describe("task 3 sse — framing", () => {
  it("decodes one frame delivered byte by byte", () => {
    const payload = 'data: {"type":"ping"}\n\n';
    const frames = parseAll(splitBytes(bytes(payload), 1));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      event: null,
      data: '{"type":"ping"}',
      id: null,
      retry: null,
    });
  });

  it("keeps multi-byte characters intact when split mid sequence", () => {
    const payload = "data: \u4f60\u597d\ud83d\ude80\n\n";
    const frames = parseAll(splitBytes(bytes(payload), 1));

    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe("\u4f60\u597d\ud83d\ude80");
  });

  it("reassembles a frame spread across many chunks", () => {
    const payload = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const frames = parseAll(splitBytes(bytes(payload), 3));

    expect(frames).toEqual([
      {
        event: "message_stop",
        data: '{"type":"message_stop"}',
        id: null,
        retry: null,
      },
    ]);
  });

  it("splits several frames delivered in a single chunk", () => {
    const chunk = bytes("data: a\n\ndata: b\n\ndata: c\n\n");
    const frames = parseAll([chunk]);

    expect(frames.map((frame) => frame.data)).toEqual(["a", "b", "c"]);
  });

  it("accepts LF and CRLF line endings", () => {
    const frames = parseAll([bytes("data: lf\n\ndata: crlf\r\n\r\n")]);
    expect(frames.map((frame) => frame.data)).toEqual(["lf", "crlf"]);
  });

  it("handles a CR that is split from its LF across chunks", () => {
    const parser = new SseFrameParser();
    const first = parser.push(bytes("data: value\r"));
    expect(first).toEqual([]);

    const second = parser.push(bytes("\n\r\n"));
    expect(second.map((frame) => frame.data)).toEqual(["value"]);
    expect(parser.finish()).toEqual([]);
  });

  it("treats a bare CR as a line terminator", () => {
    const frames = parseAll([bytes("data: solo\r\r")]);
    expect(frames.map((frame) => frame.data)).toEqual(["solo"]);
  });

  it("joins multiple data lines with a newline", () => {
    const frames = parseAll([bytes("data: line1\ndata: line2\ndata: line3\n\n")]);
    expect(frames[0].data).toBe("line1\nline2\nline3");
  });

  it("ignores comment lines and never turns them into data", () => {
    const frames = parseAll([
      bytes(": keep-alive\ndata: real\n: trailing comment\n\n"),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe("real");
  });

  it("drops frames that carry no data field", () => {
    const frames = parseAll([bytes(": comment only\n\nevent: empty\n\nretry: 100\n\n")]);
    expect(frames).toEqual([]);
  });

  it("reads event, id and retry fields", () => {
    const frames = parseAll([
      bytes('event: message_start\nid: 42\nretry: 1500\ndata: {"type":"x"}\n\n'),
    ]);

    expect(frames).toEqual([
      {
        event: "message_start",
        data: '{"type":"x"}',
        id: "42",
        retry: 1500,
      },
    ]);
  });

  it("ignores an id containing a NUL character and a non numeric retry", () => {
    const frames = parseAll([bytes("id: bad\u0000id\nretry: soon\ndata: payload\n\n")]);

    expect(frames).toEqual([
      { event: null, data: "payload", id: null, retry: null },
    ]);
  });

  it("handles a frame that ends exactly on the last chunk boundary", () => {
    const parser = new SseFrameParser();
    expect(parser.push(bytes("data: tail\n\n")).map((frame) => frame.data)).toEqual([
      "tail",
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it("supports the async generator wrapper", async () => {
    const collected: string[] = [];
    for await (const frame of parseSseStream(
      fromChunks([bytes("data: one\n\ndata: "), bytes("two\n\n")]),
    )) {
      collected.push(frame.data);
    }
    expect(collected).toEqual(["one", "two"]);
  });
});

describe("task 3 sse — malformed input and limits", () => {
  it("rejects invalid UTF-8 with a protocol error", () => {
    const parser = new SseFrameParser();
    const invalid = concatBytes([
      bytes("data: "),
      new Uint8Array([0xff, 0xfe]),
      bytes("\n\n"),
    ]);

    expect(streamErrorCode(() => parser.push(invalid))).toBe(
      "provider_protocol_error",
    );
  });

  it("rejects a truncated frame at EOF", () => {
    expect(
      streamErrorCode(() => parseAll([bytes("data: never terminated\n")])),
    ).toBe("provider_protocol_error");

    expect(streamErrorCode(() => parseAll([bytes("data: no newline at all")]))).toBe(
      "provider_protocol_error",
    );
  });

  it("rejects a frame larger than the byte limit", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 16 });
    expect(streamErrorCode(() => parser.push(bytes(`data: ${"x".repeat(64)}\n\n`)))).toBe(
      "provider_protocol_error",
    );
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    // 10 CJK characters are 30 UTF-8 bytes but only 10 code units.
    const parser = new SseFrameParser({ maxFrameBytes: 20 });
    expect(streamErrorCode(() => parser.push(bytes("data: \u4f60\u4f60\u4f60\u4f60\u4f60\u4f60\u4f60\u4f60\u4f60\u4f60")))).toBe(
      "provider_protocol_error",
    );
  });

  it("enforces the limit while a frame is still incomplete", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 32 });
    // No terminator at all: a non streaming implementation would never check.
    expect(streamErrorCode(() => parser.push(bytes("x".repeat(200))))).toBe(
      "provider_protocol_error",
    );
  });

  it("accepts a frame that stays within the limit", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 64 });
    const frames = parser.push(bytes("data: small\n\n"));
    expect(frames.map((frame) => frame.data)).toEqual(["small"]);
  });

  it("rejects invalid frame limits", () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      let caught: unknown;
      try {
        new SseFrameParser({ maxFrameBytes: value });
      } catch (error) {
        caught = error;
      }
      expect(caught, `maxFrameBytes=${String(value)}`).toBeInstanceOf(AdapterError);
      expect((caught as AdapterError).code).toBe("invalid_adapter_options");
    }
  });

  it("does not retain processed frames", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 128 });
    let total = 0;
    for (let index = 0; index < 500; index += 1) {
      total += parser.push(bytes(`data: frame-${index}\n\n`)).length;
    }
    expect(parser.finish()).toEqual([]);
    expect(total).toBe(500);
  });
});

describe("task 3 sse — rework: per frame limit accounting", () => {
  it("accepts several small frames whose combined size exceeds the frame limit", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 16 });
    const frames = parser.push(bytes("data: x\n\ndata: y\n\ndata: z\n\n"));

    expect(frames.map((frame) => frame.data)).toEqual(["x", "y", "z"]);
    expect(parser.finish()).toEqual([]);
  });

  it("produces the same frames whatever the chunking", () => {
    const input = "data: x\n\ndata: y\n\ndata: z\n\n";
    const expected = ["x", "y", "z"];

    expect(parseAll([bytes(input)]).map((frame) => frame.data)).toEqual(expected);
    expect(
      parseAll([
        bytes("data: x\n\n"),
        bytes("data: y\n\n"),
        bytes("data: z\n\n"),
      ]).map((frame) => frame.data),
    ).toEqual(expected);
    expect(
      parseAll(splitBytes(bytes(input), 1)).map((frame) => frame.data),
    ).toEqual(expected);
  });

  it("accepts a frame exactly at the limit and rejects one byte over", () => {
    // "data: x\n\n" is 9 bytes: 7 content + 1 LF + 1 blank line LF.
    expect(
      new SseFrameParser({ maxFrameBytes: 9 }).push(bytes("data: x\n\n")),
    ).toHaveLength(1);
    expect(
      streamErrorCode(() =>
        new SseFrameParser({ maxFrameBytes: 8 }).push(bytes("data: x\n\n")),
      ),
    ).toBe("provider_protocol_error");
  });

  it("rejects a frame that only overflows once the final blank line is counted", () => {
    // "data: xy\n" is 9 bytes; the terminating blank line makes it 10.
    expect(
      new SseFrameParser({ maxFrameBytes: 10 }).push(bytes("data: xy\n\n")),
    ).toHaveLength(1);
    expect(
      streamErrorCode(() =>
        new SseFrameParser({ maxFrameBytes: 9 }).push(bytes("data: xy\n\n")),
      ),
    ).toBe("provider_protocol_error");
  });

  it("rejects an unterminated frame that grows past the limit across chunks", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 32 });
    parser.push(bytes("x".repeat(20)));

    expect(streamErrorCode(() => parser.push(bytes("y".repeat(20))))).toBe(
      "provider_protocol_error",
    );
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    const cjk = "\u4f60".repeat(10); // 10 characters, 30 bytes
    const payload = `data: ${cjk}\n\n`; // 6 + 30 + 2 = 38 bytes, 18 characters

    expect(
      new SseFrameParser({ maxFrameBytes: 38 }).push(bytes(payload)),
    ).toHaveLength(1);
    expect(
      streamErrorCode(() =>
        new SseFrameParser({ maxFrameBytes: 37 }).push(bytes(payload)),
      ),
    ).toBe("provider_protocol_error");
  });

  it("counts supplementary plane characters as four bytes each", () => {
    const emoji = "\ud83d\ude80".repeat(6); // 6 code points, 24 bytes
    const payload = `data: ${emoji}\n\n`; // 6 + 24 + 2 = 32 bytes, 14 code units

    expect(
      new SseFrameParser({ maxFrameBytes: 32 }).push(bytes(payload)),
    ).toHaveLength(1);
    expect(
      streamErrorCode(() =>
        new SseFrameParser({ maxFrameBytes: 31 }).push(bytes(payload)),
      ),
    ).toBe("provider_protocol_error");
    // A character based check with the same limit would wrongly accept it.
    expect(payload.length).toBeLessThan(32);
  });

  it("restarts the count for the next frame after a frame completes", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 16 });
    const seen: string[] = [];

    for (let index = 0; index < 25; index += 1) {
      for (const frame of parser.push(bytes(`data: ${index}\n\n`))) {
        seen.push(frame.data);
      }
    }

    expect(seen).toHaveLength(25);
    expect(seen[0]).toBe("0");
    expect(seen[24]).toBe("24");
    expect(parser.finish()).toEqual([]);
  });

  it("accepts a large chunk made of many small frames", () => {
    const chunk = Array.from(
      { length: 500 },
      (_, index) => `data: n${index}\n\n`,
    ).join("");

    const frames = new SseFrameParser({ maxFrameBytes: 32 }).push(bytes(chunk));

    expect(frames).toHaveLength(500);
    expect(frames[499].data).toBe("n499");
  });
});

describe("task 3 sse — rework: lazy frame production", () => {
  function chunkWithTrailingInvalidBytes(): Uint8Array {
    return concatBytes([
      bytes("data: a\n\ndata: b\n\n"),
      new Uint8Array([0xff, 0xfe]),
      bytes("\n\n"),
    ]);
  }

  it("exposes a lazy frame view that can be abandoned mid chunk", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 64 });
    const iterator = parser.framesFrom(chunkWithTrailingInvalidBytes())[
      Symbol.iterator
    ]();

    expect(iterator.next().value).toEqual({
      event: null,
      data: "a",
      id: null,
      retry: null,
    });
    expect(iterator.next().value?.data).toBe("b");

    // Abandoning here must not raise, even though the chunk tail is malformed.
    expect(iterator.next).toBeTypeOf("function");

    // The tail really is malformed: the eager view on a fresh parser raises.
    expect(
      streamErrorCode(() =>
        new SseFrameParser({ maxFrameBytes: 64 }).push(
          chunkWithTrailingInvalidBytes(),
        ),
      ),
    ).toBe("provider_protocol_error");
  });

  it("still raises when the lazy view is driven past the malformed frame", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 16 });
    const iterator = parser.framesFrom(chunkWithTrailingInvalidBytes())[
      Symbol.iterator
    ]();

    iterator.next();
    iterator.next();

    let caught: unknown;
    try {
      iterator.next();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdapterStreamError);
    expect((caught as AdapterStreamError).code).toBe("provider_protocol_error");
  });

  it("keeps the eager push() array API working", () => {
    const parser = new SseFrameParser({ maxFrameBytes: 64 });
    const frames = parser.push(bytes("data: eager\n\n"));

    expect(Array.isArray(frames)).toBe(true);
    expect(frames.map((frame) => frame.data)).toEqual(["eager"]);
  });
});

describe("task 3 final fix — CR carries no frame state across chunks", () => {
  function dataOf(chunks: readonly Uint8Array[]): string[] {
    return parseAll(chunks).map((frame) => frame.data);
  }

  function verdictOf(chunks: readonly Uint8Array[], limit?: number): string | null {
    const parser = new SseFrameParser(
      limit === undefined ? {} : { maxFrameBytes: limit },
    );
    try {
      for (const chunk of chunks) {
        parser.push(chunk);
      }
      parser.finish();
      return null;
    } catch (error) {
      return error instanceof AdapterStreamError ? error.code : "unexpected";
    }
  }

  /** Every two-way split of one byte stream, plus the byte-by-byte chunking. */
  function everyChunking(whole: Uint8Array): {
    readonly name: string;
    readonly chunks: readonly Uint8Array[];
  }[] {
    const cases: { name: string; chunks: readonly Uint8Array[] }[] = [
      { name: "whole", chunks: [whole] },
      { name: "byte-wise", chunks: [...splitBytes(whole, 1)] },
    ];
    for (let split = 0; split <= whole.length; split += 1) {
      cases.push({
        name: `split at ${split}`,
        chunks: [whole.subarray(0, split), whole.subarray(split)],
      });
    }
    return cases;
  }

  it("ends the previous line on a lone CR instead of gluing the next line", () => {
    const whole = bytes("data: x\rdata: y\n\n");

    expect(dataOf([whole])).toEqual(["x\ny"]);
    expect(dataOf([bytes("data: x\r"), bytes("data: y\n\n")])).toEqual(["x\ny"]);
    for (const { name, chunks } of everyChunking(whole)) {
      expect(dataOf(chunks), name).toEqual(["x\ny"]);
    }
  });

  it("treats a CRLF pair split across chunks as one terminator", () => {
    const whole = bytes("data: x\r\ndata: y\n\n");

    expect(dataOf([whole])).toEqual(["x\ny"]);
    expect(dataOf([bytes("data: x\r"), bytes("\ndata: y\n\n")])).toEqual(["x\ny"]);
    for (const { name, chunks } of everyChunking(whole)) {
      expect(dataOf(chunks), name).toEqual(["x\ny"]);
    }
  });

  it("keeps waiting when an empty chunk follows a trailing CR", () => {
    const parser = new SseFrameParser();

    expect(parser.push(bytes("data: x\r"))).toEqual([]);
    expect(parser.push(new Uint8Array(0))).toEqual([]);
    expect(parser.push(bytes("data: y\n\n")).map((frame) => frame.data)).toEqual([
      "x\ny",
    ]);
    expect(parser.finish()).toEqual([]);
  });

  it("handles a CR that is followed by another CR (blank line)", () => {
    const whole = bytes("data: x\r\r\n\n");

    expect(dataOf([whole])).toEqual(["x"]);
    expect(dataOf([bytes("data: x\r"), bytes("\r\n\n")])).toEqual(["x"]);
    expect(dataOf([bytes("data: x\r\r"), bytes("\n\n")])).toEqual(["x"]);
    expect(dataOf([bytes("data: x\r"), bytes("\r"), bytes("\n\n")])).toEqual(["x"]);
    for (const { name, chunks } of everyChunking(whole)) {
      expect(dataOf(chunks), name).toEqual(["x"]);
    }
  });

  it("treats a CR at EOF as an ordinary line terminator", () => {
    // Complete frame: the terminating blank line itself is closed by the CR.
    const complete = bytes("data: x\r\n\r");
    expect(dataOf([complete])).toEqual(["x"]);
    for (const { name, chunks } of everyChunking(complete)) {
      expect(dataOf(chunks), name).toEqual(["x"]);
    }

    // Incomplete frame: a CR alone never terminates a frame.
    expect(verdictOf([bytes("data: x\r")])).toBe("provider_protocol_error");
    expect(verdictOf([bytes("data: x\r"), bytes("")])).toBe(
      "provider_protocol_error",
    );
  });

  it("handles mixed LF, CRLF and lone CR line endings", () => {
    const whole = bytes("data: a\ndata: b\r\ndata: c\rdata: d\n\n");

    expect(dataOf([whole])).toEqual(["a\nb\nc\nd"]);
    for (const { name, chunks } of everyChunking(whole)) {
      expect(dataOf(chunks), name).toEqual(["a\nb\nc\nd"]);
    }
  });

  it("gives the same verdict at the frame limit whatever the chunking", () => {
    const whole = bytes("data: x\n\n"); // exactly 9 bytes

    for (const { name, chunks } of everyChunking(whole)) {
      expect(verdictOf(chunks, 9), `limit 9 / ${name}`).toBeNull();
      expect(verdictOf(chunks, 8), `limit 8 / ${name}`).toBe(
        "provider_protocol_error",
      );
    }
  });

  it("keeps multi-line CJK and emoji data intact across every chunking", () => {
    const expected = "\u4f60\u597d\n\ud83d\ude80x";

    // Lone CR between the two data lines.
    const whole = bytes("data: \u4f60\u597d\rdata: \ud83d\ude80x\n\n");
    expect(dataOf([whole])).toEqual([expected]);
    expect(dataOf([bytes("data: \u4f60\u597d\r"), bytes("data: \ud83d\ude80x\n\n")])).toEqual(
      [expected],
    );
    for (const { name, chunks } of everyChunking(whole)) {
      expect(dataOf(chunks), name).toEqual([expected]);
    }

    // Same data with a CRLF pair split right between the CR and the LF.
    const crlf = bytes("data: \u4f60\u597d\r\ndata: \ud83d\ude80x\n\n");
    expect(dataOf([crlf])).toEqual([expected]);
    expect(
      dataOf([bytes("data: \u4f60\u597d\r"), bytes("\ndata: \ud83d\ude80x\n\n")]),
      "split between CR and LF",
    ).toEqual([expected]);
  });

  it("produces identical frames for every two-way and byte-wise chunking", () => {
    const whole = bytes("data: one\rdata: two\r\ndata: three\n\ndata: four\n\n");
    const expected = ["one\ntwo\nthree", "four"];

    expect(dataOf([whole])).toEqual(expected);
    for (const { name, chunks } of everyChunking(whole)) {
      expect(dataOf(chunks), name).toEqual(expected);
    }
  });
});

describe("task 3 sse — provider adapter wiring", () => {
  it("is exported for the provider decoders to share", async () => {
    const sse = await import("../packages/model-gateway/src/adapters/sse.js");
    expect(typeof sse.SseFrameParser).toBe("function");
    expect(typeof sse.parseSseStream).toBe("function");
    expect(typeof sse.SseFrameParser.prototype.push).toBe("function");
    expect(typeof sse.SseFrameParser.prototype.finish).toBe("function");
  });
});
