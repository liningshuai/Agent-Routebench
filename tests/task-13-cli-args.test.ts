import { describe, test, expect } from "vitest";
import { parseArgs } from "../apps/cli/src/args.js";
import { CLI_ERROR_CODES } from "../apps/cli/src/errors.js";

describe("task 13 CLI argument parsing", () => {
  describe("help and version", () => {
    test("--help", () => {
      const result = parseArgs(["--help"]);
      expect(result.command).toBe("help");
    });

    test("--version", () => {
      const result = parseArgs(["--version"]);
      expect(result.command).toBe("version");
    });
  });

  describe("health", () => {
    test("health without options", () => {
      const result = parseArgs(["health"]);
      expect(result.command).toBe("health");
      expect(result.baseUrl).toBe("http://127.0.0.1:4317");
      expect(result.json).toBe(false);
    });

    test("health with --json", () => {
      const result = parseArgs(["health", "--json"]);
      expect(result.json).toBe(true);
    });

    test("health with custom base URL", () => {
      const result = parseArgs(["health", "--base-url", "http://localhost:8080"]);
      expect(result.baseUrl).toBe("http://localhost:8080");
    });

    test("health with extra args fails", () => {
      expect(() => parseArgs(["health", "extra"])).toThrow();
    });
  });

  describe("session commands", () => {
    test("session create", () => {
      const result = parseArgs(["session", "create"]);
      expect(result.command).toBe("session-create");
    });

    test("session show", () => {
      const result = parseArgs(["session", "show", "sess-123"]);
      expect(result.command).toBe("session-show");
      expect(result.sessionId).toBe("sess-123");
    });

    test("session show without id fails", () => {
      expect(() => parseArgs(["session", "show"])).toThrow();
    });

    test("session events", () => {
      const result = parseArgs(["session", "events", "sess-456"]);
      expect(result.command).toBe("session-events");
      expect(result.sessionId).toBe("sess-456");
    });

    test("session with unknown subcommand fails", () => {
      expect(() => parseArgs(["session", "unknown"])).toThrow();
    });

    test("session without subcommand fails", () => {
      expect(() => parseArgs(["session"])).toThrow();
    });
  });

  describe("run command", () => {
    test("run with message", () => {
      const result = parseArgs(["run", "sess-789", "--message", "Hello"]);
      expect(result.command).toBe("run");
      expect(result.sessionId).toBe("sess-789");
      expect(result.message).toBe("Hello");
      expect(result.routeId).toBeUndefined();
      expect(result.model).toBeUndefined();
      expect(result.maxTokens).toBeUndefined();
    });

    test("run with all optional parameters", () => {
      const result = parseArgs([
        "run",
        "sess-xyz",
        "--message",
        "Test",
        "--route-id",
        "route-1",
        "--model",
        "gpt-4",
        "--max-tokens",
        "1000",
      ]);
      expect(result.routeId).toBe("route-1");
      expect(result.model).toBe("gpt-4");
      expect(result.maxTokens).toBe(1000);
    });

    test("run without sessionId fails", () => {
      expect(() => parseArgs(["run", "--message", "Hello"])).toThrow();
    });

    test("run without message fails", () => {
      expect(() => parseArgs(["run", "sess-123"])).toThrow();
    });

    test("run with empty message fails", () => {
      expect(() => parseArgs(["run", "sess-123", "--message", ""])).toThrow();
    });

    test("run with non-integer maxTokens fails", () => {
      expect(() =>
        parseArgs(["run", "sess-123", "--message", "Hi", "--max-tokens", "1.5"]),
      ).toThrow();
    });

    test("run with negative maxTokens fails", () => {
      expect(() =>
        parseArgs(["run", "sess-123", "--message", "Hi", "--max-tokens", "-1"]),
      ).toThrow();
    });

    test("run with zero maxTokens fails", () => {
      expect(() =>
        parseArgs(["run", "sess-123", "--message", "Hi", "--max-tokens", "0"]),
      ).toThrow();
    });

    test("run with non-numeric maxTokens fails", () => {
      expect(() =>
        parseArgs(["run", "sess-123", "--message", "Hi", "--max-tokens", "abc"]),
      ).toThrow();
    });
  });

  describe("cancel command", () => {
    test("cancel with sessionId", () => {
      const result = parseArgs(["cancel", "sess-999"]);
      expect(result.command).toBe("cancel");
      expect(result.sessionId).toBe("sess-999");
    });

    test("cancel without sessionId fails", () => {
      expect(() => parseArgs(["cancel"])).toThrow();
    });
  });

  describe("base URL validation", () => {
    test("accepts 127.0.0.1", () => {
      const result = parseArgs(["health", "--base-url", "http://127.0.0.1:4317"]);
      expect(result.baseUrl).toBe("http://127.0.0.1:4317");
    });

    test("accepts localhost", () => {
      const result = parseArgs(["health", "--base-url", "http://localhost:9000"]);
      expect(result.baseUrl).toBe("http://localhost:9000");
    });

    test("rejects https", () => {
      expect(() => parseArgs(["health", "--base-url", "https://127.0.0.1:4317"])).toThrow();
    });

    test("rejects 0.0.0.0", () => {
      expect(() => parseArgs(["health", "--base-url", "http://0.0.0.0:4317"])).toThrow();
    });

    test("rejects public IP", () => {
      expect(() => parseArgs(["health", "--base-url", "http://8.8.8.8:4317"])).toThrow();
    });

    test("rejects LAN IP", () => {
      expect(() => parseArgs(["health", "--base-url", "http://192.168.1.1:4317"])).toThrow();
    });

    test("rejects domain name", () => {
      expect(() => parseArgs(["health", "--base-url", "http://example.com:4317"])).toThrow();
    });

    test("rejects URL with username", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://user@127.0.0.1:4317"]),
      ).toThrow();
    });

    test("rejects URL with password", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://user:pass@127.0.0.1:4317"]),
      ).toThrow();
    });

    test("rejects URL with query string", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://127.0.0.1:4317?key=value"]),
      ).toThrow();
    });

    test("rejects URL with hash", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://127.0.0.1:4317#anchor"]),
      ).toThrow();
    });

    test("rejects URL containing token", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://127.0.0.1:4317/token"]),
      ).toThrow();
    });

    test("rejects URL containing secret", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://127.0.0.1:4317/secret"]),
      ).toThrow();
    });

    test("rejects URL containing apikey", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://127.0.0.1:4317/apikey"]),
      ).toThrow();
    });

    test("rejects URL containing authorization", () => {
      expect(() =>
        parseArgs(["health", "--base-url", "http://127.0.0.1:4317/authorization"]),
      ).toThrow();
    });

    test("rejects invalid URL format", () => {
      expect(() => parseArgs(["health", "--base-url", "not-a-url"])).toThrow();
    });
  });

  describe("sensitive parameter rejection", () => {
    test("rejects --api-key", () => {
      expect(() => parseArgs(["health", "--api-key", "sk-123"])).toThrow();
    });

    test("rejects --apikey", () => {
      expect(() => parseArgs(["health", "--apikey", "sk-123"])).toThrow();
    });

    test("rejects --token", () => {
      expect(() => parseArgs(["health", "--token", "tok-123"])).toThrow();
    });

    test("rejects --secret", () => {
      expect(() => parseArgs(["health", "--secret", "sec-123"])).toThrow();
    });

    test("rejects --password", () => {
      expect(() => parseArgs(["health", "--password", "pass"])).toThrow();
    });

    test("rejects --authorization", () => {
      expect(() => parseArgs(["health", "--authorization", "Bearer xyz"])).toThrow();
    });

    test("rejects --headers", () => {
      expect(() => parseArgs(["health", "--headers", "{}"])).toThrow();
    });

    test("rejects --credential", () => {
      expect(() => parseArgs(["health", "--credential", "cred-1"])).toThrow();
    });

    test("rejects --credential-ref", () => {
      expect(() => parseArgs(["health", "--credential-ref", "ref-1"])).toThrow();
    });
  });

  describe("duplicate and unknown parameters", () => {
    test("rejects duplicate --json", () => {
      expect(() => parseArgs(["health", "--json", "--json"])).toThrow();
    });

    test("rejects duplicate --base-url", () => {
      expect(() =>
        parseArgs([
          "health",
          "--base-url",
          "http://127.0.0.1:4317",
          "--base-url",
          "http://localhost:8080",
        ]),
      ).toThrow();
    });

    test("rejects duplicate --message", () => {
      expect(() =>
        parseArgs([
          "run",
          "sess-123",
          "--message",
          "Hello",
          "--message",
          "World",
        ]),
      ).toThrow();
    });

    test("rejects duplicate --route-id", () => {
      expect(() =>
        parseArgs([
          "run",
          "sess-123",
          "--message",
          "Hi",
          "--route-id",
          "r1",
          "--route-id",
          "r2",
        ]),
      ).toThrow();
    });

    test("rejects duplicate --model", () => {
      expect(() =>
        parseArgs([
          "run",
          "sess-123",
          "--message",
          "Hi",
          "--model",
          "m1",
          "--model",
          "m2",
        ]),
      ).toThrow();
    });

    test("rejects duplicate --max-tokens", () => {
      expect(() =>
        parseArgs([
          "run",
          "sess-123",
          "--message",
          "Hi",
          "--max-tokens",
          "100",
          "--max-tokens",
          "200",
        ]),
      ).toThrow();
    });

    test("rejects unknown command", () => {
      expect(() => parseArgs(["unknown"])).toThrow();
    });

    test("rejects empty args", () => {
      expect(() => parseArgs([])).toThrow();
    });
  });

  describe("error codes", () => {
    test("invalid arguments produce correct error code", () => {
      try {
        parseArgs(["unknown"]);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe(CLI_ERROR_CODES.invalidArguments);
        expect(err.message).toBe("CLI arguments are invalid.");
      }
    });

    test("invalid base URL produces correct error code", () => {
      try {
        parseArgs(["health", "--base-url", "http://example.com"]);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe(CLI_ERROR_CODES.invalidBaseUrl);
        expect(err.message).toBe("Local API URL is invalid.");
      }
    });
  });

  describe("argv immutability", () => {
    test("does not modify input argv", () => {
      const original = ["health", "--json"];
      const frozen = Object.freeze([...original]);
      parseArgs(frozen);
      expect(frozen).toEqual(original);
    });
  });
});
