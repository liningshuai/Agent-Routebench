import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { failSession } from "./errors.js";
import type { EncryptedEnvelope } from "./types.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return true;
}

export function assertEncryptionKey(key: unknown): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    failSession("invalidOptions");
  }
}

export function encryptJson(
  plaintext: string,
  key: Uint8Array,
): EncryptedEnvelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

export function assertEnvelope(input: unknown): asserts input is EncryptedEnvelope {
  if (!isPlainObject(input)) {
    failSession("fileInvalid");
  }
  const allowed = new Set([
    "version",
    "algorithm",
    "iv",
    "authTag",
    "ciphertext",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      failSession("fileInvalid");
    }
  }
  if (input.version !== 1) {
    failSession("fileInvalid");
  }
  if (input.algorithm !== ALGORITHM) {
    failSession("fileInvalid");
  }
  if (typeof input.iv !== "string" || input.iv.length === 0) {
    failSession("fileInvalid");
  }
  if (typeof input.authTag !== "string" || input.authTag.length === 0) {
    failSession("fileInvalid");
  }
  if (typeof input.ciphertext !== "string" || input.ciphertext.length === 0) {
    failSession("fileInvalid");
  }

  let iv: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(input.iv, "base64");
    tag = Buffer.from(input.authTag, "base64");
  } catch {
    failSession("fileInvalid");
  }
  if (iv.byteLength !== IV_BYTES) {
    failSession("fileInvalid");
  }
  if (tag.byteLength !== TAG_BYTES) {
    failSession("fileInvalid");
  }
}

export function decryptEnvelope(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
): string {
  assertEnvelope(envelope);
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    failSession("fileInvalid");
  }
}
