import { createLocalAgentHost } from "./host.js";
import { createConfiguredLocalAgentHost } from "./configured-host.js";
import { ConfigBootstrapError, LocalAgentHostError } from "./errors.js";
import type { LocalAgentHostMainOptions } from "./types.js";
import { validateHostOptions } from "./validation.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ParsedArguments {
  readonly host?: "127.0.0.1" | "localhost";
  readonly port: number;
  readonly configFilePath?: string;
  readonly createIfMissing: boolean;
}

/**
 * Parses `--host <loopback> --port <1-65535>` arguments. Unknown arguments,
 * missing values and missing ports reject with the fixed invalid_options
 * error; port values are converted and then revalidated by the host.
 */
function parseArguments(argv: readonly string[]): ParsedArguments {
  let host: string | undefined;
  let rawPort: string | undefined;
  let configFilePath: string | undefined;
  let createIfMissing = false;
  let sawHost = false;
  let sawPort = false;
  let sawConfig = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") {
      if (sawHost) throw new LocalAgentHostError("invalid_options");
      if (index + 1 >= argv.length || argv[index + 1]?.startsWith("--")) {
        throw new LocalAgentHostError("invalid_options");
      }
      sawHost = true;
      host = argv[index + 1];
      index += 1;
    } else if (argument === "--port") {
      if (sawPort) throw new LocalAgentHostError("invalid_options");
      if (index + 1 >= argv.length || argv[index + 1]?.startsWith("--")) {
        throw new LocalAgentHostError("invalid_options");
      }
      sawPort = true;
      rawPort = argv[index + 1];
      index += 1;
    } else if (argument === "--config") {
      if (sawConfig) throw new LocalAgentHostError("invalid_options");
      if (index + 1 >= argv.length || argv[index + 1]?.startsWith("--")) {
        throw new LocalAgentHostError("invalid_options");
      }
      sawConfig = true;
      configFilePath = argv[index + 1];
      index += 1;
    } else if (argument === "--create-if-missing") {
      if (createIfMissing) throw new LocalAgentHostError("invalid_options");
      createIfMissing = true;
    } else {
      throw new LocalAgentHostError("invalid_options");
    }
  }
  if (rawPort === undefined || host === "") {
    throw new LocalAgentHostError("invalid_options");
  }
  if (createIfMissing && configFilePath === undefined) {
    throw new LocalAgentHostError("invalid_options");
  }
  const port = Number(rawPort);
  const parsed: ParsedArguments = {
    port,
    createIfMissing,
    ...(host === undefined ? {} : { host: host as "127.0.0.1" | "localhost" }),
    ...(configFilePath === undefined ? {} : { configFilePath }),
  };
  validateHostOptions({
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    port: parsed.port,
    runner: undefined,
  });
  return parsed;
}

/**
 * Node entry point. Starts the loopback host, registers SIGINT and SIGTERM
 * exactly once each (through the injectable hook) and closes idempotently.
 * It returns an exit code instead of terminating the process, so tests can
 * drive it without killing the vitest runner. No environment variable is
 * read; the port comes from the arguments.
 */
export async function runLocalAgentHostMain(
  options: LocalAgentHostMainOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    const argv = options.argv ?? process.argv.slice(2);
    const parsed = parseArguments(argv);
    const host = parsed.configFilePath === undefined
      ? createLocalAgentHost({
          ...(parsed.host === undefined ? {} : { host: parsed.host }),
          port: parsed.port,
        })
      : await createConfiguredLocalAgentHost({
          ...(parsed.host === undefined ? {} : { host: parsed.host }),
          port: parsed.port,
          configFilePath: parsed.configFilePath,
          createIfMissing: parsed.createIfMissing,
        });
    // Configured bootstrap starts its host after the file has been validated;
    // the plain host still needs to be started here.
    if (parsed.configFilePath === undefined) {
      await host.start();
    }

    let resolveShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const onSignal = (name: "SIGINT" | "SIGTERM"): void => {
      void host
        .close()
        .catch(() => undefined)
        .then(() => resolveShutdown());
    };
    const registerSignal =
      options.registerSignal ??
      ((name: "SIGINT" | "SIGTERM", handler: () => void) => {
        process.on(name, () => handler());
      });
    registerSignal("SIGINT", () => onSignal("SIGINT"));
    registerSignal("SIGTERM", () => onSignal("SIGTERM"));
    await shutdown;
    return 0;
  } catch (error: unknown) {
    log(
      error instanceof LocalAgentHostError || error instanceof ConfigBootstrapError
        ? error.message
        : "Local agent host failed to start.",
    );
    return 1;
  }
}

// Keep imports side-effect free for tests and library consumers, while making
// the compiled file a real executable entry for the native Tauri supervisor.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void runLocalAgentHostMain().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
