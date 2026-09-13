import { describe, expect, it } from "vitest";
import {
  createSecureCredentialStore,
  MAX_CREDENTIAL_BYTES,
} from "../packages/provider-registry/src/index.js";

function makeBackend(): Record<string, unknown> {
  const secrets = new Map<string, string>();
  return {
    get: (ref: string) => secrets.get(ref),
    set: (ref: string, secret: string) => { secrets.set(ref, secret); },
    has: (ref: string) => secrets.has(ref),
    delete: (ref: string) => { secrets.delete(ref); },
  };
}

describe("task 26 credential store validation", () => {
  it("rejects null options", () => {
    expect(() =>
      createSecureCredentialStore(null as never),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects undefined options", () => {
    expect(() =>
      createSecureCredentialStore(undefined as never),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects array options", () => {
    expect(() =>
      createSecureCredentialStore([] as never),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects string options", () => {
    expect(() =>
      createSecureCredentialStore("nope" as never),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects null backend", () => {
    expect(() =>
      createSecureCredentialStore({ backend: null as never }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects array backend", () => {
    expect(() =>
      createSecureCredentialStore({ backend: [] as never }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects primitive backend", () => {
    expect(() =>
      createSecureCredentialStore({ backend: "string" as never }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects backend missing get", () => {
    expect(() =>
      createSecureCredentialStore({
        backend: { set: () => {}, has: () => false, delete: () => {} } as never,
      }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects backend missing set", () => {
    expect(() =>
      createSecureCredentialStore({
        backend: { get: () => undefined, has: () => false, delete: () => {} } as never,
      }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects backend with non-function get", () => {
    expect(() =>
      createSecureCredentialStore({
        backend: { get: 1, set: () => {}, has: () => false, delete: () => {} } as never,
      }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects backend with non-function set", () => {
    expect(() =>
      createSecureCredentialStore({
        backend: { get: () => undefined, set: {}, has: () => false, delete: () => {} } as never,
      }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects empty object as backend", () => {
    expect(() =>
      createSecureCredentialStore({ backend: {} as never }),
    ).toThrow(/credential store options are invalid/i);
  });

  it("rejects empty credentialRef", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.set("", "fixture-value")).rejects.toThrow(
      /credentialRef must be null or match/i,
    );
  });

  it("rejects whitespace credentialRef", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.set("  ", "fixture-value")).rejects.toThrow(
      /credentialRef must be null or match/i,
    );
  });

  it("rejects null credentialRef", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.set(null as never, "fixture-value")).rejects.toThrow(
      /credentialRef must be null or match/i,
    );
  });

  it("rejects non-string credentialRef", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.set(123 as never, "fixture-value")).rejects.toThrow(
      /credentialRef must be null or match/i,
    );
  });

  it("rejects credentialRef with newline", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(
      store.set("credential:test\nprovider", "fixture-value"),
    ).rejects.toThrow(/credentialRef must be null or match/i);
  });

  it("rejects credentialRef with path traversal", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(
      store.set("credential:../../etc/passwd", "fixture-value"),
    ).rejects.toThrow(/credentialRef must be null or match/i);
  });

  it("rejects credentialRef with URL scheme", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(
      store.set("https://evil.example.com", "fixture-value"),
    ).rejects.toThrow(/credentialRef must be null or match/i);
  });

  it("rejects empty secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.set("credential:test-provider", "")).rejects.toThrow(
      /credential value is invalid/i,
    );
  });

  it("rejects whitespace-only secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.set("credential:test-provider", "   ")).rejects.toThrow(
      /credential value is invalid/i,
    );
  });

  it("rejects secret with NUL byte", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(
      store.set("credential:test-provider", "abc\u0000def"),
    ).rejects.toThrow(/credential value is invalid/i);
  });

  it("rejects oversized secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    const huge = "x".repeat(MAX_CREDENTIAL_BYTES + 1);
    await expect(
      store.set("credential:test-provider", huge),
    ).rejects.toThrow(/credential value is invalid/i);
  });

  it("accepts a secret of exactly MAX_CREDENTIAL_BYTES", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    const exact = "x".repeat(MAX_CREDENTIAL_BYTES);
    await expect(
      store.set("credential:test-provider", exact),
    ).resolves.toBeUndefined();
  });

  it("rejects non-string secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(
      store.set("credential:test-provider", 123 as never),
    ).rejects.toThrow(/credential value is invalid/i);
  });
});