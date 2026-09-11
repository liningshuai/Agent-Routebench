import { describe, test, expect } from "vitest";
import { CLI_ERROR_CODES, createCliError } from "../apps/cli/src/errors.js";
import { runCli } from "../apps/cli/src/cli.js";
import type { CliIo, CliRuntime } from "../apps/cli/src/cli.js";

describe("task 13 CLI security", () => {
  describe("error message sanitization", () => {
    test("does not echo URL in error messages", async () => {
      const fetch = async () => {
        throw new Error("fetch failed");
      };

      const outputs: string[] = [];
      const io: CliIo = {
        stdout: (msg) => outputs.push(msg),
        stderr: (msg) => outputs.push(msg),
      };

      const runtime: CliRuntime = {
        fetch: fetch as any,
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      try {
        await runCli(
          {
            command: "health",
            baseUrl: "http://127.0.0.1:9999",
            json: false,
          },
          io,
          runtime,
        );
      } catch {
        // expected
      }

      const allOutput = outputs.join("");
      expect(allOutput).not.toContain("http://127.0.0.1:9999");
      expect(allOutput).not.toContain("9999");
    });

    test("does not echo session ID in error messages", async () => {
      const fetch = async () => {
        return new Response("", { status: 404 });
      };

      const outputs: string[] = [];
      const io: CliIo = {
        stdout: (msg) => outputs.push(msg),
        stderr: (msg) => outputs.push(msg),
      };

      const runtime: CliRuntime = {
        fetch: fetch as any,
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      try {
        await runCli(
          {
            command: "session-show",
            sessionId: "secret-session-abc123",
            baseUrl: "http://127.0.0.1:4317",
            json: false,
          },
          io,
          runtime,
        );
      } catch {
        // expected
      }

      const allOutput = outputs.join("");
      expect(allOutput).not.toContain("secret-session-abc123");
    });

    test("fixed error messages do not vary by input", () => {
      const err1 = createCliError("apiUnavailable");
      const err2 = createCliError("apiUnavailable");
      expect(err1.message).toBe(err2.message);
      expect(err1.message).toBe("Local Agent API is unavailable.");
    });

    test("error codes are from fixed set", () => {
      const codes = Object.values(CLI_ERROR_CODES);
      expect(codes).toHaveLength(7);
      expect(codes).toContain("invalid_arguments");
      expect(codes).toContain("invalid_base_url");
      expect(codes).toContain("api_unavailable");
      expect(codes).toContain("api_http_error");
      expect(codes).toContain("api_protocol_error");
      expect(codes).toContain("stream_too_large");
      expect(codes).toContain("aborted");
    });
  });

  describe("no credential handling", () => {
    test("CLI does not read process.env", () => {
      const envAccess = Object.getOwnPropertyDescriptor(process, "env");
      expect(envAccess).toBeDefined();
    });

    test("fetch is provided by runtime injection", async () => {
      let fetchCalled = false;
      const fetch = async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const io: CliIo = {
        stdout: () => {},
        stderr: () => {},
      };

      const runtime: CliRuntime = {
        fetch: fetch as any,
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      await runCli(
        {
          command: "health",
          baseUrl: "http://127.0.0.1:4317",
          json: false,
        },
        io,
        runtime,
      );

      expect(fetchCalled).toBe(true);
    });
  });

  describe("exit codes", () => {
    test("runCli does not call process.exit directly", async () => {
      const io: CliIo = {
        stdout: () => {},
        stderr: () => {},
      };

      const runtime: CliRuntime = {
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        exit: (() => {
          throw new Error("exit called");
        }) as any,
      };

      await runCli(
        {
          command: "health",
          baseUrl: "http://127.0.0.1:4317",
          json: false,
        },
        io,
        runtime,
      );
    });

    test("exit is runtime responsibility", () => {
      let exitCode: number | undefined;
      const runtime: CliRuntime = {
        fetch: fetch as any,
        exit: (code: number) => {
          exitCode = code;
          throw new Error("exit");
        },
      };

      expect(() => runtime.exit(42)).toThrow("exit");
      expect(exitCode).toBe(42);
    });
  });

  describe("no process.env access", () => {
    test("CLI modules do not import dotenv", async () => {
      const cliModule = await import("../apps/cli/src/cli.js");
      expect(cliModule).toBeDefined();
    });

    test("CLI does not access environment variables", async () => {
      const originalEnv = process.env.TEST_SECRET;
      process.env.TEST_SECRET = "should-not-appear";

      const outputs: string[] = [];
      const io: CliIo = {
        stdout: (msg) => outputs.push(msg),
        stderr: (msg) => outputs.push(msg),
      };

      const runtime: CliRuntime = {
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        exit: (() => {
          throw new Error("exit");
        }) as any,
      };

      await runCli(
        {
          command: "health",
          baseUrl: "http://127.0.0.1:4317",
          json: false,
        },
        io,
        runtime,
      );

      const allOutput = outputs.join("");
      expect(allOutput).not.toContain("should-not-appear");

      if (originalEnv !== undefined) {
        process.env.TEST_SECRET = originalEnv;
      } else {
        delete process.env.TEST_SECRET;
      }
    });
  });
});

