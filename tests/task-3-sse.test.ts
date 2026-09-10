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

describe("task 3 sse — provider adapter wiring", () => {
  it("is exported for the provider decoders to share", async () => {
    const sse = await import("../packages/model-gateway/src/adapters/sse.js");
    expect(typeof sse.SseFrameParser).toBe("function");
    expect(typeof sse.parseSseStream).toBe("function");
    expect(typeof sse.SseFrameParser.prototype.push).toBe("function");
    expect(typeof sse.SseFrameParser.prototype.finish).toBe("function");
  });
});
