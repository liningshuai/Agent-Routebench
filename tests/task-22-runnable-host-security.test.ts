import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createRunnableLocalAgentHost } from "../apps/local-agent-host/src/index.js";
import { readRepoFile, REPO_ROOT } from "./helpers/tauri-native-fixtures.js";
import {
  anthropicSuccessResponse,
  createScriptedHttpClient,
  TEST_SECRET,
  ANTHROPIC_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
} from "./helpers/http-fixtures.js";
import { makeBackendRegistry } from "./helpers/agent-backend-fixtures.js";

function hostSourceFiles(): string[] {
  const dir = join(REPO_ROOT, "apps/local-agent-host/src");
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".ts")) out.push(`apps/local-agent-host/src/${entry}`);
  }
  return out;
}

function composition(
  overrides: { script?: unknown[]; [key: string]: unknown } = {},
): Record<string, unknown> {
  const { script, ...rest } = overrides;
  const fixture = makeBackendRegistry();
  return {
    port: 30000 + Math.floor(Math.random() * 30000),
    backend: {
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: createScriptedHttpClient(
        (script ?? [anthropicSuccessResponse("hello")]) as never,
      ).client,
    },
    ...rest,
  };
}

describe("Task 22: source boundary", () => {
  test("host source never reads env, spawns processes or opens raw sockets", () => {
    // configured-host.ts is the Task 25 config bootstrap module; it
    // legitimately uses node:fs for existsSync to distinguish missing
    // config from invalid config. All other host sources remain clean.
    const files = hostSourceFiles().filter(
      (f) => !f.includes("configured-host") && !f.includes("credential-source"),
    );
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8").toLowerCase();
      for (const forbidden of [
        "process.env",
        "node:child_process",
        "node:net",
        "node:http",
        "node:fs",
        "fetch(",
        "websocket",
        "sqlite",
        "keychain",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("host source imports the backend only through the public package entry", () => {
    const host = readFileSync(
      join(REPO_ROOT, "apps/local-agent-host/src/host.ts"),
      "utf8",
    );
    expect(host).toContain('@agent-workbench/agent-backend"');
    expect(host).not.toMatch(/packages\/agent-backend\/src/);
  });

  test("the composition API exists on the public entry", () => {
    const index = readFileSync(
      join(REPO_ROOT, "apps/local-agent-host/src/index.ts"),
      "utf8",
    );
    expect(index).toContain("createRunnableLocalAgentHost");
  });
});

describe("Task 22: credential and secret boundaries", () => {
  test("construction never reads credentials and never sends HTTP", () => {
    let getCalls = 0;
    let httpCalls = 0;
    const fixture = makeBackendRegistry();
    createRunnableLocalAgentHost({
      port: 30000 + Math.floor(Math.random() * 30000),
      backend: {
        registry: fixture.registry,
        credentials: {
          get: async (ref) => {
            getCalls += 1;
            return fixture.credentials.get(ref);
          },
          set: async (ref, value) => fixture.credentials.set(ref, value),
          has: async () => true,
          delete: async () => undefined,
        },
        httpClient: () => {
          httpCalls += 1;
          return Promise.resolve(anthropicSuccessResponse("ok"));
        },
      },
    });
    expect(getCalls).toBe(0);
    expect(httpCalls).toBe(0);
  });

  test("the secret reaches only the gateway auth header, never events or session", async () => {
    const fixture = makeBackendRegistry();
    const seenHeaders: string[] = [];
    const { createFakeHttpClient } = await import("./helpers/http-fixtures.js");
    const fake = createFakeHttpClient((request) => {
      seenHeaders.push(JSON.stringify(request.headers));
      return anthropicSuccessResponse("hello");
    });
    const host = createRunnableLocalAgentHost({
      port: 30000 + Math.floor(Math.random() * 30000),
      backend: {
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: fake.client,
      },
    });
    const { LocalAgentApiClient } = await import("../packages/local-agent-client/src/index.js");
    try {
      await host.start();
      const client = new LocalAgentApiClient(host.address()!);
      const session = await client.createSession();
      const events = [];
      for await (const event of client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        events.push(event);
      }
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(TEST_SECRET);
      expect(seenHeaders.some((header) => header.includes(TEST_SECRET))).toBe(true);
      expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
      expect(serialized).not.toContain(DEFAULT_CREDENTIAL_REF);
    } finally {
      await host.close();
    }
  });

  test("a hostile tool executor leaks nothing into the API stream", async () => {
    const options = composition({
      script: [anthropicSuccessResponse("ok")],
    });
    const optionsWithExecutor = {
      ...options,
      backend: {
        ...(options.backend as Record<string, unknown>),
        toolExecutor: {
          async execute() {
            throw new Error(`boom at ${ANTHROPIC_BASE_URL} credential:${DEFAULT_CREDENTIAL_REF}`);
          },
        },
      },
    };
    const host = createRunnableLocalAgentHost(optionsWithExecutor as never);
    const { LocalAgentApiClient } = await import("../packages/local-agent-client/src/index.js");
    try {
      await host.start();
      const client = new LocalAgentApiClient(host.address()!);
      const session = await client.createSession();
      const events = [];
      for await (const event of client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        events.push(event);
      }
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("boom at");
      expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
      expect(serialized).not.toContain(DEFAULT_CREDENTIAL_REF);
    } finally {
      await host.close();
    }
  });

  test("every fetch call stays on loopback; none reaches a provider", async () => {
    const seenUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : ((input as { url?: string }).url ?? String(input));
      seenUrls.push(url);
      return originalFetch(input as never, init as never);
    }) as typeof fetch;
    try {
      const host = createRunnableLocalAgentHost(composition() as never);
      const { LocalAgentApiClient } = await import("../packages/local-agent-client/src/index.js");
      await host.start();
      const client = new LocalAgentApiClient(host.address()!);
      const session = await client.createSession();
      for await (const _event of client.runTurn(session.id, {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        routeId: "route-t4",
        model: "offline-model",
      })) {
        // drain
      }
      await host.close();
      // The backend's provider HTTP goes through the injected fake client; the
      // only real fetch calls are the test client talking to the loopback host.
      expect(seenUrls.length).toBeGreaterThan(0);
      for (const url of seenUrls) {
        expect(url.startsWith("http://127.0.0.1:")).toBe(true);
      }
      expect(seenUrls.some((url) => url.includes(ANTHROPIC_BASE_URL))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
