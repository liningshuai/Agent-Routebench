import type { AgentEvent } from "@agent-workbench/agent-core";
import { createAgentBackendRunner } from "@agent-workbench/agent-backend";
import {
  createLocalAgentApiServer,
  type LocalAgentApiServer,
  type LocalAgentRunner,
  type LocalAgentRunnerRequest,
} from "@agent-workbench/local-agent-api";

import { LocalAgentHostError } from "./errors.js";
import type {
  LocalAgentHost,
  LocalAgentHostOptions,
  LocalAgentHostState,
  RunnableLocalAgentHostOptions,
} from "./types.js";
import { validateHostOptions, validateRunnableHostOptions } from "./validation.js";

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
          const created = createLocalAgentApiServer({
            host: listenHost,
            port,
            runner,
            ...(options.store !== undefined ? { store: options.store } : {}),
            ...(options.maxBodyBytes !== undefined
              ? { maxBodyBytes: options.maxBodyBytes }
              : {}),
          });
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

/**
 * Explicit composition of the runnable Agent Backend (Task 21) into the
 * loopback host (Task 20):
 *
 * ```text
 * backend options → createAgentBackendRunner() → createLocalAgentHost()
 * ```
 *
 * The composition performs no implicit configuration: no environment reads,
 * no provider presets, no routes, no credentials, no route or model
 * selection. Invalid backend options fail synchronously, before any
 * listener exists. Without this explicit composition the plain
 * `createLocalAgentHost()` keeps its safe `NotReadyLocalAgentRunner`
 * default.
 */
export function createRunnableLocalAgentHost(
  options: RunnableLocalAgentHostOptions,
): LocalAgentHost {
  validateRunnableHostOptions(options);
  const runner = createAgentBackendRunner(options.backend);
  return createLocalAgentHost({
    ...(options.host !== undefined ? { host: options.host } : {}),
    port: options.port,
    runner,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.maxBodyBytes !== undefined
      ? { maxBodyBytes: options.maxBodyBytes }
      : {}),
  });
}
