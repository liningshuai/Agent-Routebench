import { describe, expect, it } from "vitest";
import {
  LocalAgentApiClient,
  LOCAL_AGENT_CLIENT_ERROR_CODES,
  parseNDJSONStream,
} from "../packages/local-agent-client/src/index.js";
import {
  completedEvent,
  ndjson,
  response,
  streamFromChunks,
  streamResponse,
  textEvent,
  userRequest,
} from "./helpers/local-agent-client-fixtures.js";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

describe("Task 16 Local Agent NDJSON streaming", () => {
  it("emits events incrementally from separate chunks", async () => {
    const events = [textEvent("one"), textEvent("two"), completedEvent()];
    const stream = streamFromChunks(events.map((event) => `${JSON.stringify(event)}\n`));

    await expect(collect(parseNDJSONStream(stream))).resolves.toEqual(events);
  });

  it("handles UTF-8 characters split across chunks", async () => {
    const payload = ndjson([textEvent("中文 🎉"), completedEvent()]);
    const bytes = new TextEncoder().encode(payload);
    const midpoint = Math.max(1, bytes.length - 3);

    await expect(
      collect(parseNDJSONStream(streamFromChunks([bytes.slice(0, midpoint), bytes.slice(midpoint)]))),
    ).resolves.toEqual([textEvent("中文 🎉"), completedEvent()]);
  });

  it("accepts an error event as the terminal event", async () => {
    const error = {
      type: "error" as const,
      requestId: "req-1",
      code: "aborted",
      message: "Operation aborted.",
      retryable: false,
    };

    await expect(collect(parseNDJSONStream(streamFromChunks([ndjson([error])])))).resolves.toEqual([
      error,
    ]);
  });

  it("rejects a stream without a terminal event", async () => {
    await expect(
      collect(parseNDJSONStream(streamFromChunks([ndjson([textEvent()])]))),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError });
  });

  it("rejects an event after a terminal event", async () => {
    await expect(
      collect(
        parseNDJSONStream(
          streamFromChunks([ndjson([completedEvent(), textEvent("late")])]),
        ),
      ),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError });
  });

  it("rejects invalid JSON lines", async () => {
    await expect(
      collect(parseNDJSONStream(streamFromChunks(["not json\n"]))),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError });
  });

  it("rejects invalid UTF-8 instead of replacing it", async () => {
    const prefix = new TextEncoder().encode(
      '{"type":"text_delta","requestId":"req-1","text":"',
    );
    const suffix = new TextEncoder().encode(
      '"}\n{"type":"completed","requestId":"req-1"}\n',
    );
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix);
    bytes[prefix.length] = 0xff;
    bytes.set(suffix, prefix.length + 1);
    await expect(
      collect(
        parseNDJSONStream(
          streamFromChunks([bytes]),
        ),
      ),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError });
  });

  it("rejects unknown event fields", async () => {
    const invalid = { ...textEvent(), extra: "nope" };
    await expect(
      collect(parseNDJSONStream(streamFromChunks([`${JSON.stringify(invalid)}\n`]))),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError });
  });

  it("rejects a response line above the configured byte limit", async () => {
    const oversized = `${JSON.stringify(textEvent("x".repeat(100)))}\n`;
    await expect(
      collect(
        parseNDJSONStream(streamFromChunks([oversized]), {
          maxLineBytes: 32,
          maxTotalBytes: 4096,
        }),
      ),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.streamTooLarge });
  });

  it("rejects a response above the configured total byte limit", async () => {
    const payload = ndjson([textEvent("12345"), textEvent("67890"), completedEvent()]);
    await expect(
      collect(
        parseNDJSONStream(streamFromChunks([payload]), {
          maxLineBytes: 4096,
          maxTotalBytes: payload.length - 1,
        }),
      ),
    ).rejects.toMatchObject({ code: LOCAL_AGENT_CLIENT_ERROR_CODES.streamTooLarge });
  });

  it("passes the caller AbortSignal through a streaming turn", async () => {
    let signal: AbortSignal | undefined;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async (_url, init) => {
        signal = init?.signal as AbortSignal | undefined;
        return streamResponse([completedEvent()]);
      },
    );
    const controller = new AbortController();

    await collect(client.runTurn("sess-1", userRequest(), controller.signal));
    expect(signal).toBe(controller.signal);
  });

  it("does not invent a completion event", async () => {
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => response(`${JSON.stringify(textEvent())}\n`),
    );

    await expect(collect(client.runTurn("sess-1", userRequest()))).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError,
    });
  });

  it("cancels the reader when a consumer stops early", async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(textEvent("first"))}\n`));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const iterator = parseNDJSONStream(stream)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: textEvent("first"),
    });
    await iterator.return?.();
    await Promise.resolve();

    expect(cancelCalls).toBe(1);
  });
});
