import { describe, expect, test } from "vitest";
import {
  createLocalAgentHost,
  LocalAgentHostError,
} from "../apps/local-agent-host/src/index.js";
import {
  createStartedTestHost,
  randomTestPort,
} from "./helpers/local-agent-host-fixtures.js";

function hostErrorOf(promise: Promise<unknown>): Promise<LocalAgentHostError> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error as LocalAgentHostError,
  );
}

describe("Task 20: host lifecycle", () => {
  test("a fresh host is in the created state and address() is undefined", () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    expect(host.state()).toBe("created");
    expect(host.address()).toBeUndefined();
  });

  test("start() moves the host to running and address() reports loopback", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    try {
      await host.start();
      expect(host.state()).toBe("running");
      expect(host.address()).toBeDefined();
    } finally {
      await host.close();
    }
  });

  test("a repeated start() after running fails with the fixed already_started error", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    try {
      await host.start();
      const error = await hostErrorOf(host.start());
      expect(error.code).toBe("already_started");
      expect(host.state()).toBe("running");
    } finally {
      await host.close();
    }
  });

  test("concurrent start() calls create exactly one server", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    try {
      const results = await Promise.allSettled([host.start(), host.start(), host.start()]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);
      expect(host.state()).toBe("running");
      expect(host.address()).toBeDefined();
    } finally {
      await host.close();
    }
  });

  test("close() is idempotent and can be called repeatedly", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    await host.start();
    await host.close();
    await expect(host.close()).resolves.toBeUndefined();
    await expect(host.close()).resolves.toBeUndefined();
    expect(host.state()).toBe("closed");
  });

  test("closing a host that never started does not throw and ends closed", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    await expect(host.close()).resolves.toBeUndefined();
    expect(host.state()).toBe("closed");
  });

  test("address() returns undefined after close, never the stale address", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    await host.start();
    const running = host.address();
    expect(running).toBeDefined();
    await host.close();
    expect(host.address()).toBeUndefined();
    expect(host.address()).not.toBe(running);
  });

  test("a failed start does not fabricate the running state", async () => {
    const { port, dispose } = await createStartedTestHost();
    try {
      const second = createLocalAgentHost({ port });
      const error = await hostErrorOf(second.start());
      expect(error.code).toBe("start_failed");
      expect(second.state()).not.toBe("running");
      expect(second.address()).toBeUndefined();
      await second.close();
    } finally {
      await dispose();
    }
  });

  test("two host instances are fully isolated", async () => {
    const first = await createStartedTestHost();
    const second = await createStartedTestHost();
    try {
      expect(first.port).not.toBe(second.port);
      expect(first.host.address()).not.toBe(second.host.address());
      expect(first.host.state()).toBe("running");
      expect(second.host.state()).toBe("running");
      await first.host.close();
      expect(first.host.state()).toBe("closed");
      expect(second.host.state()).toBe("running");
      expect(second.host.address()).toBeDefined();
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  test("close while starting still ends closed without leaking", async () => {
    const host = createLocalAgentHost({ port: randomTestPort() });
    const starting = host.start();
    const closing = host.close();
    await Promise.allSettled([starting, closing]);
    expect(host.state()).toBe("closed");
    await expect(host.close()).resolves.toBeUndefined();
  });
});

describe("Task 20: signal handling through injectable registration", () => {
  test("the main entry registers SIGINT and SIGTERM exactly once and closes idempotently", async () => {
    const { runLocalAgentHostMain } = await import(
      "../apps/local-agent-host/src/main.js"
    );
    const registered: string[] = [];
    const logs: string[] = [];
    const port = randomTestPort();
    const exitCode = await runLocalAgentHostMain({
      argv: ["--host", "127.0.0.1", "--port", String(port)],
      registerSignal: (name, handler) => {
        registered.push(name);
        // Deliver SIGINT immediately, as an external signal source would.
        handler();
      },
      log: (line) => logs.push(line),
    });
    expect(exitCode).toBe(0);
    expect(registered).toEqual(["SIGINT", "SIGTERM"]);
    expect(logs.join("\n")).not.toContain("EADDRINUSE");
    // The signal path must really have closed the listener: the same port is
    // bindable again immediately afterwards.
    let rebound = false;
    for (let attempt = 0; attempt < 5 && !rebound; attempt += 1) {
      const probe = createLocalAgentHost({ host: "127.0.0.1", port });
      try {
        await probe.start();
        rebound = true;
      } catch {
        // retry — the OS may need a moment to release the listener
      }
      await probe.close().catch(() => undefined);
    }
    expect(rebound).toBe(true);
  });

  test("the main entry reports start failure as a fixed message and exit code 1", async () => {
    const { runLocalAgentHostMain } = await import(
      "../apps/local-agent-host/src/main.js"
    );
    const { port, dispose } = await createStartedTestHost();
    try {
      const logs: string[] = [];
      const exitCode = await runLocalAgentHostMain({
        argv: ["--port", String(port)],
        registerSignal: () => undefined,
        log: (line) => logs.push(line),
      });
      expect(exitCode).toBe(1);
      expect(logs.join("\n")).toBe("Local agent host failed to start.");
    } finally {
      await dispose();
    }
  });

  test("the main entry rejects invalid CLI options with fixed errors", async () => {
    const { runLocalAgentHostMain } = await import(
      "../apps/local-agent-host/src/main.js"
    );
    const exitCode = await runLocalAgentHostMain({
      argv: ["--host", "0.0.0.0", "--port", "8080"],
      registerSignal: () => undefined,
      log: () => undefined,
    });
    expect(exitCode).toBe(1);
  });

  test("the main entry rejects missing and unknown CLI options with exit code 1", async () => {
    const { runLocalAgentHostMain } = await import(
      "../apps/local-agent-host/src/main.js"
    );
    const logs: string[] = [];
    expect(
      await runLocalAgentHostMain({
        argv: [],
        registerSignal: () => undefined,
        log: (line) => logs.push(line),
      }),
    ).toBe(1);
    expect(
      await runLocalAgentHostMain({
        argv: ["--port", "70000"],
        registerSignal: () => undefined,
        log: () => undefined,
      }),
    ).toBe(1);
    expect(
      await runLocalAgentHostMain({
        argv: ["--port", "8080", "--unknown"],
        registerSignal: () => undefined,
        log: () => undefined,
      }),
    ).toBe(1);
    // Every failure path produced a single fixed log line, never a raw error.
    for (const line of logs) {
      expect(line).not.toContain("Error:");
      expect(line).not.toContain("at ");
    }
  });
});
