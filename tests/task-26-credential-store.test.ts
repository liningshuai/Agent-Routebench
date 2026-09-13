import { describe, expect, it } from "vitest";
import {
  createSecureCredentialStore,
  InMemoryCredentialStore,
  UnavailableCredentialStore,
  MAX_CREDENTIAL_BYTES,
} from "../packages/provider-registry/src/index.js";

function makeBackend(
  overrides: {
    get?: (ref: string) => string | undefined | Promise<string | undefined>;
    set?: (ref: string, secret: string) => void | Promise<void>;
    has?: (ref: string) => boolean | Promise<boolean>;
    delete?: (ref: string) => void | Promise<void>;
  } = {},
): Record<string, unknown> {
  const secrets = new Map<string, string>();
  return {
    get: overrides.get ?? ((ref: string) => secrets.get(ref)),
    set: overrides.set ?? ((ref: string, secret: string) => { secrets.set(ref, secret); }),
    has: overrides.has ?? ((ref: string) => secrets.has(ref)),
    delete: overrides.delete ?? ((ref: string) => { secrets.delete(ref); }),
  };
}

describe("task 26 credential store basics", () => {
  it("accepts an object literal backend", async () => {
    const secrets = new Map<string, string>();
    const store = createSecureCredentialStore({
      backend: {
        get: (ref) => secrets.get(ref),
        set: (ref, secret) => { secrets.set(ref, secret); },
        has: (ref) => secrets.has(ref),
        delete: (ref) => { secrets.delete(ref); },
      },
    });
    await store.set("credential:test-provider", "fixture-value");
    expect(await store.get("credential:test-provider")).toBe("fixture-value");
    expect(await store.has("credential:test-provider")).toBe(true);
    await store.delete("credential:test-provider");
    expect(await store.get("credential:test-provider")).toBeUndefined();
  });

  it("accepts a null-prototype backend", async () => {
    const backend = Object.assign(Object.create(null) as Record<string, unknown>, {
      get: () => "fixture-value",
      set: () => undefined,
      has: () => true,
      delete: () => undefined,
    });
    const store = createSecureCredentialStore({ backend: backend as never });
    expect(await store.get("credential:test-provider")).toBe("fixture-value");
  });

  it("accepts a class-instance backend", async () => {
    class TestBackend {
      get(): string | undefined { return "fixture-value"; }
      set(): void {}
      has(): boolean { return true; }
      delete(): void {}
    }
    const store = createSecureCredentialStore({ backend: new TestBackend() });
    expect(await store.get("credential:test-provider")).toBe("fixture-value");
  });

  it("accepts prototype methods on a class", async () => {
    class ProtoBackend {
      get(): string { return "proto-value"; }
      set(): void {}
      has(): boolean { return true; }
      delete(): void {}
    }
    const store = createSecureCredentialStore({ backend: new ProtoBackend() });
    expect(await store.get("credential:test-provider")).toBe("proto-value");
  });

  it("set then get returns the secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "fixture-value");
    expect(await store.get("credential:test-provider")).toBe("fixture-value");
  });

  it("set then delete then get returns undefined", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "fixture-value");
    await store.delete("credential:test-provider");
    expect(await store.get("credential:test-provider")).toBeUndefined();
  });

  it("set overwrites an existing secret", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "first-value");
    await store.set("credential:test-provider", "second-value");
    expect(await store.get("credential:test-provider")).toBe("second-value");
  });

  it("has returns boolean", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    expect(await store.has("credential:test-provider")).toBe(false);
    await store.set("credential:test-provider", "fixture-value");
    expect(await store.has("credential:test-provider")).toBe(true);
  });

  it("delete of a missing ref is stable", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await expect(store.delete("credential:test-provider")).resolves.toBeUndefined();
  });

  it("different refs are isolated", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:a", "value-a");
    await store.set("credential:b", "value-b");
    expect(await store.get("credential:a")).toBe("value-a");
    expect(await store.get("credential:b")).toBe("value-b");
  });

  it("two store instances do not share state", async () => {
    const storeA = createSecureCredentialStore({ backend: makeBackend() as never });
    const storeB = createSecureCredentialStore({ backend: makeBackend() as never });
    await storeA.set("credential:a", "value-a");
    expect(await storeB.get("credential:a")).toBeUndefined();
  });

  it("UnavailableCredentialStore is fail-closed", async () => {
    const store = new UnavailableCredentialStore();
    expect(await store.get()).toBeUndefined();
    expect(await store.has()).toBe(false);
    await expect(store.set()).resolves.toBeUndefined();
    await expect(store.delete()).resolves.toBeUndefined();
  });

  it("exports MAX_CREDENTIAL_BYTES", () => {
    expect(MAX_CREDENTIAL_BYTES).toBe(16 * 1024);
  });

  it("InMemoryCredentialStore still works", async () => {
    const store = new InMemoryCredentialStore();
    await store.set("credential:test-provider", "fixture-value");
    expect(await store.get("credential:test-provider")).toBe("fixture-value");
  });
});
