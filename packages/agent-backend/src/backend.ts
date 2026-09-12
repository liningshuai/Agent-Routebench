import {
  createAgentLoop,
  createGovernedToolExecutor,
} from "@agent-workbench/agent-runtime";
import type { AgentEvent } from "@agent-workbench/agent-core";
import type { LocalAgentRunner, LocalAgentRunnerRequest } from "@agent-workbench/local-agent-api";
import { createResilientRoutedHttpModelGateway } from "@agent-workbench/model-gateway";
import type { ModelRequest } from "@agent-workbench/agent-contracts";

import { mapAgentLoopEvents } from "./events.js";
import { DEFAULT_BACKEND_MAX_TOKENS, toModelRequest } from "./request.js";
import type { AgentBackend, AgentBackendOptions } from "./types.js";
import { validateBackendOptions } from "./validation.js";

/**
 * Assembles the existing building blocks into a runnable `LocalAgentRunner`:
 *
 * ```text
 * ProviderRegistry + CredentialStore
 *   + (injected) HttpClient
 *   → ResilientRoutedHttpModelGateway   (retry / failover stay here)
 *   → AgentRuntime createAgentLoop      (multi-turn, tools, cancellation)
 *   → (optional) GovernedToolExecutor   (fail-closed policy / approval)
 *   → AgentLoopEvent → AgentEvent adapter
 *   → LocalAgentRunner
 * ```
 *
 * Construction is pure: the registry and credential store are stored by
 * reference, nothing is resolved and no HTTP happens until a turn runs.
 * The caller keeps full control — no presets, routes, credentials or models
 * are ever created implicitly, and the credential store is only read by the
 * gateway when a turn actually requests a route.
 */
export function createAgentBackend(options: AgentBackendOptions): AgentBackend {
  validateBackendOptions(options);

  const gateway = createResilientRoutedHttpModelGateway({
    registry: options.registry,
    credentials: options.credentials,
    ...(options.httpClient !== undefined ? { httpClient: options.httpClient } : {}),
    ...(options.retryPolicy !== undefined ? { retryPolicy: options.retryPolicy } : {}),
    ...(options.wait !== undefined ? { wait: options.wait } : {}),
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.maxToolInputBytes !== undefined
      ? { maxToolInputBytes: options.maxToolInputBytes }
      : {}),
  });

  const loop = createAgentLoop({
    gateway,
    // Without an explicit executor the runtime keeps its own fail-closed
    // semantics for unexpected tool calls. With one, the governed executor
    // enforces the policy/approval gate (fail-closed without a policy).
    ...(options.toolExecutor !== undefined
      ? {
          toolExecutor: createGovernedToolExecutor({
            executor: options.toolExecutor,
            ...(options.policy !== undefined ? { policy: options.policy } : {}),
            ...(options.approvalHandler !== undefined
              ? { approvalHandler: options.approvalHandler }
              : {}),
          }),
        }
      : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxToolCallsPerTurn !== undefined
      ? { maxToolCallsPerTurn: options.maxToolCallsPerTurn }
      : {}),
    ...(options.maxToolResultBytes !== undefined
      ? { maxToolResultBytes: options.maxToolResultBytes }
      : {}),
  });

  const defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_BACKEND_MAX_TOKENS;

  const runner: LocalAgentRunner = {
    async *run(request: LocalAgentRunnerRequest): AsyncIterable<AgentEvent> {
      const turnId = request.turnId;
      // Pre-cancelled turn: no route resolution, no credential read, no HTTP.
      if (request.signal?.aborted === true) {
        yield {
          type: "error",
          requestId: turnId,
          code: "aborted",
          message: "Turn aborted.",
          retryable: false,
        };
        return;
      }

      let modelRequest: ModelRequest;
      try {
        modelRequest = toModelRequest(request, defaultMaxTokens);
      } catch {
        yield {
          type: "error",
          requestId: turnId,
          code: "invalid_request",
          message: "Agent backend request is invalid.",
          retryable: false,
        };
        return;
      }

      yield* mapAgentLoopEvents(loop.run(modelRequest, request.signal), turnId);
    },
  };

  return { runner };
}

/**
 * Convenience form of {@link createAgentBackend} returning only the runner.
 */
export function createAgentBackendRunner(options: AgentBackendOptions): LocalAgentRunner {
  return createAgentBackend(options).runner;
}
