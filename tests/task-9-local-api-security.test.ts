import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  httpJson,
  httpNdjson,
  makeCompletedEvent,
  makeTextEvent,
  startServer,
  userMessage,
} from "./helpers/local-agent-api-fixtures.js";

const pkgRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "local-agent-api",
);

const SECRET = "TASK9_SYNTHETIC_SECRET";
const BEARER = `Authorization: Bearer ${SECRET}`;
const SSH_PATH = "/home/user/.ssh/id_rsa";
const PROVIDER_URL = "https://provider.invalid/v1";

const SENSITIVE_FIELDS = [
  "apiKey",
  "api_key",
  "token",
  "authorization",
  "headers",
  "secret",
  "password",
  "credential",
  "endpoint",
  "baseUrl",
  "base_url",
  "accessToken",
  "refreshToken",
  "clientSecret",
];

async function withServer(
  run: (port: number) => Promise<void>,
  options?: Parameters<typeof startServer>[0],
): Promise<void> {
  const { server, port } = await startServer(options);
  try {
    await run(port);
  } finally {
    await server.close();
  }
}

describe("task 9 security", () => {
  it("rejects every sensitive field at the turn root", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      for (const field of SENSITIVE_FIELDS) {
        const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
          [field]: SECRET,
        });
        expect(res.status).toBe(400);
        expect(res.text).not.toContain(SECRET);
      }
    });
  });

  it("rejects nested sensitive fields", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        options: { nested: { apiKey: SECRET } },
      });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(SECRET);
    });
  });

  it("does not leak runner exception text", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const res = await httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.events);
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(BEARER);
        expect(text).not.toContain(SSH_PATH);
        expect(text).not.toContain("at ");
        const errorEvent = res.events.find(
          (e) => (e as { type?: string }).type === "error",
        );
        expect(errorEvent).toBeDefined();
        expect((errorEvent as { code: string }).code).toBe("runner_error");
        expect((errorEvent as { message: string }).message).toBe(
          "Agent runner failed.",
        );
      },
      {
        runner: {
          async run() {
            throw new Error(`boom ${BEARER} ${SSH_PATH} ${PROVIDER_URL}`);
          },
        },
      },
    );
  });

  it("does not leak markers in session metadata", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const res = await httpJson(port, "GET", `/v1/sessions/${id}`);
        expect(res.text).not.toContain(SECRET);
        expect(res.text).not.toContain(SSH_PATH);
      },
      {
        runner: {
          async run() {
            throw new Error(SECRET);
          },
        },
      },
    );
  });

  it("does not leak markers in the events query", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        await httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        const res = await httpJson(port, "GET", `/v1/sessions/${id}/events`);
        expect(res.text).not.toContain(SECRET);
        expect(res.text).not.toContain(BEARER);
        expect(res.text).not.toContain(SSH_PATH);
      },
      {
        runner: {
          async run() {
            throw new Error(`${BEARER} ${SSH_PATH}`);
          },
        },
      },
    );
  });

  it("rejects a payload larger than 1 MiB", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const huge = "x".repeat(1024 * 1024 + 64);
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage(huge)],
      });
      expect(res.status).toBe(413);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "payload_too_large",
      );
    });
  });

  it("rejects a remote host option", () => {
    return expect(async () => {
      await startServer({ host: "0.0.0.0" as unknown as "127.0.0.1" });
    }).rejects.toThrow();
  });

  it("source contains no fetch, axios, undici, fs or process.env", () => {
    const files = [
      "src/types.ts",
      "src/errors.ts",
      "src/validation.ts",
      "src/session-store.ts",
      "src/ndjson.ts",
      "src/server.ts",
      "src/index.ts",
    ];
    for (const file of files) {
      const text = readFileSync(join(pkgRoot, file), "utf8");
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(/axios/);
      expect(text).not.toMatch(/undici/);
      expect(text).not.toMatch(/WebSocket/);
      expect(text).not.toMatch(/node:fs/);
      expect(text).not.toMatch(/process\.env/);
      expect(text).not.toMatch(/process\.env/);
    }
  });

  it("does not depend on provider-registry or local-persistence", () => {
    const pkg = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain("@agent-workbench/provider-registry");
    expect(deps).not.toContain("@agent-workbench/local-persistence");
    expect(deps).not.toContain("@agent-workbench/model-gateway");
  });

  it("does not leak markers in fixed error messages", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        apiKey: SECRET,
      });
      expect(res.status).toBe(400);
      const body = res.json() as { error: { message: string } };
      expect(body.error.message).toBe("Request is invalid.");
      expect(body.error.message).not.toContain(SECRET);
    });
  });

  it("preserves only non-sensitive runner events", async () => {
    await withServer(
      async (port) => {
        const created = await httpJson(port, "POST", "/v1/sessions", {});
        const id = (created.json() as { session: { id: string } }).session.id;
        const res = await httpNdjson(port, `/v1/sessions/${id}/turns`, {
          messages: [userMessage("hi")],
        });
        expect(res.events[0]).toEqual(makeTextEvent("safe"));
        expect(JSON.stringify(res.events)).not.toContain(SECRET);
      },
      {
        runner: {
          async run() {
            return {
              async *[Symbol.asyncIterator]() {
                yield makeTextEvent("safe");
                yield makeCompletedEvent();
              },
            };
          },
        },
      },
    );
  });
});

function nestDeep(inner: Record<string, unknown>, depth: number): unknown {
  let value: unknown = inner;
  for (let i = 0; i < depth; i += 1) {
    value = { a: value };
  }
  return value;
}

describe("task 9 deep sensitive fields", () => {
  const DEEP_SECRET = "TASK9_DEEP_SYNTHETIC_SECRET";

  it("rejects a token nested deeper than 32 levels inside inputSchema", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const deepSchema = nestDeep({ token: DEEP_SECRET }, 40);
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        tools: [
          {
            name: "deep_tool",
            description: "deep",
            inputSchema: deepSchema,
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(DEEP_SECRET);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "invalid_request",
      );
    });
  });

  it("rejects an Authorization header nested deeper than 32 levels inside inputSchema", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const deepSchema = nestDeep(
        { authorization: `Bearer ${DEEP_SECRET}` },
        40,
      );
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        tools: [
          {
            name: "deep_tool",
            description: "deep",
            inputSchema: deepSchema,
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(DEEP_SECRET);
      expect(res.text).not.toContain("Bearer");
    });
  });

  it("rejects a tool definition carrying a sensitive field", async () => {
    await withServer(async (port) => {
      const created = await httpJson(port, "POST", "/v1/sessions", {});
      const id = (created.json() as { session: { id: string } }).session.id;
      const res = await httpJson(port, "POST", `/v1/sessions/${id}/turns`, {
        messages: [userMessage("hi")],
        tools: [
          {
            name: "read_file",
            description: "read",
            inputSchema: { type: "object" },
            apiKey: DEEP_SECRET,
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(DEEP_SECRET);
    });
  });
});
