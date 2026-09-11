import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import { createAgentCore } from "../packages/agent-core/src/index.js";
import type { ModelRequest, ModelStreamEvent } from "../packages/agent-contracts/src/index.js";
import type { ModelGateway } from "../packages/model-gateway/src/index.js";
import { createResilientRoutedHttpModelGateway } from "../packages/model-gateway/src/index.js";
import {
  TASK5_FALLBACK_BASE_URL,
  TASK5_PRIMARY_BASE_URL,
  TASK5_SECRET_FALLBACK,
  TASK5_SECRET_PRIMARY,
  TASK5_SECRET_PROBE,
  anthropicSuccessResponse,
  createScriptedHttpClient,
  headerValue,
  makeRequest,
  openaiSuccessResponse,
  transportFailureResponse,
  twoProviderFixture,
  type CandidateRegistryFixture,
  type FakeHttpClient,
} from "./helpers/http-fixtures.js";
import { textOf } from "./helpers/adapter-fixtures.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = dirname(__dirname);

function listFiles(absoluteDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const full = join(absoluteDir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function readSources(relativeDir: string): { path: string; text: string }[] {
  return listFiles(join(root, relativeDir)).map((file) => ({
    path: relative(root, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));
}

const gatewaySources = readSources("packages/model-gateway/src");
const registrySources = readSources("packages/provider-registry/src");

afterEach(() => {
  vi.restoreAllMocks();
});

function requestFor(fixture: CandidateRegistryFixture): ModelRequest {
  return makeRequest({ requestId: "req-t5", routeId: fixture.routeId, model: fixture.model });
}

function build(fixture: CandidateRegistryFixture, http: FakeHttpClient): ModelGateway {
  return createResilientRoutedHttpModelGateway({
    registry: fixture.registry,
    credentials: fixture.credentials,
    httpClient: http.client,
    retryPolicy: { initialBackoffMs: 10, maxBackoffMs: 40 },
  });
}

async function run(gateway: ModelGateway, request: ModelRequest): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of gateway.stream(request)) {
    events.push(event);
  }
  return events;
}

const SECRETS = [TASK5_SECRET_PRIMARY, TASK5_SECRET_FALLBACK, TASK5_SECRET_PROBE];

/**
 * No secret and no header value may ever appear in this text.
 *
 * A resolved candidate legitimately carries a provider URL and a credential
 * reference; those are checked separately, and the stricter variant below bans
 * them for anything a consumer can observe.
 */
function expectNoSecret(serialized: string, label: string): void {
  for (const secret of SECRETS) {
    expect(serialized, `${label} leaked ${secret}`).not.toContain(secret);
  }
  expect(serialized, label).not.toContain("x-api-key");
  expect(serialized, label).not.toContain("authorization");
  expect(serialized, label).not.toContain("content-type");
}

/**
 * Stricter variant for anything a consumer can observe: no secret, but also no
 * provider URL and not even the credential *reference*.
 */
function expectNoSecretOrReference(serialized: string, label: string): void {
  expectNoSecret(serialized, label);
  expect(serialized, label).not.toContain("credential:");
  expect(serialized, label).not.toContain(TASK5_PRIMARY_BASE_URL);
  expect(serialized, label).not.toContain(TASK5_FALLBACK_BASE_URL);
}

/* ------------------------------------------------------------------ *
 * Runtime credential boundary
 * ------------------------------------------------------------------ */

describe("task 5 security — the secret stays inside one attempt", () => {
  it("never puts a secret into the route definition or the candidate list", () => {
    const fixture = twoProviderFixture();

    expectNoSecret(JSON.stringify(fixture.registry.getRoute(fixture.routeId)), "route");
    expectNoSecret(JSON.stringify(fixture.registry.listRoutes()), "routes");
    expectNoSecret(
      JSON.stringify(fixture.registry.resolveRouteCandidates(fixture.routeId)),
      "candidates",
    );
    expectNoSecret(JSON.stringify(fixture.registry.resolveRoute(fixture.routeId)), "resolved");

    // The candidate list legitimately carries the reference, but never a secret.
    const candidates = fixture.registry.resolveRouteCandidates(fixture.routeId);
    expect(candidates.map((candidate) => candidate.credentialRef)).toEqual([
      `credential:${fixture.primaryId}`,
      "credential:fallback-second",
    ]);
  });

  it("never puts a secret into a retried request body", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("ok"),
    ]);

    await run(build(fixture, http), requestFor(fixture));

    expect(http.calls()).toBe(2);
    for (const recorded of http.requests) {
      expectNoSecret(recorded.body, "request body");
      expect(recorded.body).not.toContain("req-t5");
      expect(recorded.body).not.toContain("route-t5");
    }
  });

  it("never puts a secret into the emitted events on the retry path", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("recovered"),
    ]);

    const events = await run(build(fixture, http), requestFor(fixture));

    expect(textOf(events)).toBe("recovered");
    expectNoSecretOrReference(JSON.stringify(events), "retry events");
  });

  it("never puts a secret into the emitted events on the failover path", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
      anthropicSuccessResponse("fallback"),
    ]);

    const events = await run(build(fixture, http), requestFor(fixture));

    expect(http.calls()).toBe(3);
    expect(textOf(events)).toBe("fallback");
    expectNoSecretOrReference(JSON.stringify(events), "failover events");
  });

  it("never puts a secret into the final error after every attempt failed", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(500),
      transportFailureResponse(500),
    ]);

    const events = await run(
      createResilientRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 40 },
      }),
      requestFor(fixture),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "upstream_unavailable" });
    expectNoSecretOrReference(JSON.stringify(events), "final error");
    expect(JSON.stringify(events)).not.toContain("providerId");
    expect(JSON.stringify(events)).not.toContain("fallback-second");
  });

  it("sends each provider its own credential and never the other one", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("fallback"),
    ]);

    await run(
      createResilientRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, initialBackoffMs: 10, maxBackoffMs: 40 },
      }),
      requestFor(fixture),
    );

    const [primaryRequest, fallbackRequest] = http.requests;
    expect(primaryRequest.url).toBe(`${TASK5_PRIMARY_BASE_URL}/v1/messages`);
    expect(headerValue(primaryRequest.headers, "x-api-key")).toBe(TASK5_SECRET_PRIMARY);
    expect(headerValue(primaryRequest.headers, "x-api-key")).not.toBe(
      TASK5_SECRET_FALLBACK,
    );

    expect(fallbackRequest.url).toBe(`${TASK5_FALLBACK_BASE_URL}/v1/messages`);
    expect(headerValue(fallbackRequest.headers, "x-api-key")).toBe(TASK5_SECRET_FALLBACK);
  });

  it("uses the fallback credential when the primary is disabled", async () => {
    const fixture = twoProviderFixture({ primaryEnabled: false });
    const http = createScriptedHttpClient([anthropicSuccessResponse()]);

    await run(build(fixture, http), requestFor(fixture));

    expect(http.calls()).toBe(1);
    expect(headerValue(http.request(0).headers, "x-api-key")).toBe(TASK5_SECRET_FALLBACK);
  });

  it("never reads a failing response body", async () => {
    const fixture = twoProviderFixture();
    let nextCalls = 0;
    const hostile: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            return { done: false, value: new Uint8Array([1]) };
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
    const http = createScriptedHttpClient([
      { status: 503, body: hostile },
      anthropicSuccessResponse("ok"),
    ]);

    const events = await run(build(fixture, http), requestFor(fixture));

    expect(nextCalls).toBe(0);
    expect(textOf(events)).toBe("ok");
  });

  it("never emits a provider identifier or transport field", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([transportFailureResponse(403)]);

    const events = await run(build(fixture, http), requestFor(fixture));

    const serialized = JSON.stringify(events);
    for (const forbidden of [
      "primary-main",
      "fallback-second",
      "providerId",
      "baseUrl",
      "credentialRef",
      "headers",
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("never calls the global fetch during the offline scenarios", async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const fixture = twoProviderFixture();
      const http = createScriptedHttpClient([
        transportFailureResponse(503),
        anthropicSuccessResponse("ok"),
      ]);
      await run(build(fixture, http), requestFor(fixture));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Agent Core integration
 * ------------------------------------------------------------------ */

describe("task 5 security — Agent Core keeps its own error whitelist", () => {
  it("surfaces a successful failover without leaking the provider", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      anthropicSuccessResponse("fallback"),
    ]);
    const core = createAgentCore(build(fixture, http));

    const events: AgentEvent[] = [];
    for await (const event of core.run(requestFor(fixture))) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "route_selected",
      requestId: "req-t5",
      routeId: fixture.routeId,
      model: fixture.model,
    });
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("primary-main");
    expect(JSON.stringify(events)).not.toContain("fallback-second");
    expectNoSecretOrReference(JSON.stringify(events), "agent events");
  });

  it("collapses an exhausted retry policy into one fixed safe Agent error", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(503),
      transportFailureResponse(503),
    ]);
    const core = createAgentCore(
      createResilientRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 2, initialBackoffMs: 10, maxBackoffMs: 40 },
      }),
    );

    const events: AgentEvent[] = [];
    for await (const event of core.run(requestFor(fixture))) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        requestId: "req-t5",
        code: "upstream_unavailable",
        message: "Model gateway request failed.",
        retryable: true,
      },
    ]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expectNoSecretOrReference(JSON.stringify(events), "agent error");
  });
});

