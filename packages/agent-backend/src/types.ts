import type { ModelRequest } from "@agent-workbench/agent-contracts";
import type {
  ToolApprovalHandler,
  ToolExecutor,
  ToolPolicy,
} from "@agent-workbench/agent-runtime";
import type { LocalAgentRunner } from "@agent-workbench/local-agent-api";
import type {
  HttpClient,
  ResilientRoutedHttpModelGatewayOptions,
  RetryPolicy,
  RetryWait,
} from "@agent-workbench/model-gateway";

type GatewayOptions = ResilientRoutedHttpModelGatewayOptions;

/** The registry and credential-store shapes the gateway requires. */
export type BackendRegistry = GatewayOptions["registry"];
export type BackendCredentials = GatewayOptions["credentials"];

/**
 * Options of the backend assembly. `registry` and `credentials` are
 * mandatory; everything else is optional and forwarded to the existing
 * resilient gateway / agent runtime / governed tool executor.
 */
export interface AgentBackendOptions {
  readonly registry: BackendRegistry;
  readonly credentials: BackendCredentials;
  readonly httpClient?: HttpClient;

  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly wait?: RetryWait;

  readonly toolExecutor?: ToolExecutor;
  readonly policy?: ToolPolicy;
  readonly approvalHandler?: ToolApprovalHandler;

  readonly maxTurns?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly maxToolResultBytes?: number;

  /**
   * Used only when LocalAgentRunnerRequest.maxTokens is omitted.
   * Must be a positive safe integer.
   */
  readonly defaultMaxTokens?: number;

  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}

/** The assembled backend: a runnable LocalAgentRunner. */
export interface AgentBackend {
  readonly runner: LocalAgentRunner;
}

/** Re-exported shape used by the request converter. */
export type { ModelRequest };
