import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  createLocalAgentHost,
  LocalAgentHostError,
  NotReadyLocalAgentRunner,
  isLocalAgentRunner,
} from "../apps/local-agent-host/src/index.js";
import {
  createStartedTestHost,
  randomTestPort,
  RUNNER_NOT_READY_MESSAGE,
  SERVER_RUNNER_ERROR_MESSAGE,
  validTurnRequest,
} from "./helpers/local-agent-host-fixtures.js";
import { LocalAgentApiClient } from "../packages/local-agent-client/src/index.js";

function hostErrorOf(promise: Promise<unknown>): Promise<LocalAgentHostError> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error as LocalAgentHostError,
  );
}

describe("Task 20: host option validation", () => {
  test("host defaults to the loopback address 127.0.0.1", async () => {
    const { host, dispose } = await createStartedTestHost();
    try {
      expect(host.address()?.startsWith("http://127.0.0.1")).toBe(true);
    } finally {
      await dispose();
    }
  });

  test("localhost is an accepted loopback host", () => {
    const host = createLocalAgentHost({ host: "localhost", port: randomTestPort() });
    expect(host.state()).toBe("created");
  });

  test("0.0.0.0 is rejected as non-loopback", () => {
    const error = hostErrorOf(
      Promise.resolve().then(() => createLocalAgentHost({ host: "0.0.0.0" as never, port: randomTestPort() })),
    );
    return expect(error).resolves.toMatchObject({ code: "host_not_loopback" });
  });

  test("private and IPv6 addresses are rejected as non-loopback", () => {
    for (const bad of ["192.168.1.10", "10.0.0.5", "172.16.0.9", "::1", "[::1]"]) {
      expect(() => createLocalAgentHost({ host: bad as never, port: randomTestPort() })).toThrow(
        LocalAgentHostError,
      );
    }
  });

  test("remote hostnames and URLs are rejected", () => {
    for (const bad of ["example.com", "https://example.com"]) {
      expect(() => createLocalAgentHost({ host: bad as never, port: randomTestPort() })).toThrow(
        LocalAgentHostError,
      );
    }
  });

  test("port must be an integer between 1 and 65535", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65536, "8080"]) {
      expect(() => createLocalAgentHost({ port: bad as never })).toThrow(LocalAgentHostError);
    }
  });

  test("error messages are fixed and never echo host or port values", async () => {
    const error = await hostErrorOf(
      Promise.resolve().then(() => createLocalAgentHost({ host: "10.9.8.7" as never, port: 12345 })),
    );
    expect(error.message).not.toContain("10.9.8.7");
    expect(error.message).not.toContain("12345");
    expect(error.message).toBe("Local agent host must listen on loopback only.");
  });

  test("isLocalAgentRunner accepts object literals, null-prototype objects and class instances", () => {
    expect(isLocalAgentRunner({ run: () => undefined })).toBe(true);
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.run = () => undefined;
    expect(isLocalAgentRunner(nullProto)).toBe(true);
    class Runner {
      run() {
        return undefined;
      }
    }
    expect(isLocalAgentRunner(new Runner())).toBe(true);
  });

  test("isLocalAgentRunner rejects null, arrays, primitives and non-function run", () => {
    for (const bad of [null, undefined, [], "runner", 42, {}, { run: "nope" }]) {
      expect(isLocalAgentRunner(bad)).toBe(false);
    }
  });

  test("a runner missing run() is rejected at construction", () => {
    expect(() => createLocalAgentHost({ port: randomTestPort(), runner: {} as never })).toThrow(
      LocalAgentHostError,
    );
  });
});

describe("Task 20: default not-ready runner", () => {
  test("the default runner is exposed and throws the fixed not-ready error", async () => {
    const runner = new NotReadyLocalAgentRunner();
    await expect(runner.run({} as never)).rejects.toMatchObject({
      message: RUNNER_NOT_READY_MESSAGE,
    });
  });

  test("a turn against the default runner produces only the fixed runner_error event", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const session = await client.createSession();
      const events = [];
      for await (const event of client.runTurn(session.id, validTurnRequest() as never)) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      const failure = events.find((event) => event.type === "error");
      expect(failure?.type).toBe("error");
      if (failure?.type === "error") {
        expect(failure.code).toBe("runner_error");
        expect(failure.message).toBe(SERVER_RUNNER_ERROR_MESSAGE);
      }
      for (const forbidden of ["text_delta", "tool_call", "usage", "completed"]) {
        expect(events.some((event) => event.type === forbidden)).toBe(false);
      }
    } finally {
      await dispose();
    }
  });

  test("the not-ready runner error never leaks internal details into the event", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const client = new LocalAgentApiClient(`http://127.0.0.1:${String(port)}`);
      const session = await client.createSession();
      const events = [];
      for await (const event of client.runTurn(session.id, validTurnRequest() as never)) {
        events.push(event);
      }
      const raw = JSON.stringify(events);
      expect(raw).not.toContain(RUNNER_NOT_READY_MESSAGE);
      expect(raw).not.toContain("stack");
      expect(raw).not.toContain("Error:");
    } finally {
      await dispose();
    }
  });
});

describe("Task 20: current-state documentation", () => {
  test("does not claim that the completed host task has not started", () => {
    const tauriDocumentation = readFileSync(new URL("../docs/tauri.md", import.meta.url), "utf8");
    const deterministicEvaluation = readFileSync(
      new URL("../scripts/evals-deterministic.mjs", import.meta.url),
      "utf8",
    );
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(tauriDocumentation).not.toContain("Task 20 and Task 21 have not been started.");
    expect(tauriDocumentation).toContain("Task 20 is now complete");
    expect(tauriDocumentation).toContain("Task 21 has not been started");
    expect(deterministicEvaluation).not.toContain("Task 20 and Task 21 have not been started.");
    expect(deterministicEvaluation).toContain("Task 20 is complete");
    expect(deterministicEvaluation).toContain("Task 21 has not been started");
    expect(readme).toContain("在 Task 19 检查点 Task 20/21 尚未开始");
    expect(readme).toContain("当前 Task 20 已完成，Task 21 待开始");
  });
});
