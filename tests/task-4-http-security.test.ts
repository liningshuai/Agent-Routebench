import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoutedHttpModelGateway } from "../packages/model-gateway/src/index.js";
import { collectEvents, errorEventCodes } from "./helpers/adapter-fixtures.js";
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_CREDENTIAL_REF,
  LEAK_PROBE,
  OPENAI_BASE_URL,
  TEST_SECRET,
  anthropicTextStream,
  bytesBody,
  createFakeHttpClient,
  httpResponse,
  makeRequest,
  makeRouteFixture,
  openaiTextStream,
} from "./helpers/http-fixtures.js";

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

/* ------------------------------------------------------------------ *
 * Runtime secret boundary
 * ------------------------------------------------------------------ */

describe("task 4 — the secret never leaves the HTTP transport boundary", () => {
  it("keeps the secret out of the encoded request body", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    await collectEvents(gateway.stream(makeRequest()));

    expect(http.request(0).body).not.toContain(TEST_SECRET);
  });

  it("keeps the secret out of the emitted events on the success path", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(anthropicTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collectEvents(gateway.stream(makeRequest()));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain("credential:");
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
    expect(serialized).not.toContain("x-api-key");
    expect(serialized).not.toContain("authorization");
  });

  it("keeps the secret out of the emitted events on the OpenAI path", async () => {
    const fixture = makeRouteFixture({ protocol: "openai_compatible" });
    const http = createFakeHttpClient(() =>
      httpResponse(200, bytesBody(openaiTextStream())),
    );
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collectEvents(gateway.stream(makeRequest()));

    expect(JSON.stringify(events)).not.toContain(TEST_SECRET);
    expect(JSON.stringify(events)).not.toContain(OPENAI_BASE_URL);
  });

  it("never surfaces a hostile body from a failing response", async () => {
    for (const status of [401, 403, 429, 500]) {
      const fixture = makeRouteFixture();
      const http = createFakeHttpClient(() =>
        httpResponse(
          status,
          bytesBody(
            `{"error":{"message":"${LEAK_PROBE}","url":"${ANTHROPIC_BASE_URL}","hint":"Bearer ${LEAK_PROBE}"}}`,
          ),
        ),
      );
      const gateway = createRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
      });

      const events = await collectEvents(gateway.stream(makeRequest()));
      const serialized = JSON.stringify(events);

      expect(serialized, `status ${status}`).not.toContain(LEAK_PROBE);
      expect(serialized, `status ${status}`).not.toContain(ANTHROPIC_BASE_URL);
      expect(serialized, `status ${status}`).not.toContain("Bearer");
      expect(serialized, `status ${status}`).not.toContain("hint");
      expect(
        events.filter((event) => event.type === "error"),
        `status ${status}`,
      ).toHaveLength(1);
      expect(
        events.some((event) => event.type === "completed"),
        `status ${status}`,
      ).toBe(false);
    }
  });

  it("only emits whitelisted, fixed error codes and messages", async () => {
    const allowedCodes = new Set([
      "aborted",
      "rate_limited",
      "upstream_unavailable",
      "provider_protocol_error",
      "gateway_error",
    ]);
    const allowedMessages = new Set([
      "Request aborted.",
      "The upstream provider is currently unavailable.",
      "The upstream provider rate limited this request.",
      "The provider stream is outside the supported protocol subset.",
      "Model gateway request failed.",
    ]);

    const scenarios = [
      () => httpResponse(401, null),
      () => httpResponse(429, null),
      () => httpResponse(503, null),
      () => httpResponse(200, null),
      () => {
        throw new Error("boom");
      },
    ];

    for (const respond of scenarios) {
      const fixture = makeRouteFixture();
      const http = createFakeHttpClient(respond);
      const gateway = createRoutedHttpModelGateway({
        registry: fixture.registry,
        credentials: fixture.credentials,
        httpClient: http.client,
      });

      const events = await collectEvents(gateway.stream(makeRequest()));
      for (const event of events) {
        if (event.type !== "error") {
          continue;
        }
        expect(allowedCodes.has(event.code)).toBe(true);
        expect(allowedMessages.has(event.message)).toBe(true);
        expect(event.message).not.toMatch(/https?:\/\//);
        expect(event.message).not.toMatch(/\d{3}/);
      }
    }
  });

  it("does not leak the resolved route on a route failure", async () => {
    const fixture = makeRouteFixture();
    const http = createFakeHttpClient(() => httpResponse(200, null));
    const gateway = createRoutedHttpModelGateway({
      registry: fixture.registry,
      credentials: fixture.credentials,
      httpClient: http.client,
    });

    const events = await collectEvents(
      gateway.stream(makeRequest({ routeId: "route-nowhere" })),
    );

    const serialized = JSON.stringify(events);
    expect(errorEventCodes(events)).toEqual(["gateway_error"]);
    expect(serialized).not.toContain("route-nowhere");
    expect(serialized).not.toContain(DEFAULT_CREDENTIAL_REF);
    expect(serialized).not.toContain(ANTHROPIC_BASE_URL);
  });

  it("never calls the global fetch while handling offline scenarios", async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      for (const protocol of ["anthropic_messages", "openai_compatible"] as const) {
        const fixture = makeRouteFixture({ protocol });
        const http = createFakeHttpClient(() =>
          httpResponse(
            200,
            bytesBody(
              protocol === "anthropic_messages"
                ? anthropicTextStream()
                : openaiTextStream(),
            ),
          ),
        );
        const gateway = createRoutedHttpModelGateway({
          registry: fixture.registry,
          credentials: fixture.credentials,
          httpClient: http.client,
        });
        await collectEvents(gateway.stream(makeRequest()));
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Source level boundaries
 * ------------------------------------------------------------------ */

describe("task 4 — source level boundaries", () => {
  it("does not import a network client or a provider SDK", () => {
    const forbidden = [
      /from\s+["'](axios|undici|node-fetch|got|superagent|request-promise)["']/,
      /from\s+["']@anthropic-ai\/sdk["']/,
      /from\s+["']openai["']/,
      /from\s+["']@google\/generative-ai["']/,
      /\brequire\s*\(\s*["'](axios|undici|node-fetch)["']\s*\)/,
    ];

    for (const file of gatewaySources) {
      for (const pattern of forbidden) {
        expect(file.text, `${file.path} matches ${String(pattern)}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("does not reference cc-switch or another agent project", () => {
    for (const file of gatewaySources) {
      expect(file.text, file.path).not.toMatch(/cc[-_ ]?switch/i);
      expect(file.text, file.path).not.toMatch(/claude[-_ ]?code/i);
    }
  });

  it("imports sibling packages only through their public workspace interface", () => {
    for (const file of gatewaySources) {
      expect(file.text, file.path).not.toMatch(/\.\.\/\.\.[^"']*\/src\//);
      expect(file.text, file.path).not.toMatch(/provider-registry\/src\//);
      expect(file.text, file.path).not.toMatch(/agent-contracts\/src\//);
    }
  });

  it("reaches for the global fetch only inside the HTTP transport file", () => {
    const owners = gatewaySources
      .filter((file) => /\bfetch\b/i.test(file.text))
      .map((file) => file.path);

    expect(owners).toEqual(["packages/model-gateway/src/http-transport.ts"]);
  });

  it("uses the public provider-registry specifier from the routed gateway", () => {
    const source = gatewaySources.find(
      (file) => file.path === "packages/model-gateway/src/routed-http-gateway.ts",
    );

    expect(source).toBeDefined();
    expect(source?.text).toContain('"@agent-workbench/provider-registry"');
    expect(source?.text).toContain('"@agent-workbench/agent-contracts"');
    expect(source?.text).not.toContain("agent-core");
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
      /\bindexedDB\b/,
    ];

    for (const file of gatewaySources) {
      for (const pattern of forbidden) {
        expect(file.text, `${file.path} matches ${String(pattern)}`).not.toMatch(
          pattern,
        );
      }
    }
  });

  it("keeps the protocol decoders free of credentials and routing", () => {
    const adapters = gatewaySources.filter((file) =>
      file.path.startsWith("packages/model-gateway/src/adapters/"),
    );

    expect(adapters.length).toBeGreaterThan(0);
    for (const file of adapters) {
      expect(file.text, file.path).not.toMatch(/provider-registry/);
      expect(file.text, file.path).not.toMatch(/CredentialStore|credentialRef/);
      expect(file.text, file.path).not.toMatch(/globalThis\.fetch/);
      expect(file.text, file.path).not.toMatch(/\bRoutedHttpModelGateway\b/);
    }
  });

  it("declares provider-registry as a workspace dependency of model-gateway only", () => {
    const gatewayManifest = JSON.parse(
      readFileSync(join(root, "packages/model-gateway/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(gatewayManifest.dependencies).toEqual({
      "@agent-workbench/agent-contracts": "workspace:*",
      "@agent-workbench/provider-registry": "workspace:*",
    });
    expect(gatewayManifest.devDependencies).toBeUndefined();
    expect(JSON.stringify(gatewayManifest)).not.toContain("agent-core");
    expect(JSON.stringify(gatewayManifest)).not.toContain("axios");
    expect(JSON.stringify(gatewayManifest)).not.toContain("undici");
  });

  it("leaves provider-registry free of the gateway and of dependencies", () => {
    const registryManifest = JSON.parse(
      readFileSync(join(root, "packages/provider-registry/package.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(registryManifest.dependencies).toBeUndefined();
    expect(registryManifest.devDependencies).toBeUndefined();

    for (const file of registrySources) {
      expect(file.text, file.path).not.toContain("model-gateway");
      expect(file.text, file.path).not.toContain("agent-core");
    }
  });

  it("keeps agent-core free of any gateway dependency", () => {
    const coreManifest = readFileSync(
      join(root, "packages/agent-core/package.json"),
      "utf8",
    );
    expect(coreManifest).not.toContain("model-gateway");
    expect(coreManifest).not.toContain("provider-registry");
  });
});
