/**
 * Stable error codes for session persistence.
 *
 * Messages never echo file paths, keys, ciphertext, field values or stack.
 */
export const SESSION_PERSISTENCE_ERROR_CODES = Object.freeze({
  invalidOptions: "invalid_session_persistence_options",
  invalidFilePath: "invalid_session_file_path",
  invalidEvent: "invalid_session_event",
  invalidStatus: "invalid_session_status",
  sessionLimitExceeded: "session_limit_exceeded",
  eventLimitExceeded: "event_limit_exceeded",
  eventTooLarge: "event_too_large",
  fileInvalid: "session_file_invalid",
  fileWriteFailed: "session_file_write_failed",
  recoveryFailed: "session_recovery_failed",
} as const);

export type SessionPersistenceErrorCodeKey =
  keyof typeof SESSION_PERSISTENCE_ERROR_CODES;

const ERROR_MESSAGES = Object.freeze({
  invalidOptions: "Session persistence options are invalid.",
  invalidFilePath: "Session file path is invalid.",
  invalidEvent: "Session event is invalid.",
  invalidStatus: "Session status is invalid.",
  sessionLimitExceeded: "Session count limit exceeded.",
  eventLimitExceeded: "Session event count limit exceeded.",
  eventTooLarge: "Session event exceeds the size limit.",
  fileInvalid: "Session file is invalid.",
  fileWriteFailed: "Session file write failed.",
  recoveryFailed: "Session recovery failed.",
} as const);

export class SessionPersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionPersistenceError";
    this.code = code;
  }
}

export function sessionPersistenceError(
  key: SessionPersistenceErrorCodeKey,
): SessionPersistenceError {
  return new SessionPersistenceError(
    SESSION_PERSISTENCE_ERROR_CODES[key],
    ERROR_MESSAGES[key],
  );
}

export function failSession(key: SessionPersistenceErrorCodeKey): never {
  throw sessionPersistenceError(key);
}
