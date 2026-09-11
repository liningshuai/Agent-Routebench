import { describe, test, expect } from "vitest";
import { createLocalAgentApiServer } from "@agent-workbench/local-agent-api";
import type {
  LocalAgentRunner,
  LocalAgentRunnerRequest,
} from "@agent-workbench/local-agent-api";
import type { AgentEvent } from "@agent-workbench/agent-core";
import { runCli } from "../apps/cli/src/cli.js";
import type { CliIo, CliRuntime } from "../apps/cli/src/cli.js";

describe("task 13 CLI integration", () => {
  test("full CLI workflow with local API server", async () => {
    const runner: LocalAgentRunner = {
      async *run(request: LocalAgentRunnerRequest): AsyncIterable<AgentEvent> {
        yield {
          type: "route_selected",
          requestId: request.turnId,
          routeId: "test-route",
          model: "test-model",
        };
        yield {
          type: "text_delta",
          requestId: request.turnId,
          text: "Hello from runner",
        };
        yield {
          type: "completed",
          requestId: request.turnId,
        };
      },
    };

    const server = createLocalAgentApiServer({
      host: "127.0.0.1",
      port: 0,
      runner,
    });

    await server.start();
    const address = server.address();
    expect(address).toBeDefined();

    try {
      const outputs: string[] = [];
      const io: CliIo = {
        stdout: (msg) => outputs.push(msg),
        stderr: (msg) => outputs.push(msg),
      };

      const runtime: CliRuntime = {
        fetch,
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      // Test health
      await runCli(
        {
          command: "health",
          baseUrl: address!,
          json: false,
        },
        io,
        runtime,
      );

      expect(outputs.some((o) => o.includes("OK"))).toBe(true);
      outputs.length = 0;

      // Test session creation
      await runCli(
        {
          command: "session-create",
          baseUrl: address!,
          json: true,
        },
        io,
        runtime,
      );

      const sessionLine = outputs.find((o) => o.includes('"id"'));
      expect(sessionLine).toBeDefined();
      const session = JSON.parse(sessionLine!);
      expect(session.id).toBeDefined();
      expect(session.status).toBe("idle");

      outputs.length = 0;

      // Test run turn
      await runCli(
        {
          command: "run",
          sessionId: session.id,
          message: "Test message",
          baseUrl: address!,
          json: false,
        },
        io,
        runtime,
      );

      const allOutput = outputs.join("");
      expect(allOutput).toContain("Hello from runner");
      expect(allOutput).toContain("[Completed]");
    } finally {
      await server.close();
    }
  });

  test("CLI handles server errors gracefully", async () => {
    const runner: LocalAgentRunner = {
      async *run(): AsyncIterable<AgentEvent> {
        yield {
          type: "error",
          requestId: "req-1",
          code: "test_error",
          message: "Test error",
          retryable: false,
        };
      },
    };

    const server = createLocalAgentApiServer({
      host: "127.0.0.1",
      port: 0,
      runner,
    });

    await server.start();
    const address = server.address();

    try {
      const outputs: string[] = [];
      const io: CliIo = {
        stdout: (msg) => outputs.push(msg),
        stderr: (msg) => outputs.push(msg),
      };

      const runtime: CliRuntime = {
        fetch,
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      const sessionResponse = await fetch(`${address}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((r) => r.json());

      await runCli(
        {
          command: "run",
          sessionId: sessionResponse.session.id,
          message: "Test",
          baseUrl: address!,
          json: false,
        },
        io,
        runtime,
      );

      const allOutput = outputs.join("");
      expect(allOutput).toContain("[Error: test_error]");
    } finally {
      await server.close();
    }
  });

  test("CLI streams events incrementally", async () => {
    const runner: LocalAgentRunner = {
      async *run(request: LocalAgentRunnerRequest): AsyncIterable<AgentEvent> {
        yield {
          type: "text_delta",
          requestId: request.turnId,
          text: "First",
        };
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield {
          type: "text_delta",
          requestId: request.turnId,
          text: "Second",
        };
        yield {
          type: "completed",
          requestId: request.turnId,
        };
      },
    };

    const server = createLocalAgentApiServer({
      host: "127.0.0.1",
      port: 0,
      runner,
    });

    await server.start();
    const address = server.address();

    try {
      const outputs: string[] = [];
      const io: CliIo = {
        stdout: (msg) => outputs.push(msg),
        stderr: (msg) => outputs.push(msg),
      };

      const runtime: CliRuntime = {
        fetch,
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      const sessionResponse = await fetch(`${address}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((r) => r.json());

      await runCli(
        {
          command: "run",
          sessionId: sessionResponse.session.id,
          message: "Test",
          baseUrl: address!,
          json: false,
        },
        io,
        runtime,
      );

      const allOutput = outputs.join("");
      expect(allOutput).toContain("First");
      expect(allOutput).toContain("Second");
    } finally {
      await server.close();
    }
  });
});

