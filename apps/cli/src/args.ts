import { failCli } from "./errors.js";
import type { ParsedArgs } from "./types.js";
import { DEFAULT_BASE_URL } from "./types.js";

const SENSITIVE_PARAMS = new Set([
  "--api-key",
  "--apikey",
  "--token",
  "--secret",
  "--password",
  "--authorization",
  "--headers",
  "--credential",
  "--credential-ref",
]);

function validateBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    failCli("invalidBaseUrl");
  }

  if (parsed.protocol !== "http:") {
    failCli("invalidBaseUrl");
  }

  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    failCli("invalidBaseUrl");
  }

  if (parsed.username || parsed.password) {
    failCli("invalidBaseUrl");
  }

  if (parsed.search || parsed.hash) {
    failCli("invalidBaseUrl");
  }

  const lower = url.toLowerCase();
  if (
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("apikey") ||
    lower.includes("authorization")
  ) {
    failCli("invalidBaseUrl");
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  let baseUrl = DEFAULT_BASE_URL;
  let json = false;
  let message: string | undefined;
  let routeId: string | undefined;
  let model: string | undefined;
  let maxTokens: number | undefined;

  const seenFlags = new Set<string>();

  function consumeFlag(flag: string): string | undefined {
    if (seenFlags.has(flag)) {
      failCli("invalidArguments");
    }
    seenFlags.add(flag);

    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;

    if (idx === args.length - 1) {
      failCli("invalidArguments");
    }

    args.splice(idx, 1);
    const value = args.splice(idx, 1)[0];
    return value;
  }

  function consumeBooleanFlag(flag: string): boolean {
    if (seenFlags.has(flag)) {
      failCli("invalidArguments");
    }

    const idx = args.indexOf(flag);
    if (idx === -1) return false;

    seenFlags.add(flag);
    args.splice(idx, 1);
    return true;
  }

  for (const arg of args) {
    if (SENSITIVE_PARAMS.has(arg)) {
      failCli("invalidArguments");
    }
  }

  if (consumeBooleanFlag("--help")) {
    return { command: "help", baseUrl, json };
  }

  if (consumeBooleanFlag("--version")) {
    return { command: "version", baseUrl, json };
  }

  const baseUrlArg = consumeFlag("--base-url");
  if (baseUrlArg !== undefined) {
    validateBaseUrl(baseUrlArg);
    baseUrl = baseUrlArg;
  }

  json = consumeBooleanFlag("--json");

  message = consumeFlag("--message");
  routeId = consumeFlag("--route-id");
  model = consumeFlag("--model");

  const maxTokensStr = consumeFlag("--max-tokens");
  if (maxTokensStr !== undefined) {
    const parsed = Number(maxTokensStr);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      failCli("invalidArguments");
    }
    maxTokens = parsed;
  }

  if (args.length === 0) {
    failCli("invalidArguments");
  }

  const command = args.shift()!;

  if (command === "health") {
    if (args.length !== 0) {
      failCli("invalidArguments");
    }
    return { command: "health", baseUrl, json };
  }

  if (command === "session") {
    if (args.length === 0) {
      failCli("invalidArguments");
    }

    const subcommand = args.shift()!;

    if (subcommand === "create") {
      if (args.length !== 0) {
        failCli("invalidArguments");
      }
      return { command: "session-create", baseUrl, json };
    }

    if (subcommand === "show") {
      if (args.length !== 1) {
        failCli("invalidArguments");
      }
      const sessionId = args[0];
      return { command: "session-show", sessionId, baseUrl, json };
    }

    if (subcommand === "events") {
      if (args.length !== 1) {
        failCli("invalidArguments");
      }
      const sessionId = args[0];
      return { command: "session-events", sessionId, baseUrl, json };
    }

    failCli("invalidArguments");
  }

  if (command === "run") {
    if (args.length !== 1) {
      failCli("invalidArguments");
    }

    const sessionId = args[0];

    if (message === undefined || message.length === 0) {
      failCli("invalidArguments");
    }

    return {
      command: "run",
      sessionId,
      message,
      routeId,
      model,
      maxTokens,
      baseUrl,
      json,
    };
  }

  if (command === "cancel") {
    if (args.length !== 1) {
      failCli("invalidArguments");
    }

    const sessionId = args[0];
    return { command: "cancel", sessionId, baseUrl, json };
  }

  failCli("invalidArguments");
}
