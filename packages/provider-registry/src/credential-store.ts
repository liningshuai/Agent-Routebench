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

function hasRefShape(ref: unknown): ref is string {
  return typeof ref === "string" && CREDENTIAL_REF_PATTERN.test(ref);
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
