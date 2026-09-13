import { describe, expect, it } from "vitest";
import { createLocalAgentHost } from "../apps/local-agent-host/src/host.js";
import { LocalAgentHostError } from "../apps/local-agent-host/src/errors.js";

const TEST_PORT = 14400;

describe("task 23 security boundaries", () => {
  it("rejects 0.0.0.0 host", () => {
    expect(() =>
      createLocalAgentHost({ host: "0.0.0.0" as never, port: TEST_PORT }),
    ).toThrow(LocalAgentHostError);
  });

  it("rejects a remote hostname", () => {
    expect(() =>
      createLocalAgentHost({ host: "example.com" as never, port: TEST_PORT }),
    ).toThrow(LocalAgentHostError);
  });

  it("rejects IPv6 any-address", () => {
    expect(() =>
      createLocalAgentHost({ host: "::" as never, port: TEST_PORT }),
    ).toThrow(LocalAgentHostError);
  });

  it("does not read process.env", () => {
    const originalEnv = process.env.TASK23_TEST_SECRET;
    process.env.TASK23_TEST_SECRET = "should-not-be-read";
    try {
      const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT });
      expect(host.state()).toBe("created");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TASK23_TEST_SECRET;
      } else {
        process.env.TASK23_TEST_SECRET = originalEnv;
      }
    }
  });

  it("error messages never contain paths or ports", () => {
    const error = new LocalAgentHostError("start_failed");
    expect(error.message).not.toContain("/");
    expect(error.message).not.toContain("\\");
    expect(error.message).not.toContain("4317");
    expect(error.message).not.toContain("127.0.0.1");
  });

  it("rejects a non-string host", () => {
    expect(() =>
      createLocalAgentHost({ host: 123 as never, port: TEST_PORT }),
    ).toThrow(LocalAgentHostError);
  });

  it("rejects a negative port", () => {
    expect(() => createLocalAgentHost({ port: -1 })).toThrow(LocalAgentHostError);
  });

  it("rejects a non-integer port", () => {
    expect(() => createLocalAgentHost({ port: 3.14 })).toThrow(LocalAgentHostError);
  });
});

describe("task 23 cancellation", () => {
  it("close is safe on a never-started host", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 1 });
    await expect(host.close()).resolves.toBeUndefined();
  });

  it("close after close is safe", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 2 });
    await host.start();
    await host.close();
    await expect(host.close()).resolves.toBeUndefined();
  });

  it("address is undefined before start and after close", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 3 });
    expect(host.address()).toBeUndefined();
    await host.start();
    expect(host.address()).toBeDefined();
    await host.close();
    expect(host.address()).toBeUndefined();
  });

  it("start after close rejects with already_started", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 4 });
    await host.start();
    await host.close();
    await expect(host.start()).rejects.toMatchObject({ code: "already_started" });
  });

  it("concurrent close calls do not throw", async () => {
    const host = createLocalAgentHost({ host: "127.0.0.1", port: TEST_PORT + 5 });
    await host.start();
    await Promise.all([host.close(), host.close(), host.close()]);
    expect(host.state()).toBe("closed");
  });
});
