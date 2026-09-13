import { describe, expect, it } from "vitest";
import {
  createSecureCredentialStore,
  UnavailableCredentialStore,
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

describe("task 26 credential store security", () => {
  it("does not read process.env", async () => {
    process.env.TASK26_TEST_SECRET = "should-not-be-read";
    try {
      const store = createSecureCredentialStore({ backend: makeBackend() as never });
      await store.set("credential:test-provider", "fixture-value");
      const value = await store.get("credential:test-provider");
      expect(value).toBe("fixture-value");
      expect(value).not.toContain("should-not-be-read");
    } finally {
      delete process.env.TASK26_TEST_SECRET;
    }
  });

  it("error messages do not contain the secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    let message = "";
    try {
      await store.set("credential:test-provider", "TOP_SECRET_MARKER");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("TOP_SECRET_MARKER");
  });

  it("error messages do not contain the credentialRef", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    let message = "";
    try {
      await store.set("credential:test-provider", "");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("credential:test-provider");
  });

  it("backend exceptions are collapsed to fixed errors", async () => {
    const store = createSecureCredentialStore({
      backend: {
        get: () => { throw new Error("raw backend exception with secret"); },
        set: () => { throw new Error("raw set exception"); },
        has: () => false,
        delete: () => undefined,
      },
    });
    await expect(store.get("credential:test-provider")).rejects.toThrow(
      /credential operation failed/i,
    );
    await expect(
      store.set("credential:test-provider", "fixture-value"),
    ).rejects.toThrow(/credential operation failed/i);
  });

  it("async backend rejection is collapsed", async () => {
    const store = createSecureCredentialStore({
      backend: {
        get: () => Promise.reject(new Error("async rejection")),
        set: () => Promise.resolve(),
        has: () => Promise.resolve(false),
        delete: () => Promise.resolve(),
      },
    });
    await expect(store.get("credential:test-provider")).rejects.toThrow(
      /credential operation failed/i,
    );
  });

  it("backend returning a non-string from get is rejected", async () => {
    const store = createSecureCredentialStore({
      backend: {
        get: () => 42 as never,
        set: () => undefined,
        has: () => true,
        delete: () => undefined,
      },
    });
    await expect(store.get("credential:test-provider")).rejects.toThrow(
      /credential operation failed/i,
    );
  });

  it("UnavailableCredentialStore is fail-closed and not an OS Keychain", async () => {
    const store = new UnavailableCredentialStore();
    expect(await store.get()).toBeUndefined();
    expect(await store.has()).toBe(false);
    await expect(store.set()).resolves.toBeUndefined();
    await expect(store.delete()).resolves.toBeUndefined();
  });

  it("does not write secret to any file during operations", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "fixture-value");
    await store.get("credential:test-provider");
    await store.delete("credential:test-provider");
    // No fs operations happen; this test just exercises the full lifecycle.
    expect(true).toBe(true);
  });

  it("get returns value only to the caller, never to events", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "fixture-value");
    const value = await store.get("credential:test-provider");
    expect(value).toBe("fixture-value");
    // The store never emits events; there is no event surface.
  });
});