/* ------------------------------------------------------------------ *
 * Source level boundaries
 * ------------------------------------------------------------------ */

describe("task 5 security — source boundaries", () => {
  it("introduces no network client or provider SDK", () => {
    const forbidden = [
      /from\s+["'](axios|undici|node-fetch|got|superagent)["']/,
      /from\s+["']@anthropic-ai\/sdk["']/,
      /from\s+["']openai["']/,
      /\brequire\s*\(\s*["'](axios|undici|node-fetch)["']\s*\)/,
    ];
    for (const file of gatewaySources) {
      for (const pattern of forbidden) {
        expect(file.text, `${file.path} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("references no other agent project", () => {
    for (const file of [...gatewaySources, ...registrySources]) {
      expect(file.text, file.path).not.toMatch(/cc[-_ ]?switch/i);
      expect(file.text, file.path).not.toMatch(/claude[-_ ]?code/i);
    }
  });

  it("keeps the global fetch confined to the HTTP transport file", () => {
    const owners = gatewaySources
      .filter((file) => /\bfetch\b/i.test(file.text))
      .map((file) => file.path);

    expect(owners).toEqual(["packages/model-gateway/src/http-transport.ts"]);
  });

  it("uses only public workspace imports between packages", () => {
    for (const file of [...gatewaySources, ...registrySources]) {
      expect(file.text, file.path).not.toMatch(/\.\.\/\.\.[^"']*\/src\//);
      expect(file.text, file.path).not.toMatch(/provider-registry\/src\//);
      expect(file.text, file.path).not.toMatch(/agent-contracts\/src\//);
    }
    for (const file of registrySources) {
      expect(file.text, file.path).not.toContain("model-gateway");
      expect(file.text, file.path).not.toContain("agent-core");
    }
  });

  it("never writes to a file, database, environment or keychain", () => {
    const forbidden = [
      /\bwriteFile(Sync)?\s*\(/,
      /\bappendFile(Sync)?\s*\(/,
      /\bcreateWriteStream\s*\(/,
      /from\s+["']node:fs/,
      /from\s+["']node:child_process["']/,
      /\b(sqlite|better-sqlite3|keytar|leveldb)\b/,
      /\bprocess\.env\b/,
    ];
    for (const file of [...gatewaySources, ...registrySources]) {
      for (const pattern of forbidden) {
        expect(file.text, `${file.path} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps provider-registry free of dependencies and of the gateway", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages/provider-registry/package.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });

  it("keeps model-gateway free of agent-core and of new dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages/model-gateway/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(manifest.dependencies).toEqual({
      "@agent-workbench/agent-contracts": "workspace:*",
      "@agent-workbench/provider-registry": "workspace:*",
    });
    expect(manifest.devDependencies).toBeUndefined();
  });

  it("does not touch the Agent Core error whitelist", () => {
    const core = readFileSync(
      join(root, "packages/agent-core/src/agent-core.ts"),
      "utf8",
    );

    for (const code of [
      "aborted",
      "rate_limited",
      "upstream_unavailable",
      "provider_protocol_error",
      "gateway_error",
    ]) {
      expect(core, code).toContain(code);
    }
    expect(core).toContain("Model gateway request failed.");
    expect(core).toContain("Request aborted.");
  });

  it("keeps the protocol decoders free of routing and credentials", () => {
    const adapters = gatewaySources.filter((file) =>
      file.path.startsWith("packages/model-gateway/src/adapters/"),
    );
    for (const file of adapters) {
      expect(file.text, file.path).not.toMatch(/provider-registry/);
      expect(file.text, file.path).not.toMatch(/CredentialStore|credentialRef/);
      expect(file.text, file.path).not.toMatch(/RoutedHttpModelGateway/);
    }
  });

  it("keeps the resilience module free of a second secret source", () => {
    const source = gatewaySources.find(
      (file) => file.path === "packages/model-gateway/src/resilience.ts",
    );
    expect(source).toBeDefined();
    // The resilience layer only reads a credential reference through the shared
    // attempt runner; it never stores or forwards a secret itself.
    expect(source?.text).not.toMatch(/\bapiKey\b/);
    expect(source?.text).not.toMatch(/Bearer/);
  });

  it("exposes an OpenAI candidate without an api key header", async () => {
    const fixture = twoProviderFixture({ primaryProtocol: "openai_compatible" });
    const http = createScriptedHttpClient([openaiSuccessResponse("ok")]);

    const events = await run(build(fixture, http), requestFor(fixture));

    expect(textOf(events)).toBe("ok");
    expect(headerValue(http.request(0).headers, "authorization")).toBe(
      `Bearer ${TASK5_SECRET_PRIMARY}`,
    );
    expect(headerValue(http.request(0).headers, "x-api-key")).toBeUndefined();
  });

  it("keeps a synthetic secret out of the recorded request headers of the other provider", async () => {
    const fixture = twoProviderFixture();
    const http = createScriptedHttpClient([
      transportFailureResponse(429),
      anthropicSuccessResponse("ok"),
    ]);

    await run(
      createResilientRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
        retryPolicy: { maxAttemptsPerProvider: 1, maxTotalAttempts: 8, initialBackoffMs: 10, maxBackoffMs: 40 },
      }),
      requestFor(fixture),
    );

    expect(JSON.stringify(http.requests[0].headers)).not.toContain(TASK5_SECRET_FALLBACK);
    expect(JSON.stringify(http.requests[1].headers)).not.toContain(TASK5_SECRET_PRIMARY);
  });

  it("never accepts a secret shaped fallback identifier", () => {
    const fixture = twoProviderFixture();
    let caught: unknown;
    try {
      fixture.registry.registerRoute({
        id: "route-secret",
        name: "Route Secret",
        providerId: fixture.primaryId,
        model: fixture.model,
        enabled: true,
        fallbackProviderIds: [TASK5_SECRET_PROBE],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("invalid_fallback_provider_ids");
    expect((caught as Error).message).not.toContain(TASK5_SECRET_PROBE);
  });
});
