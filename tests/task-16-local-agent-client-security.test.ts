import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LocalAgentApiClient,
  LocalAgentClientError,
  LOCAL_AGENT_CLIENT_ERROR_CODES,
} from "../packages/local-agent-client/src/index.js";
import { jsonResponse, streamResponse, completedEvent, userRequest } from "./helpers/local-agent-client-fixtures.js";

const root = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const absolute = join(root, dir);
  return readdirSync(absolute).flatMap((entry) => {
    const full = join(absolute, entry);
    return statSync(full).isDirectory() ? sourceFiles(join(dir, entry)) : [full];
  });
}

describe("Task 16 Local Agent client security boundary", () => {
  it.each([
    { apiKey: "secret" },
    { token: "secret" },
    { authorization: "Bearer secret" },
    { headers: { authorization: "Bearer secret" } },
    { password: "secret" },
    { credential: "credential:secret" },
  ])("rejects sensitive fields from a turn request: %o", async (extra) => {
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => streamResponse([completedEvent()]),
    );

    await expect(
      (async () => {
        for await (const _event of client.runTurn("sess-1", {
          ...userRequest(),
          ...extra,
        } as never)) {
          // consume
        }
      })(),
    ).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.invalidArguments,
      message: "Local Agent client arguments are invalid.",
    });
  });

  it("rejects unknown turn fields instead of forwarding them", async () => {
    let calls = 0;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => {
        calls += 1;
        return streamResponse([completedEvent()]);
      },
    );

    await expect(
      (async () => {
        for await (const _event of client.runTurn("sess-1", {
          ...userRequest(),
          unknown: true,
        } as never)) {
          // consume
        }
      })(),
    ).rejects.toBeInstanceOf(LocalAgentClientError);
    expect(calls).toBe(0);
  });

  it("does not send authentication headers", async () => {
    let headers: Headers | undefined;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async (_url, init) => {
        headers = new Headers(init?.headers);
        return jsonResponse({ ok: true });
      },
    );

    await client.health();

    expect(headers?.has("authorization")).toBe(false);
    expect(headers?.has("x-api-key")).toBe(false);
  });

  it("keeps hostile HTTP response text out of fixed errors", async () => {
    const hostile = "https://provider.invalid/v1 Authorization Bearer SECRET";
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => new Response(hostile, { status: 401 }),
    );

    await expect(client.health()).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiHttpError,
      message: "Local Agent API request failed.",
    });
  });

  it("does not expose a network error cause", async () => {
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => {
        throw new Error("https://provider.invalid/v1 SECRET");
      },
    );

    try {
      await client.health();
      expect.fail("expected an error");
    } catch (error) {
      expect(error).toMatchObject({
        code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiUnavailable,
        message: "Local Agent API is unavailable.",
      });
      expect(JSON.stringify(error)).not.toContain("provider.invalid");
    }
  });

  it("validates the session response shape", async () => {
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => jsonResponse({ session: { id: "s", status: "idle" } }),
    );

    await expect(client.createSession()).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError,
    });
  });

  it("rejects an events envelope with non-array events", async () => {
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => jsonResponse({ sessionId: "s", events: {} }),
    );

    await expect(client.listEvents("s")).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError,
    });
  });

  it("rejects a pre-aborted request before calling fetch", async () => {
    let calls = 0;
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    );
    const controller = new AbortController();
    controller.abort();

    await expect(client.health(controller.signal)).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.aborted,
    });
    expect(calls).toBe(0);
  });

  it("contains no direct provider or credential implementation", () => {
    const files = sourceFiles("packages/local-agent-client/src");
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

    expect(source).not.toMatch(/provider-registry|credential-store|model-gateway/);
    expect(source).not.toMatch(/process\.env|node:fs|node:http|https:\/\//);
    expect(source).not.toMatch(
      /Authorization|Bearer|apiKey|api_key|credential-store|provider-registry|model-gateway/i,
    );
  });

  it("uses the fixed error vocabulary", () => {
    expect(LOCAL_AGENT_CLIENT_ERROR_CODES).toMatchObject({
      apiUnavailable: "api_unavailable",
      apiHttpError: "api_http_error",
      apiProtocolError: "api_protocol_error",
      streamTooLarge: "stream_too_large",
      aborted: "aborted",
    });
  });

  it("keeps the shared package independent from provider and runtime layers", () => {
    const packageJson = JSON.parse(
      readFileSync(join(root, "packages/local-agent-client/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: unknown };
    expect(packageJson.dependencies).toEqual({
      "@agent-workbench/agent-core": "workspace:*",
      "@agent-workbench/local-agent-api": "workspace:*",
    });
    expect(packageJson.devDependencies).toBeUndefined();
  });

  it("keeps CLI compatibility and Desktop adaptation free of duplicate transport code", () => {
    const cliClient = readFileSync(join(root, "apps/cli/src/api-client.ts"), "utf8");
    const cliParser = readFileSync(join(root, "apps/cli/src/ndjson.ts"), "utf8");
    const desktopAdapter = readFileSync(
      join(root, "apps/desktop/src/local-api-client.ts"),
      "utf8",
    );

    expect(cliClient).toContain("@agent-workbench/local-agent-client");
    expect(cliClient).not.toContain("class LocalAgentApiClient");
    expect(cliParser).toContain("@agent-workbench/local-agent-client");
    expect(desktopAdapter).not.toMatch(/fetch\s*\(/i);
  });
});
