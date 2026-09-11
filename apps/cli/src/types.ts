export type CommandType =
  | "help"
  | "version"
  | "health"
  | "session-create"
  | "session-show"
  | "session-events"
  | "run"
  | "cancel";

export interface ParsedArgs {
  readonly command: CommandType;
  readonly sessionId?: string;
  readonly message?: string;
  readonly routeId?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly baseUrl: string;
  readonly json: boolean;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:4317";
