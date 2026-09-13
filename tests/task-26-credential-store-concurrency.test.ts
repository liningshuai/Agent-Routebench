import { describe, expect, it } from "vitest";
import { createSecureCredentialStore } from "../packages/provider-registry/src/index.js";

function makeBackend(
  overrides: Partial<{
    get: (ref: string) => string | undefined;
    set: (ref: string, secret: string) => void;
    has: (ref: string) => boolean;
    delete: (ref: string) => void;
  }> = {},
): Record<string, unknown> {
  const secrets = new Map<string, string>();
  return {
    get: overrides.get ?? ((ref: string) => secrets.get(ref)),
    set: overrides.set ?? ((ref: string, secret: string) => { secrets.set(ref, secret); }),
    has: overrides.has ?? ((ref: string) => secrets.has(ref)),
    delete: overrides.delete ?? ((ref: string) => { secrets.delete(ref); }),
  };
}

describe("task 26 credential store concurrency", () => {
  it("set then get is ordered", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "value-a");
    expect(await store.get("credential:test-provider")).toBe("value-a");
  });

  it("set then delete then get returns undefined", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "value-a");
    await store.delete("credential:test-provider");
    expect(await store.get("credential:test-provider")).toBeUndefined();
  });

  it("different refs do not interfere", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await Promise.all([
      store.set("credential:a", "value-a"),
      store.set("credential:b", "value-b"),
      store.set("credential:c", "value-c"),
    ]);
    expect(await store.get("credential:a")).toBe("value-a");
    expect(await store.get("credential:b")).toBe("value-b");
    expect(await store.get("credential:c")).toBe("value-c");
  });

  it("two stores on the same backend share state only through the backend", async () => {
    const backend = makeBackend();
    const storeA = createSecureCredentialStore({ backend: backend as never });
    const storeB = createSecureCredentialStore({ backend: backend as never });
    await storeA.set("credential:a", "value-a");
    expect(await storeB.get("credential:a")).toBe("value-a");
  });

  it("two stores on different backends are isolated", async () => {
    const storeA = createSecureCredentialStore({ backend: makeBackend() as never });
    const storeB = createSecureCredentialStore({ backend: makeBackend() as never });
    await storeA.set("credential:a", "value-a");
    expect(await storeB.get("credential:a")).toBeUndefined();
  });

  it("concurrent gets on the same ref return consistent values", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await store.set("credential:test-provider", "stable-value");
    const results = await Promise.all([
      store.get("credential:test-provider"),
      store.get("credential:test-provider"),
      store.get("credential:test-provider"),
    ]);
    for (const r of results) {
      expect(r).toBe("stable-value");
    }
  });

  it("concurrent set and get on different refs do not interfere", async () => {
    const store = createSecureCredentialStore({ backend: makeBackend() as never });
    await Promise.all([
      store.set("credential:a", "value-a"),
      store.get("credential:b"),
    ]);
    expect(await store.get("credential:a")).toBe("value-a");
  });
});