import { describe, test, expect } from "vitest";
import { parseNDJSONStream } from "../apps/cli/src/ndjson.js";
import { CLI_ERROR_CODES } from "../apps/cli/src/errors.js";
import type { AgentEvent } from "@agent-workbench/agent-core";
import {
  makeTextDeltaEvent,
  makeCompletedEvent,
  makeErrorEvent,
  makeRouteSelectedEvent,
  makeUsageEvent,
  makeToolCallEvent,
} from "./helpers/cli-fixtures.js";

describe("task 13 CLI NDJSON streaming", () => {
  function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;

    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
        } else {
          controller.close();
        }
      },
    });
  }

  describe("incremental parsing", () => {
    test("yields events immediately as they arrive", async () => {
      const event1 = makeTextDeltaEvent("req-1", "Hello");
      const event2 = makeCompletedEvent("req-1");

      const stream = makeStream([
        JSON.stringify(event1) + "\n",
        JSON.stringify(event2) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("text_delta");
      expect(events[1].type).toBe("completed");
    });

    test("handles multiple events in one chunk", async () => {
      const event1 = makeTextDeltaEvent("req-2", "A");
      const event2 = makeTextDeltaEvent("req-2", "B");
      const event3 = makeCompletedEvent("req-2");

      const combined =
        JSON.stringify(event1) + "\n" +
        JSON.stringify(event2) + "\n" +
        JSON.stringify(event3) + "\n";

      const stream = makeStream([combined]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
    });

    test("handles single event split across chunks", async () => {
      const event = makeTextDeltaEvent("req-3", "Split");
      const terminator = makeCompletedEvent("req-3");
      const line = JSON.stringify(event) + "\n";
      const terminatorLine = JSON.stringify(terminator) + "\n";
      const mid = Math.floor(line.length / 2);

      const stream = makeStream([line.slice(0, mid), line.slice(mid) + terminatorLine]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("text_delta");
      expect(events[1].type).toBe("completed");
    });

    test("handles UTF-8 multi-byte characters split across chunks", async () => {
      const event = makeTextDeltaEvent("req-4", "你好世界");
      const terminator = makeCompletedEvent("req-4");
      const line = JSON.stringify(event) + "\n";
      const terminatorLine = JSON.stringify(terminator) + "\n";
      const bytes = new TextEncoder().encode(line);

      const mid = Math.floor(bytes.length / 2);
      const chunk1 = new TextDecoder().decode(bytes.slice(0, mid), { stream: true });
      const chunk2 = new TextDecoder().decode(bytes.slice(mid)) + terminatorLine;

      const stream = makeStream([chunk1, chunk2]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect((events[0] as any).text).toBe("你好世界");
      expect(events[1].type).toBe("completed");
    });

    test("handles emoji split across chunks", async () => {
      const event = makeTextDeltaEvent("req-5", "🎉🚀");
      const terminator = makeCompletedEvent("req-5");
      const line = JSON.stringify(event) + "\n";
      const terminatorLine = JSON.stringify(terminator) + "\n";
      const bytes = new TextEncoder().encode(line);

      const mid = 20;
      const chunk1 = new TextDecoder().decode(bytes.slice(0, mid), { stream: true });
      const chunk2 = new TextDecoder().decode(bytes.slice(mid)) + terminatorLine;

      const stream = makeStream([chunk1, chunk2]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect((events[0] as any).text).toBe("🎉🚀");
      expect(events[1].type).toBe("completed");
    });
  });

  describe("termination events", () => {
    test("completed is valid terminator", async () => {
      const stream = makeStream([
        JSON.stringify(makeTextDeltaEvent("r1", "Hi")) + "\n",
        JSON.stringify(makeCompletedEvent("r1")) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events[events.length - 1].type).toBe("completed");
    });

    test("error is valid terminator", async () => {
      const stream = makeStream([
        JSON.stringify(makeTextDeltaEvent("r2", "Start")) + "\n",
        JSON.stringify(makeErrorEvent("r2", "aborted", "Cancelled", false)) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events[events.length - 1].type).toBe("error");
    });

    test("rejects stream without termination event", async () => {
      const stream = makeStream([
        JSON.stringify(makeTextDeltaEvent("r3", "No end")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("rejects events after completed", async () => {
      const stream = makeStream([
        JSON.stringify(makeCompletedEvent("r4")) + "\n",
        JSON.stringify(makeTextDeltaEvent("r4", "Late")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("rejects events after error", async () => {
      const stream = makeStream([
        JSON.stringify(makeErrorEvent("r5", "fail", "Failed", false)) + "\n",
        JSON.stringify(makeTextDeltaEvent("r5", "Extra")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });
  });

  describe("event validation", () => {
    test("validates text_delta fields", async () => {
      const valid = makeTextDeltaEvent("req", "text");
      const stream = makeStream([
        JSON.stringify(valid) + "\n",
        JSON.stringify(makeCompletedEvent("req")) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events[0]).toMatchObject({
        type: "text_delta",
        requestId: "req",
        text: "text",
      });
    });

    test("validates route_selected fields", async () => {
      const event = makeRouteSelectedEvent("req", "route-1", "gpt-4");
      const stream = makeStream([
        JSON.stringify(event) + "\n",
        JSON.stringify(makeCompletedEvent("req")) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events[0]).toMatchObject({
        type: "route_selected",
        requestId: "req",
        routeId: "route-1",
        model: "gpt-4",
      });
    });

    test("validates usage fields", async () => {
      const event = makeUsageEvent("req", 100, 50);
      const stream = makeStream([
        JSON.stringify(event) + "\n",
        JSON.stringify(makeCompletedEvent("req")) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events[0]).toMatchObject({
        type: "usage",
        requestId: "req",
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    test("validates tool_call fields", async () => {
      const event = makeToolCallEvent("req", "call-1", "get_weather", { city: "SF" });
      const stream = makeStream([
        JSON.stringify(event) + "\n",
        JSON.stringify(makeCompletedEvent("req")) + "\n",
      ]);

      const events: AgentEvent[] = [];
      for await (const event of parseNDJSONStream(stream)) {
        events.push(event);
      }

      expect(events[0]).toMatchObject({
        type: "tool_call",
        requestId: "req",
        id: "call-1",
        name: "get_weather",
        input: { city: "SF" },
      });
    });

    test("rejects event with unknown fields", async () => {
      const invalid = { ...makeTextDeltaEvent("r", "t"), extraField: "bad" };
      const stream = makeStream([
        JSON.stringify(invalid) + "\n",
        JSON.stringify(makeCompletedEvent("r")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("rejects event with missing required field", async () => {
      const invalid = { type: "text_delta", requestId: "r" };
      const stream = makeStream([
        JSON.stringify(invalid) + "\n",
        JSON.stringify(makeCompletedEvent("r")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("rejects event with wrong field type", async () => {
      const invalid = { type: "text_delta", requestId: "r", text: 123 };
      const stream = makeStream([
        JSON.stringify(invalid) + "\n",
        JSON.stringify(makeCompletedEvent("r")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });
  });

  describe("size limits", () => {
    test("single line exceeding 256 KiB is rejected", async () => {
      const huge = "x".repeat(257 * 1024);
      const event = makeTextDeltaEvent("r", huge);
      const stream = makeStream([JSON.stringify(event) + "\n"]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.streamTooLarge,
        message: "Local Agent API response is too large.",
      });
    });

    test("total response exceeding 16 MiB is rejected", async () => {
      const chunks: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const big = "y".repeat(20 * 1024);
        chunks.push(JSON.stringify(makeTextDeltaEvent("r", big)) + "\n");
      }

      const stream = makeStream(chunks);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.streamTooLarge,
      });
    });
  });

  describe("malformed data", () => {
    test("half line at EOF is rejected", async () => {
      const stream = makeStream([
        JSON.stringify(makeTextDeltaEvent("r", "ok")) + "\n",
        JSON.stringify(makeCompletedEvent("r")),
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("invalid JSON line is rejected", async () => {
      const stream = makeStream([
        "not json\n",
        JSON.stringify(makeCompletedEvent("r")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("invalid UTF-8 is rejected", async () => {
      const encoder = new TextEncoder();
      const invalid = new Uint8Array([0xff, 0xfe, 0x0a]);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(invalid);
          controller.close();
        },
      });

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("empty stream is rejected", async () => {
      const stream = makeStream([]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });
  });

  describe("cancellation", () => {
    test("AbortSignal stops iteration early", async () => {
      const controller = new AbortController();
      const chunks: string[] = [];
      for (let i = 0; i < 100; i++) {
        chunks.push(JSON.stringify(makeTextDeltaEvent("r", `chunk ${i}`)) + "\n");
      }
      chunks.push(JSON.stringify(makeCompletedEvent("r")) + "\n");

      const stream = makeStream(chunks);
      const events: AgentEvent[] = [];

      try {
        for await (const event of parseNDJSONStream(stream, controller.signal)) {
          events.push(event);
          if (events.length === 5) {
            controller.abort();
          }
        }
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe(CLI_ERROR_CODES.aborted);
      }

      expect(events.length).toBeLessThan(100);
    });

    test("pre-aborted signal rejects immediately", async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = makeStream([
        JSON.stringify(makeTextDeltaEvent("r", "never")) + "\n",
        JSON.stringify(makeCompletedEvent("r")) + "\n",
      ]);

      await expect(async () => {
        for await (const _ of parseNDJSONStream(stream, controller.signal)) {
        }
      }).rejects.toMatchObject({
        code: CLI_ERROR_CODES.aborted,
      });
    });

    test("releases reader on cancellation", async () => {
      const controller = new AbortController();
      const stream = makeStream([
        JSON.stringify(makeTextDeltaEvent("r", "1")) + "\n",
        JSON.stringify(makeTextDeltaEvent("r", "2")) + "\n",
        JSON.stringify(makeCompletedEvent("r")) + "\n",
      ]);

      try {
        for await (const event of parseNDJSONStream(stream, controller.signal)) {
          controller.abort();
        }
      } catch {
        // expected
      }

      const reader = stream.getReader();
      expect(reader).toBeDefined();
      reader.releaseLock();
    });

    test("does not produce unhandled rejection on late reader error", async () => {
      let rejectRead: ((err: any) => void) | null = null;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(makeTextDeltaEvent("r", "ok")) + "\n"),
          );
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(makeCompletedEvent("r")) + "\n"),
          );
        },
        pull() {
          return new Promise<void>((_, reject) => {
            rejectRead = reject;
          });
        },
      });

      const controller = new AbortController();
      const parsePromise = (async () => {
        const events: AgentEvent[] = [];
        try {
          for await (const event of parseNDJSONStream(stream, controller.signal)) {
            events.push(event);
            if (events.length === 2) {
              controller.abort();
            }
          }
        } catch {
          // expected abort
        }
      })();

      await parsePromise;

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      rejectRead!(new Error("Late rejection"));

      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });
});

