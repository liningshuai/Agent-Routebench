import type { AgentEvent } from "@agent-workbench/agent-core";
import {
  createLocalAgentApiServer,
  type LocalAgentApiServer,
  type LocalAgentRunner,
  type LocalAgentRunnerRequest,
} from "@agent-workbench/local-agent-api";

import { LocalAgentHostError } from "./errors.js";
import type { LocalAgentHost, LocalAgentHostOptions, LocalAgentHostState } from "./types.js";
import { validateHostOptions } from "./validation.js";

/**
 * The production default runner. The Agent backend has not been assembled
 * yet, so this runner never produces a session payload, model text, tool
 * calls, usage or a completed event; it throws the fixed not-ready error and
 * the existing Task 9 server converts it into the fixed `runner_error`
 * event. Nothing internal is revealed.
 */
export class NotReadyLocalAgentRunner implements LocalAgentRunner {
  async run(_request: LocalAgentRunnerRequest): Promise<AsyncIterable<AgentEvent>> {
    throw new LocalAgentHostError("runner_not_ready");
  }
}

/**
 * Creates a loopback-only Local Agent host around the existing
 * `createLocalAgentApiServer`. The host validates its options, injects the
 * runner (defaulting to the not-ready runner) and owns the lifecycle:
 * created → starting → running → closing → closed. Each host instance owns
 * its own server; no state is shared between instances.
 */
export function createLocalAgentHost(options: LocalAgentHostOptions): LocalAgentHost {
  validateHostOptions(options);
  const runner: LocalAgentRunner = options.runner ?? new NotReadyLocalAgentRunner();
  const listenHost = options.host ?? "127.0.0.1";
  const port = options.port;

  let state: LocalAgentHostState = "created";
  let server: LocalAgentApiServer | undefined;
  let startPromise: Promise<void> | undefined;

  return {
    start(): Promise<void> {
      if (state !== "created") {
        return Promise.reject(new LocalAgentHostError("already_started"));
      }
      state = "starting";
      startPromise = (async () => {
        try {
          const created = createLocalAgentApiServer({ host: listenHost, port, runner });
          await created.start();
          server = created;
          state = "running";
        } catch {
          server = undefined;
          state = "created";
          throw new LocalAgentHostError("start_failed");
        }
      })();
      return startPromise;
    },

    async close(): Promise<void> {
      if (state === "starting" && startPromise !== undefined) {
        await startPromise.catch(() => undefined);
      }
      if (state === "closed") {
        return;
      }
      const current = server;
      server = undefined;
      if (current !== undefined) {
        state = "closing";
        try {
          await current.close();
        } catch {
          state = "closed";
          throw new LocalAgentHostError("close_failed");
        }
      }
      state = "closed";
    },

    address(): string | undefined {
      if (state === "closing" || state === "closed") {
        return undefined;
      }
      return server?.address();
    },

    state(): LocalAgentHostState {
      return state;
    },
  };
}
