/**
 * Stable, machine-readable error codes for local config persistence.
 *
 * Callers must branch on `code`. Messages are fixed and never echo file
 * paths, JSON contents, provider ids, route ids, URLs, secrets or raw
 * filesystem errors.
 */
export const PERSISTENCE_ERROR_CODES = Object.freeze({
  invalidPersistedConfig: "invalid_persisted_config",
  unsupportedConfigVersion: "unsupported_config_version",
  invalidPersistedProvider: "invalid_persisted_provider",
  invalidPersistedRoute: "invalid_persisted_route",
  duplicatePersistedProvider: "duplicate_persisted_provider",
  duplicatePersistedRoute: "duplicate_persisted_route",
  persistedProviderNotFound: "persisted_provider_not_found",
  persistedModelNotAvailable: "persisted_model_not_available",
  forbiddenPersistedField: "persisted_forbidden_field",
  configFileNotFound: "config_file_not_found",
  configFileInvalid: "config_file_invalid",
  configFileWriteFailed: "config_file_write_failed",
  configFileReplaceFailed: "config_file_replace_failed",
  invalidConfigFilePath: "invalid_config_file_path",
} as const);

export type PersistenceErrorCodeKey = keyof typeof PERSISTENCE_ERROR_CODES;

const ERROR_MESSAGES = Object.freeze({
  invalidPersistedConfig: "The persisted configuration is invalid.",
  unsupportedConfigVersion: "The persisted configuration version is unsupported.",
  invalidPersistedProvider: "A persisted provider definition is invalid.",
  invalidPersistedRoute: "A persisted route definition is invalid.",
  duplicatePersistedProvider: "A persisted provider id is duplicated.",
  duplicatePersistedRoute: "A persisted route id is duplicated.",
  persistedProviderNotFound: "A persisted route references an unknown provider.",
  persistedModelNotAvailable:
    "A persisted route model is not available on the referenced provider.",
  forbiddenPersistedField:
    "The persisted configuration contains a field that is not allowed.",
  configFileNotFound: "The configuration file was not found.",
  configFileInvalid: "The configuration file could not be read.",
  configFileWriteFailed: "The configuration file could not be written.",
  configFileReplaceFailed:
    "The configuration file could not be replaced atomically.",
  invalidConfigFilePath: "The configuration file path is invalid.",
} as const);

export class PersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export function persistenceError(
  key: PersistenceErrorCodeKey,
): PersistenceError {
  return new PersistenceError(
    PERSISTENCE_ERROR_CODES[key],
    ERROR_MESSAGES[key],
  );
}

export function fail(key: PersistenceErrorCodeKey): never {
  throw persistenceError(key);
}
