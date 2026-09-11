export interface CliError extends Error {
  readonly code: string;
}

export const CLI_ERROR_CODES = Object.freeze({
  invalidArguments: "invalid_arguments",
  invalidBaseUrl: "invalid_base_url",
  apiUnavailable: "api_unavailable",
  apiHttpError: "api_http_error",
  apiProtocolError: "api_protocol_error",
  streamTooLarge: "stream_too_large",
  aborted: "aborted",
} as const);

export type CliErrorCodeKey = keyof typeof CLI_ERROR_CODES;

const CLI_ERROR_MESSAGES = Object.freeze({
  invalidArguments: "CLI arguments are invalid.",
  invalidBaseUrl: "Local API URL is invalid.",
  apiUnavailable: "Local Agent API is unavailable.",
  apiHttpError: "Local Agent API request failed.",
  apiProtocolError: "Local Agent API returned invalid data.",
  streamTooLarge: "Local Agent API response is too large.",
  aborted: "Operation aborted.",
} as const);

export function createCliError(key: CliErrorCodeKey): CliError {
  const error = new Error(CLI_ERROR_MESSAGES[key]) as CliError;
  (error as { code: string }).code = CLI_ERROR_CODES[key];
  error.name = "CliError";
  return error;
}

export function failCli(key: CliErrorCodeKey): never {
  throw createCliError(key);
}
