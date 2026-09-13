import { fail } from "./errors.js";
import { CREDENTIAL_REF_PATTERN, isValidCredentialRef } from "./types.js";

/**
 * An opaque pointer to a secret.
 *
 * A credential reference is NOT the secret. It is a stable name such as
 * `credential:anthropic-main` that the credential store uses to look up the
 * value. References are safe to store in provider/route definitions and safe to
 * show in logs; the value they point at is not.
 */
export type CredentialRef = string;

export interface CredentialStore {
  set(ref: CredentialRef, secret: string): Promise<void>;
  get(ref: CredentialRef): Promise<string | undefined>;
  has(ref: CredentialRef): Promise<boolean>;
  delete(ref: CredentialRef): Promise<void>;
}

/** Maximum secret length in bytes (UTF-8). */
export const MAX_CREDENTIAL_BYTES = 16 * 1024;

/**
 * A pluggable credential backend. Methods may be sync or async.
 * This is the adapter boundary for future OS Keychain / platform stores.
 */
export interface CredentialBackend {
  get(ref: string): string | undefined | Promise<string | undefined>;
  set(ref: string, secret: string): void | Promise<void>;
  has(ref: string): boolean | Promise<boolean>;
  delete(ref: string): void | Promise<void>;
}

export interface CredentialStoreOptions {
  readonly backend: CredentialBackend;
}

function hasRefShape(ref: unknown): ref is string {
  return typeof ref === "string" && CREDENTIAL_REF_PATTERN.test(ref);
}

function assertCredentialRef(ref: unknown): asserts ref is string {
  if (!isValidCredentialRef(ref)) {
    fail("invalidCredentialRef");
  }
}

function assertCredentialValue(secret: unknown): asserts secret is string {
  if (typeof secret !== "string" || secret.length === 0) {
    fail("invalidCredentialValue");
  }
  if (secret.trim().length === 0) {
    fail("invalidCredentialValue");
  }
  if (Buffer.byteLength(secret, "utf8") > MAX_CREDENTIAL_BYTES) {
    fail("invalidCredentialValue");
  }
  // Reject NUL and most control characters (except common whitespace).
  for (const ch of secret) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t") {
      fail("invalidCredentialValue");
    }
  }
}

/**
 * Validates a backend object. Accepts object literals, null-prototype
 * objects and class instances. Rejects null, arrays, primitives and
 * objects without callable get/set/has/delete methods.
 */
export function assertCredentialBackend(
  value: unknown,
): asserts value is CredentialBackend {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalidCredentialStore");
  }
  const candidate = value as Record<string, unknown>;
  for (const name of ["get", "set", "has", "delete"] as const) {
    if (typeof candidate[name] !== "function") {
      fail("invalidCredentialStore");
    }
  }
}

/**
 * A fail-closed credential store wrapping an explicit backend.
 *
 * Every operation validates the credentialRef and secret before delegating.
 * Backend exceptions are collapsed to the fixed `credential_backend_failed`
 * error; raw exception text, paths, URLs and secrets never leak.
 */
class SecureCredentialStore implements CredentialStore {
  readonly #backend: CredentialBackend;

  constructor(backend: CredentialBackend) {
    this.#backend = backend;
  }

  async set(ref: CredentialRef, secret: string): Promise<void> {
    assertCredentialRef(ref);
    assertCredentialValue(secret);
    try {
      await this.#backend.set(ref, secret);
    } catch {
      fail("credentialBackendFailed");
    }
  }

  async get(ref: CredentialRef): Promise<string | undefined> {
    assertCredentialRef(ref);
    try {
      const value = await this.#backend.get(ref);
      if (value === undefined) {
        return undefined;
      }
      if (typeof value !== "string" || value.length === 0) {
        fail("credentialBackendFailed");
      }
      return value;
    } catch (error) {
      if (error instanceof Error && error.name === "ProviderRegistryError") {
        throw error;
      }
      fail("credentialBackendFailed");
    }
  }

  async has(ref: CredentialRef): Promise<boolean> {
    assertCredentialRef(ref);
    try {
      const value = await this.#backend.has(ref);
      return Boolean(value);
    } catch {
      fail("credentialBackendFailed");
    }
  }

  async delete(ref: CredentialRef): Promise<void> {
    assertCredentialRef(ref);
    try {
      await this.#backend.delete(ref);
    } catch {
      fail("credentialBackendFailed");
    }
  }
}

/**
 * Creates a secure credential store wrapping an explicit backend.
 * Fails closed: without a valid backend, no secret is ever available.
 */
export function createSecureCredentialStore(
  options: CredentialStoreOptions,
): CredentialStore {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    fail("invalidCredentialStore");
  }
  assertCredentialBackend(options.backend);
  return new SecureCredentialStore(options.backend);
}

/**
 * Fail-closed default CredentialStore. Always returns undefined; never
 * throws. This is NOT an OS Keychain implementation ¡ª it simply ensures
 * that without an explicit credential source, no secret is ever available.
 */
export class UnavailableCredentialStore implements CredentialStore {
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async set(): Promise<void> {
    // No-op: this store cannot hold secrets.
  }
  async has(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<void> {
    // No-op: this store cannot hold secrets.
  }
}

/**
 * Test-only, purely in-memory credential store for Task 2.
 *
 * This is deliberately NOT a production secret manager: it performs no
 * encryption and no file, database, environment or keychain persistence, and it
 * never calls the network. Secrets live in this JavaScript heap for the
 * lifetime of the process only, which is exactly the boundary Task 2 needs to
 * exercise.
 */
export class InMemoryCredentialStore implements CredentialStore {
  readonly #secrets = new Map<CredentialRef, string>();

  async set(ref: CredentialRef, secret: string): Promise<void> {
    if (!isValidCredentialRef(ref)) {
      fail("invalidCredentialRef");
    }
    if (typeof secret !== "string" || secret.length === 0) {
      fail("invalidCredentialValue");
    }
    this.#secrets.set(ref, secret);
  }

  async get(ref: CredentialRef): Promise<string | undefined> {
    if (!hasRefShape(ref)) {
      return undefined;
    }
    return this.#secrets.get(ref);
  }

  async has(ref: CredentialRef): Promise<boolean> {
    if (!hasRefShape(ref)) {
      return false;
    }
    return this.#secrets.has(ref);
  }

  async delete(ref: CredentialRef): Promise<void> {
    if (!hasRefShape(ref)) {
      return;
    }
    this.#secrets.delete(ref);
  }
}