import type {
  LocalAgentHost as LoopbackHost,
  LocalAgentRunner,
} from "@agent-workbench/local-agent-api";

/** Observable lifecycle state of a Local Agent host instance. */
export type LocalAgentHostState =
  | "created"
  | "starting"
  | "running"
  | "closing"
  | "closed";

/**
 * Options for creating a Local Agent host. `host` is restricted to the two
 * loopback names; anything else is rejected before a listener is created.
 */
export interface LocalAgentHostOptions {
  readonly host?: LoopbackHost;
  readonly port: number;
  readonly runner?: LocalAgentRunner;
}

/** A started-or-startable loopback Local Agent API host instance. */
export interface LocalAgentHost {
  /** Starts the loopback listener exactly once per successfully closed host. */
  start(): Promise<void>;
  /** Idempotently stops the listener; never throws on an unstarted host. */
  close(): Promise<void>;
  /** The loopback base URL while running; undefined before and after. */
  address(): string | undefined;
  /** The current lifecycle state. */
  state(): LocalAgentHostState;
}

/** Options for the Node entry point; all injectable for testing. */
export interface LocalAgentHostMainOptions {
  /** CLI arguments; defaults to process.argv.slice(2). */
  readonly argv?: readonly string[];
  /**
   * Signal registration hook; defaults to process.on. Inject a recorder in
   * tests so no real signal ever terminates the vitest process.
   */
  readonly registerSignal?: (name: "SIGINT" | "SIGTERM", handler: () => void) => void;
  /** Log sink for the single fixed failure line. */
  readonly log?: (line: string) => void;
}
