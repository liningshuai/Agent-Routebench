export const DESKTOP_ERROR_CODES = {
  NOT_CONNECTED: "not_connected",
  CONNECTION_FAILED: "connection_failed",
  SESSION_NOT_FOUND: "session_not_found",
  TURN_FAILED: "turn_failed",
  CANCEL_FAILED: "cancel_failed",
} as const;

export const DESKTOP_ERROR_MESSAGES = {
  NOT_CONNECTED: "Not connected to Local Agent API.",
  CONNECTION_FAILED: "Failed to connect to Local Agent API.",
  SESSION_NOT_FOUND: "Session not found.",
  TURN_FAILED: "Failed to submit turn.",
  CANCEL_FAILED: "Failed to cancel turn.",
} as const;

export class DesktopError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopError";
    this.code = code;
  }
}

export function createDesktopError(
  code: keyof typeof DESKTOP_ERROR_CODES,
): DesktopError {
  return new DesktopError(
    DESKTOP_ERROR_CODES[code],
    DESKTOP_ERROR_MESSAGES[code],
  );
}
