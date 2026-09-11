import type { AgentEvent } from "@agent-workbench/agent-core";
import type { LocalAgentTurnRequest } from "@agent-workbench/local-agent-api";
import type { ParsedArgs } from "./types.js";
import { LocalAgentApiClient } from "./api-client.js";
import { failCli } from "./errors.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliRuntime {
  readonly fetch: typeof fetch;
  readonly exit: (code: number) => never;
}

const VERSION = "0.0.0";
const HELP_TEXT = `agent-workbench CLI

Usage:
  agent-workbench <command> [options]

Commands:
  help                      Show this help message
  version                   Show version
  health                    Check API health
  session-create            Create a new session
  session-show <id>         Show session details
  session-events <id>       List session events
  run <id> <message>        Run a turn in a session
  cancel <id>               Cancel active turn

Options:
  --base-url <url>          Local API base URL (default: http://127.0.0.1:4317)
  --json                    Output JSON format
  --route-id <id>           Route ID for run command
  --model <name>            Model name for run command
  --max-tokens <n>          Max tokens for run command
`;

export async function runCli(
  args: ParsedArgs,
  io: CliIo,
  runtime: CliRuntime,
): Promise<void> {
  if (args.command === "help") {
    io.stdout(HELP_TEXT);
    return;
  }

  if (args.command === "version") {
    io.stdout(`agent-workbench v${VERSION}`);
    return;
  }

  const client = new LocalAgentApiClient(args.baseUrl, runtime.fetch);

  if (args.command === "health") {
    const response = await client.health();
    if (args.json) {
      io.stdout(JSON.stringify(response));
    } else {
      io.stdout("OK");
    }
    return;
  }

  if (args.command === "session-create") {
    const session = await client.createSession();
    if (args.json) {
      io.stdout(JSON.stringify(session));
    } else {
      io.stdout(`Created session: ${session.id}`);
    }
    return;
  }

  if (args.command === "session-show") {
    if (!args.sessionId) {
      failCli("invalidArguments");
    }
    const session = await client.getSession(args.sessionId);
    if (args.json) {
      io.stdout(JSON.stringify(session));
    } else {
      io.stdout(`Session ${session.id}: ${session.status}`);
    }
    return;
  }

  if (args.command === "session-events") {
    if (!args.sessionId) {
      failCli("invalidArguments");
    }
    const events = await client.listEvents(args.sessionId);
    if (args.json) {
      io.stdout(JSON.stringify(events));
    } else {
      io.stdout(`${events.length} events`);
    }
    return;
  }

  if (args.command === "cancel") {
    if (!args.sessionId) {
      failCli("invalidArguments");
    }
    await client.cancel(args.sessionId);
    if (args.json) {
      io.stdout(JSON.stringify({ cancelled: true }));
    } else {
      io.stdout("Cancelled");
    }
    return;
  }

  if (args.command === "run") {
    if (!args.sessionId || !args.message) {
      failCli("invalidArguments");
    }

    const request: LocalAgentTurnRequest = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: args.message }],
        },
      ],
    };

    if (args.routeId) {
      (request as any).routeId = args.routeId;
    }
    if (args.model) {
      (request as any).model = args.model;
    }
    if (args.maxTokens !== undefined) {
      (request as any).maxTokens = args.maxTokens;
    }

    const stream = client.runTurn(args.sessionId, request);

    for await (const event of stream) {
      if (args.json) {
        io.stdout(JSON.stringify(event));
      } else {
        if (event.type === "text_delta") {
          io.stdout(event.text);
        } else if (event.type === "completed") {
          io.stderr("\n[Completed]");
        } else if (event.type === "error") {
          io.stderr(`\n[Error: ${event.code}]`);
        }
      }
    }
    return;
  }

  failCli("invalidArguments");
}
