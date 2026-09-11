#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { runCli } from "./cli.js";
import { CLI_ERROR_CODES } from "./errors.js";

const io = {
  stdout: (message: string) => process.stdout.write(message),
  stderr: (message: string) => process.stderr.write(message),
};

const runtime = {
  fetch,
  exit: (code: number): never => process.exit(code),
};

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    await runCli(args, io, runtime);
    process.exit(0);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      const code = (err as { code: string }).code;
      const message = (err as { message: string }).message;

      if (code === CLI_ERROR_CODES.invalidArguments) {
        io.stderr(`Error: ${message}\n`);
        process.exit(1);
      }
      if (code === CLI_ERROR_CODES.invalidBaseUrl) {
        io.stderr(`Error: ${message}\n`);
        process.exit(1);
      }
      if (code === CLI_ERROR_CODES.apiUnavailable) {
        io.stderr(`Error: ${message}\n`);
        process.exit(2);
      }
      if (code === CLI_ERROR_CODES.apiHttpError) {
        io.stderr(`Error: ${message}\n`);
        process.exit(2);
      }
      if (code === CLI_ERROR_CODES.apiProtocolError) {
        io.stderr(`Error: ${message}\n`);
        process.exit(2);
      }
      if (code === CLI_ERROR_CODES.streamTooLarge) {
        io.stderr(`Error: ${message}\n`);
        process.exit(2);
      }
      if (code === CLI_ERROR_CODES.aborted) {
        io.stderr(`Error: ${message}\n`);
        process.exit(3);
      }
    }

    io.stderr(`Error: An unexpected error occurred.\n`);
    process.exit(1);
  }
}

main();
