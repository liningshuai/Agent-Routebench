import { describe, test, expect } from "vitest";
import { LocalAgentApiClient } from "../apps/cli/src/api-client.js";
import { CLI_ERROR_CODES } from "../apps/cli/src/errors.js";
import type { LocalAgentTurnRequest } from "@agent-workbench/local-agent-api";
import {
  createFakeFetch,
  makeHealthResponse,
  makeSessionResponse,
  makeEventsResponse,
  makeCancelResponse,
  makeStreamResponse,
  makeTextDeltaEvent,
  makeCompletedEvent,
  makeErrorEvent,
} from "./helpers/cli-fixtures.js";

describe("task 13 CLI API client HTTP requests", () => {
  describe("health", () => {
    test("GET /health with no body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | null = null;

      const fetch = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method || "GET";
        capturedBody = init?.body?.toString() || null;
        return new Response(JSON.stringify({ status: "ok", version: "v1" }), {
          status: 200,
        });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.health();

      expect(capturedUrl).toBe("http://127.0.0.1:4317/health");
      expect(capturedMethod).toBe("GET");
      expect(capturedBody).toBeNull();
    });

    test("does not send Authorization header", async () => {
      let capturedHeaders: Headers | undefined;

      const fetch = async (url: string, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.health();

      expect(capturedHeaders?.has("authorization")).toBe(false);
      expect(capturedHeaders?.has("Authorization")).toBe(false);
    });
  });

  describe("createSession", () => {
    test("POST /v1/sessions with empty JSON body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";
      let capturedContentType = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method || "GET";
        capturedBody = init?.body?.toString() || "";
        const headers = new Headers(init?.headers);
        capturedContentType = headers.get("content-type") || "";

        return new Response(
          JSON.stringify({
            id: "sess-123",
            status: "idle",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
          { status: 200 },
        );
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.createSession();

      expect(capturedUrl).toBe("http://127.0.0.1:4317/v1/sessions");
      expect(capturedMethod).toBe("POST");
      expect(capturedBody).toBe("{}");
      expect(capturedContentType).toBe("application/json");
    });

    test("does not send authentication headers", async () => {
      let capturedHeaders: Headers | undefined;

      const fetch = async (url: string, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ id: "s", status: "idle", createdAt: 1, updatedAt: 1 }),
          { status: 200 },
        );
      };

      const client = new LocalAgentApiClient("http://localhost:4317", fetch);
      await client.createSession();

      expect(capturedHeaders?.has("authorization")).toBe(false);
      expect(capturedHeaders?.has("token")).toBe(false);
    });
  });

  describe("POST Content-Type headers", () => {
    test("POST /v1/sessions sends application/json Content-Type", async () => {
      let capturedContentType = "";

      const fetch = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        capturedContentType = headers.get("content-type") || "";
        return new Response(
          JSON.stringify({ id: "s", status: "idle", createdAt: 1, updatedAt: 1 }),
          { status: 200 },
        );
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.createSession();

      expect(capturedContentType).toBe("application/json");
    });

    test("POST /v1/sessions/:id/cancel sends application/json Content-Type", async () => {
      let capturedContentType = "";

      const fetch = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        capturedContentType = headers.get("content-type") || "";
        return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.cancel("sess-123");

      expect(capturedContentType).toBe("application/json");
    });

    test("POST /v1/sessions/:id/turns sends application/json Content-Type", async () => {
      let capturedContentType = "";

      const fetch = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        capturedContentType = headers.get("content-type") || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
      };

      const stream = client.runTurn("sess-456", request);
      try {
        for await (const _ of stream) {
        }
      } catch {
        // ignore protocol errors
      }

      expect(capturedContentType).toBe("application/json");
    });
  });

  describe("getSession", () => {
    test("GET /v1/sessions/:id", async () => {
      let capturedUrl = "";
      let capturedMethod = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method || "GET";
        return new Response(
          JSON.stringify({ id: "sess-456", status: "idle", createdAt: 1, updatedAt: 1 }),
          { status: 200 },
        );
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.getSession("sess-456");

      expect(capturedUrl).toBe("http://127.0.0.1:4317/v1/sessions/sess-456");
      expect(capturedMethod).toBe("GET");
    });
  });

  describe("listEvents", () => {
    test("GET /v1/sessions/:id/events", async () => {
      let capturedUrl = "";

      const fetch = async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      };

      const client = new LocalAgentApiClient("http://localhost:9000", fetch);
      await client.listEvents("sess-789");

      expect(capturedUrl).toBe("http://localhost:9000/v1/sessions/sess-789/events");
    });
  });

  describe("cancel", () => {
    test("POST /v1/sessions/:id/cancel with empty JSON body", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init?.method || "GET";
        capturedBody = init?.body?.toString() || "";
        return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:8080", fetch);
      await client.cancel("sess-xyz");

      expect(capturedUrl).toBe("http://127.0.0.1:8080/v1/sessions/sess-xyz/cancel");
      expect(capturedMethod).toBe("POST");
      expect(capturedBody).toBe("{}");
    });
  });

  describe("runTurn request body", () => {
    test("includes messages with user message", async () => {
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body?.toString() || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      };

      const stream = client.runTurn("sess-1", request);
      try {
        for await (const _ of stream) {
          // consume stream
        }
      } catch {
        // ignore protocol errors for this test
      }

      const parsed = JSON.parse(capturedBody);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0].role).toBe("user");
      expect(parsed.messages[0].content[0].text).toBe("Hello");
    });

    test("includes optional routeId when provided", async () => {
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body?.toString() || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
        routeId: "route-123",
      };

      const stream = client.runTurn("sess-2", request);
      try {
        for await (const _ of stream) {
        }
      } catch {
      }

      const parsed = JSON.parse(capturedBody);
      expect(parsed.routeId).toBe("route-123");
    });

    test("includes optional model when provided", async () => {
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body?.toString() || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
        model: "gpt-4",
      };

      const stream = client.runTurn("sess-3", request);
      try {
        for await (const _ of stream) {
        }
      } catch {
      }

      const parsed = JSON.parse(capturedBody);
      expect(parsed.model).toBe("gpt-4");
    });

    test("includes optional maxTokens when provided", async () => {
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body?.toString() || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
        maxTokens: 2000,
      };

      const stream = client.runTurn("sess-4", request);
      try {
        for await (const _ of stream) {
        }
      } catch {
      }

      const parsed = JSON.parse(capturedBody);
      expect(parsed.maxTokens).toBe(2000);
    });

    test("omits optional fields when not provided", async () => {
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body?.toString() || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Plain" }] }],
      };

      const stream = client.runTurn("sess-5", request);
      try {
        for await (const _ of stream) {
        }
      } catch {
      }

      const parsed = JSON.parse(capturedBody);
      expect(parsed.routeId).toBeUndefined();
      expect(parsed.model).toBeUndefined();
      expect(parsed.maxTokens).toBeUndefined();
    });

    test("does not include sensitive fields in body", async () => {
      let capturedBody = "";

      const fetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body?.toString() || "";
        return new Response("", { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Check" }] }],
      };

      const stream = client.runTurn("sess-6", request);
      try {
        for await (const _ of stream) {
        }
      } catch {
      }

      const body = capturedBody.toLowerCase();
      expect(body).not.toContain("apikey");
      expect(body).not.toContain("api_key");
      expect(body).not.toContain("token");
      expect(body).not.toContain("secret");
      expect(body).not.toContain("password");
      expect(body).not.toContain("authorization");
      expect(body).not.toContain("credential");
    });
  });

  describe("URL construction", () => {
    test("handles base URL with trailing slash", async () => {
      let capturedUrl = "";

      const fetch = async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317/", fetch);
      await client.health();

      expect(capturedUrl).toBe("http://127.0.0.1:4317/health");
      expect(capturedUrl).not.toContain("//health");
    });

    test("handles base URL without trailing slash", async () => {
      let capturedUrl = "";

      const fetch = async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      };

      const client = new LocalAgentApiClient("http://localhost:8080", fetch);
      await client.health();

      expect(capturedUrl).toBe("http://localhost:8080/health");
    });
  });

  describe("AbortSignal propagation", () => {
    test("passes signal to fetch for health", async () => {
      let capturedSignal: AbortSignal | undefined;

      const fetch = async (url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      };

      const controller = new AbortController();
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.health(controller.signal);

      expect(capturedSignal).toBe(controller.signal);
    });

    test("passes signal to fetch for createSession", async () => {
      let capturedSignal: AbortSignal | undefined;

      const fetch = async (url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Response(
          JSON.stringify({ id: "s", status: "idle", createdAt: 1, updatedAt: 1 }),
          { status: 200 },
        );
      };

      const controller = new AbortController();
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      await client.createSession(controller.signal);

      expect(capturedSignal).toBe(controller.signal);
    });

    test("passes signal to fetch for runTurn", async () => {
      let capturedSignal: AbortSignal | undefined;

      const fetch = async (url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return new Response("", { status: 200 });
      };

      const controller = new AbortController();
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);
      const request: LocalAgentTurnRequest = {
        messages: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
      };

      const stream = client.runTurn("sess-sig", request, controller.signal);
      try {
        for await (const _ of stream) {
        }
      } catch {
      }

      expect(capturedSignal).toBe(controller.signal);
    });
  });

  describe("HTTP error handling", () => {
    test("non-2xx status throws api_http_error", async () => {
      const fetch = createFakeFetch([{ status: 500 }]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      await expect(client.health()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiHttpError,
        message: "Local Agent API request failed.",
      });
    });

    test("404 throws api_http_error", async () => {
      const fetch = createFakeFetch([{ status: 404 }]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      await expect(client.getSession("sess-404")).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiHttpError,
      });
    });

    test("network error throws api_unavailable", async () => {
      const fetch = async () => {
        throw new Error("Network failure");
      };

      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      await expect(client.health()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiUnavailable,
        message: "Local Agent API is unavailable.",
      });
    });

    test("does not include original response body in error", async () => {
      const fetch = createFakeFetch([
        { status: 500, body: "Internal Server Error: DATABASE_SECRET_123" },
      ]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      try {
        await client.health();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).not.toContain("DATABASE_SECRET_123");
        expect(err.message).toBe("Local Agent API request failed.");
      }
    });

    test("does not include URL in error message", async () => {
      const fetch = createFakeFetch([{ status: 401 }]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      try {
        await client.health();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.message).not.toContain("127.0.0.1");
        expect(err.message).not.toContain("4317");
        expect(err.message).not.toContain("/health");
      }
    });
  });

  describe("response validation", () => {
    test("health response must be valid", async () => {
      const fetch = createFakeFetch([{ status: 200, body: "not json" }]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      await expect(client.health()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
        message: "Local Agent API returned invalid data.",
      });
    });

    test("session response must contain valid session", async () => {
      const fetch = createFakeFetch([{ status: 200, body: JSON.stringify({ invalid: true }) }]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      await expect(client.createSession()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });

    test("events response must be an array", async () => {
      const fetch = createFakeFetch([{ status: 200, body: JSON.stringify({ not: "array" }) }]);
      const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

      await expect(client.listEvents("sess-1")).rejects.toMatchObject({
        code: CLI_ERROR_CODES.apiProtocolError,
      });
    });
  });
});
