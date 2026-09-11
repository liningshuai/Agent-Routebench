import { describe, expect, it } from "vitest";
import {
  createProviderDiscovery,
  type DiscoveryHttpResponse,
} from "../packages/provider-discovery/src/index.js";
import {
  anthropicModelsBody,
  bodyFromText,
  fakeHttpClient,
  makeAnthropicProvider,
  makeCredentialStore,
  makeRegistry,
} from "./helpers/provider-discovery-fixtures.js";

function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // intentionally pending
  });
}

async function baseDiscovery(
  respond: Parameters<typeof fakeHttpClient>[0],
) {
  const registry = await makeRegistry([makeAnthropicProvider()]);
  const credentialStore = await makeCredentialStore();
  const { client, calls } = fakeHttpClient(respond);
  const discovery = createProviderDiscovery({
    registry,
    credentialStore,
    httpClient: client,
  });
  return { discovery, calls, credentialStore };
}

describe("task 10 cancellation", () => {
  it("rejects a pre-aborted signal before credential lookup", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    let getCalls = 0;
    const credentialStore = {
      async get() {
        getCalls += 1;
        return "fixture-credential-value";
      },
      async set() {
        throw new Error("unexpected set");
      },
      async has() {
        return true;
      },
      async delete() {
        throw new Error("unexpected delete");
      },
    };
    const { client, calls } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      discovery.checkProvider("anthropic-main", controller.signal),
    ).resolves.toMatchObject({ status: "aborted" });
    await expect(
      discovery.listModels("anthropic-main", controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(getCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("passes the AbortSignal to the HttpClient", async () => {
    const { discovery } = await baseDiscovery(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient((request) => {
      seen = request.signal;
      return { status: 200, body: bodyFromText(anthropicModelsBody()) };
    });
    const withSignal = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    void discovery;
    await withSignal.checkProvider("anthropic-main", controller.signal);
    expect(seen).toBe(controller.signal);
  });

  it("aborts while the HTTP promise is pending", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let rejectHttp: ((error: unknown) => void) | undefined;
    const client = () =>
      new Promise<DiscoveryHttpResponse>((_resolve, reject) => {
        rejectHttp = reject;
      });
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const controller = new AbortController();
    const pending = discovery.checkProvider(
      "anthropic-main",
      controller.signal,
    );
    controller.abort();
    rejectHttp?.(new Error("late"));
    await expect(pending).resolves.toMatchObject({ status: "aborted" });
  });

  it("does not produce unhandled rejections when HTTP settles late", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const registry = await makeRegistry([makeAnthropicProvider()]);
      const credentialStore = await makeCredentialStore();
      let rejectHttp: ((error: unknown) => void) | undefined;
      const client = () =>
        new Promise<DiscoveryHttpResponse>((_resolve, reject) => {
          rejectHttp = reject;
        });
      const discovery = createProviderDiscovery({
        registry,
        credentialStore,
        httpClient: client,
      });
      const controller = new AbortController();
      const pending = discovery.checkProvider(
        "anthropic-main",
        controller.signal,
      );
      controller.abort();
      await pending;
      rejectHttp?.(new Error("late transport failure"));
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("aborts while reading the response body", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const full = encoder.encode(anthropicModelsBody());
    const first = full.slice(0, 10);
    const client = () =>
      Promise.resolve({
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield first;
            await new Promise<void>((resolve) => {
              controller.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            throw new Error("body aborted");
          },
        },
      });
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const pending = discovery.listModels("anthropic-main", controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("does not return a catalog after cancel", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const controller = new AbortController();
    controller.abort();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    await expect(
      discovery.listModels("anthropic-main", controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("cancelling one call does not affect another", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let mode: "hang" | "ok" = "hang";
    let resume: (() => void) | undefined;
    const client = () =>
      new Promise<DiscoveryHttpResponse>((resolve) => {
        if (mode === "ok") {
          resolve({ status: 200, body: bodyFromText(anthropicModelsBody()) });
          return;
        }
        resume = () =>
          resolve({ status: 200, body: bodyFromText(anthropicModelsBody()) });
      });
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const cancelled = new AbortController();
    const hanging = discovery.checkProvider(
      "anthropic-main",
      cancelled.signal,
    );
    cancelled.abort();
    mode = "ok";
    resume?.();
    const [first, second] = await Promise.all([
      hanging,
      discovery.checkProvider("anthropic-main"),
    ]);
    expect(first.status).toBe("aborted");
    expect(second.status).toBe("healthy");
  });

  it("ignores a late successful HTTP response after cancel", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let resolveHttp: ((value: DiscoveryHttpResponse) => void) | undefined;
    const client = () =>
      new Promise<DiscoveryHttpResponse>((resolve) => {
        resolveHttp = resolve;
      });
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const controller = new AbortController();
    const pending = discovery.listModels("anthropic-main", controller.signal);
    controller.abort();
    resolveHttp?.({ status: 200, body: bodyFromText(anthropicModelsBody()) });
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("maps cancel during health check to aborted status", async () => {
    const { discovery } = await baseDiscovery(() => never());
    const controller = new AbortController();
    const pending = discovery.checkProvider(
      "anthropic-main",
      controller.signal,
    );
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "aborted" });
  });
});

describe("task 10 hanging HTTP cancellation", () => {
  it("aborts listModels while the HTTP Promise never settles", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let httpCalls = 0;
    let httpStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      httpStarted = resolve;
    });
    // HTTP Promise intentionally never settles; production must race abort.
    const client = () => {
      httpCalls += 1;
      httpStarted();
      return new Promise<DiscoveryHttpResponse>(() => {
        // pending forever
      });
    };
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const controller = new AbortController();
    const pending = discovery.listModels(
      "anthropic-main",
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for abort")), 1500),
        ),
      ]),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(httpCalls).toBe(1);
  });

  it("aborts checkProvider while the HTTP Promise never settles", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let httpStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      httpStarted = resolve;
    });
    const client = () => {
      httpStarted();
      return new Promise<DiscoveryHttpResponse>(() => {
        // pending forever
      });
    };
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const controller = new AbortController();
    const pending = discovery.checkProvider(
      "anthropic-main",
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for abort")), 1500),
        ),
      ]),
    ).resolves.toMatchObject({ status: "aborted" });
  });

  it("releases a late HTTP response body after abort", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let httpStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      httpStarted = resolve;
    });
    let resolveHttp: ((value: DiscoveryHttpResponse) => void) | undefined;
    const client = () => {
      httpStarted();
      return new Promise<DiscoveryHttpResponse>((resolve) => {
        resolveHttp = resolve;
      });
    };
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const controller = new AbortController();
    const pending = discovery.listModels("anthropic-main", controller.signal);
    await started;
    controller.abort();
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out")), 1500),
        ),
      ]),
    ).rejects.toMatchObject({ code: "aborted" });

    let released = false;
    const chunks = [new TextEncoder().encode(anthropicModelsBody())];
    let index = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index < chunks.length) {
              const value = chunks[index];
              index += 1;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
          async return() {
            released = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    resolveHttp?.({ status: 200, body });
    await new Promise((r) => setTimeout(r, 30));
    expect(released).toBe(true);
  });

  it("does not produce unhandled rejections when a hung HTTP Promise rejects late", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const registry = await makeRegistry([makeAnthropicProvider()]);
      const credentialStore = await makeCredentialStore();
      let httpStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        httpStarted = resolve;
      });
      let rejectHttp: ((error: unknown) => void) | undefined;
      const client = () => {
        httpStarted();
        return new Promise<DiscoveryHttpResponse>((_resolve, reject) => {
          rejectHttp = reject;
        });
      };
      const discovery = createProviderDiscovery({
        registry,
        credentialStore,
        httpClient: client,
      });
      const controller = new AbortController();
      const pending = discovery.listModels("anthropic-main", controller.signal);
      await started;
      controller.abort();
      await expect(
        Promise.race([
          pending,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), 1500),
          ),
        ]),
      ).rejects.toMatchObject({ code: "aborted" });
      rejectHttp?.(new Error("late transport failure"));
      await new Promise((r) => setTimeout(r, 30));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps concurrent hanging and healthy calls isolated", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    let hangStarted!: () => void;
    const hangGate = new Promise<void>((resolve) => {
      hangStarted = resolve;
    });
    let call = 0;
    const client = () => {
      call += 1;
      if (call === 1) {
        hangStarted();
        return new Promise<DiscoveryHttpResponse>(() => {
          // pending forever
        });
      }
      return Promise.resolve({
        status: 200,
        body: bodyFromText(anthropicModelsBody()),
      });
    };
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const cancelled = new AbortController();
    const hanging = discovery.checkProvider(
      "anthropic-main",
      cancelled.signal,
    );
    await hangGate;
    cancelled.abort();
    const healthy = discovery.checkProvider("anthropic-main");
    const [first, second] = await Promise.all([
      Promise.race([
        hanging,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out")), 1500),
        ),
      ]),
      healthy,
    ]);
    expect(first).toMatchObject({ status: "aborted" });
    expect(second).toMatchObject({ status: "healthy" });
  });
});
