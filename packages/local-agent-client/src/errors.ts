export const LOCAL_AGENT_CLIENT_ERROR_CODES = Object.freeze({
  invalidArguments: "invalid_arguments",
  invalidBaseUrl: "invalid_base_url",
  apiUnavailable: "api_unavailable",
  apiHttpError: "api_http_error",
  apiProtocolError: "api_protocol_error",
  streamTooLarge: "stream_too_large",
  aborted: "aborted",
} as const);

export type LocalAgentClientErrorCode =
  (typeof LOCAL_AGENT_CLIENT_ERROR_CODES)[keyof typeof LOCAL_AGENT_CLIENT_ERROR_CODES];

const LOCAL_AGENT_CLIENT_ERROR_MESSAGES = Object.freeze({
  invalidArguments: "Local Agent client arguments are invalid.",
  invalidBaseUrl: "Local API URL is invalid.",
  apiUnavailable: "Local Agent API is unavailable.",
  apiHttpError: "Local Agent API request failed.",
  apiProtocolError: "Local Agent API returned invalid data.",
  streamTooLarge: "Local Agent API response is too large.",
  aborted: "Operation aborted.",
} as const);

type ErrorKey = keyof typeof LOCAL_AGENT_CLIENT_ERROR_CODES;

export class LocalAgentClientError extends Error {
  readonly code: LocalAgentClientErrorCode;

  constructor(key: ErrorKey) {
    super(LOCAL_AGENT_CLIENT_ERROR_MESSAGES[key]);
    this.name = "LocalAgentClientError";
    this.code = LOCAL_AGENT_CLIENT_ERROR_CODES[key];
  }
}

export function failLocalAgentClient(key: ErrorKey): never {
  throw new LocalAgentClientError(key);
}
