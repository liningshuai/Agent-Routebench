import { describe, expect, it } from "vitest";
import {
  ContextError,
  buildContext,
  estimateContextBytes,
} from "../packages/agent-memory/src/index.js";
import {
  assistantText,
  assistantToolCall,
  scriptedSummarizer,
  systemText,
  toolResult,
  userText,
} from "./helpers/memory-fixtures.js";

describe("task 12 context compaction", () => {
  it("returns messages unchanged when under budget", async () => {
    const messages = [userText("hello"), assistantText("hi")];
    const summarizer = scriptedSummarizer("should-not-run");
    const result = await buildContext({
      messages,
      maxContextBytes: 10_000,
      summarizer,
    });
    expect(result.compressed).toBe(false);
    expect(result.summaryIncluded).toBe(false);
    expect(result.omittedMessageCount).toBe(0);
    expect(result.messages).toHaveLength(2);
    expect(summarizer.calls).toBe(0);
  });

  it("estimates UTF-8 bytes, not character counts", () => {
    const ascii = [userText("aaaa")];
    const chinese = [userText("中文测试")];
    expect(estimateContextBytes(ascii)).toBeGreaterThan(4);
    expect(estimateContextBytes(chinese)).toBeGreaterThan(estimateContextBytes(ascii));
  });

  it("keeps all system messages when compressing", async () => {
    const messages = [
      systemText("you are offline and must not call the network"),
      userText(`q1 ${"a".repeat(80)}`),
      assistantText(`a1 ${"b".repeat(80)}`),
      userText(`q2 ${"c".repeat(80)}`),
      assistantText(`a2 ${"d".repeat(80)}`),
      userText(`q3 ${"e".repeat(80)}`),
      assistantText(`a3 ${"f".repeat(80)}`),
      userText("final question"),
    ];
    const summarizer = scriptedSummarizer("summary of older turns");
    const result = await buildContext({
      messages,
      maxContextBytes: 600,
      summarizer,
    });
    expect(result.compressed).toBe(true);
    expect(result.summaryIncluded).toBe(true);
    const systems = result.messages.filter((m) => m.role === "system");
    expect(systems.length).toBeGreaterThanOrEqual(2);
    const texts = systems.map((m) =>
      m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    );
    expect(texts.some((t) => t.includes("you are offline"))).toBe(true);
    expect(texts.some((t) => t.includes("[Context summary]"))).toBe(true);
  });

  it("keeps the last user message and messages after it", async () => {
    const messages = [
      userText("old-1"),
      assistantText("old-2"),
      userText("old-3"),
      assistantText("old-4"),
      userText("LAST"),
    ];
    const summarizer = scriptedSummarizer("compact");
    const result = await buildContext({
      messages,
      maxContextBytes: 280,
      summarizer,
    });
    expect(result.compressed).toBe(true);
    const texts = result.messages.flatMap((m) =>
      m.content.map((c) => (c.type === "text" ? c.text : "")),
    );
    expect(texts.some((t) => t === "LAST")).toBe(true);
    expect(texts.some((t) => t.includes("[Context summary]"))).toBe(true);
  });

  it("keeps tool_call and tool_result as an atomic group", async () => {
    const messages = [
      systemText("sys"),
      userText("old"),
      assistantToolCall("call-1"),
      toolResult("call-1", "data"),
      assistantText("answer"),
      userText("follow-up"),
    ];
    const summarizer = scriptedSummarizer("s");
    const result = await buildContext({
      messages,
      maxContextBytes: 500,
      summarizer,
    });
    // If compressed, either both call and result are present or neither.
    const hasCall = result.messages.some((m) =>
      m.content.some((c) => c.type === "tool_call"),
    );
    const hasResult = result.messages.some((m) =>
      m.content.some((c) => c.type === "tool_result"),
    );
    expect(hasCall).toBe(hasResult);
  });

  it("never leaves an orphan tool_result", async () => {
    const messages = [
      systemText("s"),
      assistantToolCall("c1"),
      toolResult("c1"),
      assistantToolCall("c2"),
      toolResult("c2"),
      assistantToolCall("c3"),
      toolResult("c3"),
      userText("end"),
    ];
    const summarizer = scriptedSummarizer("s");
    const result = await buildContext({
      messages,
      maxContextBytes: 420,
      summarizer,
    });
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of result.messages) {
      for (const c of m.content) {
        if (c.type === "tool_call") callIds.add(c.id);
        if (c.type === "tool_result") resultIds.add(c.toolCallId);
      }
    }
    for (const id of resultIds) {
      expect(callIds.has(id)).toBe(true);
    }
  });

  it("injects memory entries as a deterministic system message", async () => {
    const messages = [userText("hi")];
    const memoryEntries = [
      {
        id: "m1",
        scopeId: "s",
        kind: "fact" as const,
        content: "likes TypeScript",
        tags: ["ts"],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "m2",
        scopeId: "s",
        kind: "decision" as const,
        content: "offline tests",
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = await buildContext({
      messages,
      memoryEntries,
      maxContextBytes: 10_000,
    });
    expect(result.compressed).toBe(false);
    expect(result.includedMemoryIds).toEqual(["m1", "m2"]);
    const mem = result.messages.find((m) => m.role === "system");
    const text = mem?.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(text).toContain("[Retrieved memory]");
    expect(text).toContain("[fact] likes TypeScript");
    expect(text).toContain("[decision] offline tests");
  });

  it("does not inject a memory message when there are no entries", async () => {
    const result = await buildContext({
      messages: [userText("hi")],
      maxContextBytes: 10_000,
    });
    expect(result.includedMemoryIds).toEqual([]);
    expect(result.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("counts memory bytes against the budget", async () => {
    const messages = [userText("hi")];
    const memoryEntries = [
      {
        id: "m1",
        scopeId: "s",
        kind: "fact" as const,
        content: "x".repeat(200),
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const summarizer = scriptedSummarizer("s");
    await expect(
      buildContext({
        messages,
        memoryEntries,
        maxContextBytes: 150,
        summarizer,
      }),
    ).rejects.toMatchObject({ code: "context_budget_exceeded" });
  });

  it("throws when compression is required but no summarizer is provided", async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? userText(`question ${String(i)} ${"x".repeat(40)}`)
        : assistantText(`answer ${String(i)} ${"y".repeat(40)}`),
    );
    messages.push(userText("final"));
    await expect(
      buildContext({ messages, maxContextBytes: 400 }),
    ).rejects.toMatchObject({ code: "context_compression_required" });
  });

  it("throws when the protected region alone exceeds the budget", async () => {
    const messages = [
      systemText("s".repeat(200)),
      userText("u".repeat(200)),
    ];
    const summarizer = scriptedSummarizer("s");
    await expect(
      buildContext({ messages, maxContextBytes: 100, summarizer }),
    ).rejects.toMatchObject({ code: "context_budget_exceeded" });
  });

  it("rejects a non-function summarizer", async () => {
    await expect(
      buildContext({
        messages: [userText("hi")],
        maxContextBytes: 1000,
        summarizer: { summarize: "nope" },
      } as never),
    ).rejects.toMatchObject({ code: "invalid_context_options" });
  });

  it("accepts a class-instance summarizer", async () => {
    class Summarizer {
      async summarize(): Promise<string> {
        return "class summary";
      }
    }
    const messages = Array.from({ length: 12 }, (_, i) =>
      userText(`q${String(i)} ${"z".repeat(50)}`),
    );
    messages.push(userText("end"));
    const result = await buildContext({
      messages,
      maxContextBytes: 500,
      summarizer: new Summarizer(),
    });
    expect(result.summaryIncluded).toBe(true);
    expect(result.messages.some((m) => m.role === "system")).toBe(true);
  });

  it("rejects unknown top-level fields", async () => {
    await expect(
      buildContext({
        messages: [userText("hi")],
        maxContextBytes: 1000,
        apiKey: "nope",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_context_options" });
  });

  it("rejects invalid messages via shared validation", async () => {
    await expect(
      buildContext({
        messages: [],
        maxContextBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: "invalid_context_messages" });
  });

  it("does not mutate the input messages array", async () => {
    const messages = [userText("keep"), assistantText("keep2")];
    const snapshot = JSON.stringify(messages);
    await buildContext({ messages, maxContextBytes: 10_000 });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("returns defensive copies", async () => {
    const messages = [userText("copy-me")];
    const result = await buildContext({ messages, maxContextBytes: 10_000 });
    (result.messages[0] as unknown as { content: unknown[] }).content.push("injected");
    expect(messages[0]?.content).toHaveLength(1);
  });

  it("rejects an empty summarizer return", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      userText(`q${String(i)} ${"z".repeat(50)}`),
    );
    messages.push(userText("end"));
    await expect(
      buildContext({
        messages,
        maxContextBytes: 500,
        summarizer: scriptedSummarizer(""),
      }),
    ).rejects.toMatchObject({ code: "context_summary_invalid" });
  });

  it("rejects a summary exceeding maxSummaryBytes", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      userText(`q${String(i)} ${"z".repeat(50)}`),
    );
    messages.push(userText("end"));
    await expect(
      buildContext({
        messages,
        maxContextBytes: 500,
        maxSummaryBytes: 10,
        summarizer: scriptedSummarizer("x".repeat(100)),
      }),
    ).rejects.toMatchObject({ code: "context_summary_too_large" });
  });

  it("maps summarizer exceptions to a safe error", async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      userText(`q${String(i)} ${"z".repeat(50)}`),
    );
    messages.push(userText("end"));
    let message = "";
    try {
      await buildContext({
        messages,
        maxContextBytes: 500,
        summarizer: {
          async summarize() {
            throw new Error("raw stack https://evil.example.com");
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Context compression failed.");
    expect(message).not.toContain("evil.example.com");
  });

  it("includes UTF-8 multibyte content in the byte budget", async () => {
    const messages = [userText("你好，世界 🚀"), assistantText("中文回答")];
    const result = await buildContext({
      messages,
      maxContextBytes: 10_000,
    });
    expect(result.contextBytes).toBe(estimateContextBytes(result.messages));
  });

  it("produces a unique deterministic memory format", async () => {
    const memoryEntries = [
      {
        id: "m1",
        scopeId: "s",
        kind: "preference" as const,
        content: "uses pnpm",
        tags: ["pkg"],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = await buildContext({
      messages: [userText("hi")],
      memoryEntries,
      maxContextBytes: 10_000,
    });
    const text = result.messages[0]?.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    expect(text).toContain("- [preference] uses pnpm");
  });
});

describe("task 12 final fix: synchronous summarizer exceptions", () => {
  function overflowingMessages(): ReturnType<typeof userText>[] {
    const messages = Array.from({ length: 12 }, (_, i) =>
      userText(`q${String(i)} ${"z".repeat(50)}`),
    );
    messages.push(userText("end"));
    return messages;
  }

  it("maps a synchronous summarizer throw to the fixed safe error", async () => {
    const raw = new Error(
      "RAW_SECRET sk-live-abcdef https://evil.invalid/steal?token=1 C:\\Users\\leak\\secret.txt",
    );
    raw.stack =
      "Error: RAW_SECRET https://evil.invalid/steal\n    at leaky (/leaky/secret-path.ts:1:1)";
    let caught: unknown;
    let resolved: unknown;
    try {
      resolved = await buildContext({
        messages: overflowingMessages(),
        maxContextBytes: 500,
        summarizer: {
          summarize() {
            throw raw;
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(ContextError);
    expect((caught as ContextError).code).toBe("context_compression_failed");
    expect((caught as ContextError).message).toBe("Context compression failed.");
    expect((caught as ContextError).message).not.toContain("RAW_SECRET");
    expect((caught as ContextError).message).not.toContain("evil.invalid");
    expect((caught as ContextError).stack ?? "").not.toContain("RAW_SECRET");
    expect((caught as ContextError).stack ?? "").not.toContain("evil.invalid");
    expect((caught as ContextError).stack ?? "").not.toContain("secret-path");
  });

  it("sanitizes synchronous throws from class summarizers", async () => {
    class ThrowingSummarizer {
      summarize(): string {
        throw new Error(
          "RAW_SECRET class leak https://evil.invalid/class C:/leaky/path.txt",
        );
      }
    }
    let caught: unknown;
    let resolved: unknown;
    try {
      resolved = await buildContext({
        messages: overflowingMessages(),
        maxContextBytes: 500,
        summarizer: new ThrowingSummarizer(),
      });
    } catch (error) {
      caught = error;
    }
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(ContextError);
    expect((caught as ContextError).code).toBe("context_compression_failed");
    expect((caught as ContextError).message).toBe("Context compression failed.");
    expect((caught as ContextError).message).not.toContain("RAW_SECRET");
    expect((caught as ContextError).message).not.toContain("evil.invalid");
  });

  it("maps a synchronous summarizer throw to the fixed safe error when a signal is present", async () => {
    const controller = new AbortController();
    let caught: unknown;
    let resolved: unknown;
    try {
      resolved = await buildContext({
        messages: overflowingMessages(),
        maxContextBytes: 500,
        signal: controller.signal,
        summarizer: {
          summarize() {
            throw new Error("RAW_SECRET with-signal https://evil.invalid/sig");
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(ContextError);
    expect((caught as ContextError).code).toBe("context_compression_failed");
    expect((caught as ContextError).message).toBe("Context compression failed.");
    expect((caught as ContextError).message).not.toContain("RAW_SECRET");
  });
});
