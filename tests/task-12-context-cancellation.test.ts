import { describe, expect, it } from "vitest";
import { buildContext } from "../packages/agent-memory/src/index.js";
import { userText } from "./helpers/memory-fixtures.js";

function longMessages(): ReturnType<typeof userText>[] {
  return Array.from({ length: 14 }, (_, i) =>
    userText(`q${String(i)} ${"z".repeat(60)}`),
  ).concat(userText("end"));
}

describe("task 12 context cancellation", () => {
  it("aborts before calling the summarizer", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      buildContext({
        messages: longMessages(),
        maxContextBytes: 400,
        signal: controller.signal,
        summarizer: {
          async summarize() {
            calls += 1;
            return "s";
          },
        },
      }),
    ).rejects.toMatchObject({ code: "context_aborted" });
    expect(calls).toBe(0);
  });

  it("passes the signal to the summarizer", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const messages = longMessages();
    await buildContext({
      messages,
      maxContextBytes: 400,
      signal: controller.signal,
      summarizer: {
        async summarize(_req, signal) {
          seen = signal;
          return "ok";
        },
      },
    });
    expect(seen).toBe(controller.signal);
  });

  it("aborts while the summarizer is pending", async () => {
    const controller = new AbortController();
    const pending = buildContext({
      messages: longMessages(),
      maxContextBytes: 400,
      signal: controller.signal,
      summarizer: {
        async summarize(_req, signal) {
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted-by-signal")),
              { once: true },
            );
          });
        },
      },
    });
    setTimeout(() => controller.abort(), 10);
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1500),
        ),
      ]),
    ).rejects.toMatchObject({ code: "context_aborted" });
  });

  it("does not produce unhandled rejections on late summarizer resolve", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const controller = new AbortController();
      let resolveLate!: (v: string) => void;
      const pending = buildContext({
        messages: longMessages(),
        maxContextBytes: 400,
        signal: controller.signal,
        summarizer: {
          async summarize() {
            return new Promise<string>((resolve) => {
              resolveLate = resolve;
            });
          },
        },
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "context_aborted" });
      resolveLate("late-ok");
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("does not produce unhandled rejections on late summarizer reject", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const controller = new AbortController();
      let rejectLate!: (e: unknown) => void;
      const pending = buildContext({
        messages: longMessages(),
        maxContextBytes: 400,
        signal: controller.signal,
        summarizer: {
          async summarize() {
            return new Promise<string>((_resolve, reject) => {
              rejectLate = reject;
            });
          },
        },
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "context_aborted" });
      rejectLate(new Error("late-fail"));
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("maps summarizer throw to context_compression_failed", async () => {
    await expect(
      buildContext({
        messages: longMessages(),
        maxContextBytes: 400,
        summarizer: {
          async summarize() {
            throw new Error("boom");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "context_compression_failed" });
  });

  it("keeps concurrent builds isolated when one is cancelled", async () => {
    const controllerA = new AbortController();
    let resolveA!: (v: string) => void;
    const buildA = buildContext({
      messages: longMessages(),
      maxContextBytes: 400,
      signal: controllerA.signal,
      summarizer: {
        async summarize() {
          return new Promise<string>((resolve) => {
            resolveA = resolve;
          });
        },
      },
    });
    const buildB = buildContext({
      messages: longMessages(),
      maxContextBytes: 400,
      summarizer: {
        async summarize() {
          return "b-summary";
        },
      },
    });
    controllerA.abort();
    const [a, b] = await Promise.allSettled([buildA, buildB]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    if (b.status === "fulfilled") {
      expect(b.value.summaryIncluded).toBe(true);
    }
    resolveA("late");
    await new Promise((r) => setTimeout(r, 10));
  });

  it("does not return a partial result when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildContext({
        messages: longMessages(),
        maxContextBytes: 400,
        signal: controller.signal,
        summarizer: {
          async summarize() {
            return "s";
          },
        },
      }),
    ).rejects.toMatchObject({ code: "context_aborted" });
  });

  it("rejects a non-object options argument", async () => {
    await expect(buildContext(null as never)).rejects.toMatchObject({
      code: "invalid_context_options",
    });
  });

  it("rejects array options", async () => {
    await expect(buildContext([] as never)).rejects.toMatchObject({
      code: "invalid_context_options",
    });
  });
});
