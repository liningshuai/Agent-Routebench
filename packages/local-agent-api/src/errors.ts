/**
 * Stable, fixed messages for the Local Agent API.
 *
 * Messages never echo request bodies, file paths, URLs, credentials or
 * underlying exception text.
 */
export const API_ERRORS = Object.freeze({
  notFound: {
    code: "not_found",
    message: "Resource not found.",
  },
  methodNotAllowed: {
    code: "method_not_allowed",
    message: "HTTP method is not allowed.",
  },
  invalidJson: {
    code: "invalid_json",
    message: "Request body is not valid JSON.",
  },
  invalidRequest: {
    code: "invalid_request",
    message: "Request is invalid.",
  },
  sessionNotFound: {
    code: "session_not_found",
    message: "Session not found.",
  },
  sessionBusy: {
    code: "session_busy",
    message: "Session is busy.",
  },
  payloadTooLarge: {
    code: "payload_too_large",
    message: "Request body is too large.",
  },
  invalidHost: {
    code: "invalid_host",
    message: "Only loopback hosts are allowed.",
  },
  serverError: {
    code: "server_error",
    message: "Internal server error.",
  },
} as const);

export function apiErrorPayload(
  key: keyof typeof API_ERRORS,
): { error: { code: string; message: string } } {
  const entry = API_ERRORS[key];
  return { error: { code: entry.code, message: entry.message } };
}
