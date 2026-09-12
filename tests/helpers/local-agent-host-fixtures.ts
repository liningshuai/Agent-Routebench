import type { AgentEvent } from "../../packages/agent-core/src/index.js";
import type {
  LocalAgentRunner,
  LocalAgentRunnerRequest,
} from "../../packages/local-agent-api/src/index.js";
import {
  createLocalAgentHost,
  type LocalAgentHost,
  type LocalAgentHostOptions,
} from "../../apps/local-agent-host/src/index.js";

/** Fixed error message asserted by the not-ready runner flow. */
export const RUNNER_NOT_READY_MESSAGE = "Local agent runner is not ready.";

/** Fixed runner_error message produced by the existing Task 9 server. */
export const SERVER_RUNNER_ERROR_MESSAGE = "Agent runner failed.";

/**
 * Picks a random port in the ephemeral-ish range. The public host option
 * rejects port 0, so tests allocate a random valid port and retry on the
 * (rare) collision instead of weakening the public validation.
 */
export function randomTestPort(): number {
  return 30000 + Math.floor(Math.random() * 30000);
}

export class ScriptedRunner implements LocalAgentRunner {
  readonly #events: readonly AgentEvent[];

  constructor(events: readonly AgentEvent[]) {
    this.#events = events;
  }

  async run(
    _request: LocalAgentRunnerRequest,
  ): Promise<AsyncIterable<AgentEvent>> {
    const events = this.#events;
    return (async function* generate() {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

/** A runner whose run() throws a fixed, non-revealing error. */
export function throwingRunner(): LocalAgentRunner {
  return {
    async run(): Promise<AsyncIterable<AgentEvent>> {
      throw new Error(RUNNER_NOT_READY_MESSAGE);
    },
  };
}

export function validTurnRequest(): Record<string, unknown> {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };
}

/**
 * Creates a host on a random loopback port, retrying on the rare collision
 * until it starts. Always closes the host via the returned dispose function.
 */
export async function createStartedTestHost(
  overrides: Partial<LocalAgentHostOptions> = {},
): Promise<{ host: LocalAgentHost; port: number; dispose: () => Promise<void> }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = overrides.port ?? randomTestPort();
    const host = createLocalAgentHost({ ...overrides, port });
    try {
      await host.start();
      const address = host.address() ?? "";
      const parsedPort = Number(address.split(":").pop());
      return {
        host,
        port: Number.isSafeInteger(parsedPort) && parsedPort > 0 ? parsedPort : port,
        dispose: () => host.close(),
      };
    } catch (error) {
      lastError = error;
      await host.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("unable to start test host");
}
