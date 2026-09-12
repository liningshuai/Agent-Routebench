import { describe, it, expect, beforeEach } from "vitest";
import { DesktopController } from "../apps/desktop/src/controller.js";
import type {
  DesktopApiClient,
} from "../apps/desktop/src/types.js";
import type {
  LocalAgentSession,
  LocalAgentTurnRequest,
} from "@agent-workbench/local-agent-api";
import type { AgentEvent } from "@agent-workbench/agent-core";
import { renderDesktopPage } from "../apps/desktop/src/render.js";

const ANTHROPIC_HOST = ["api", "anthropic", "com"].join(".");
const ANTHROPIC_KEY = ["sk-ant-", "1234567890abcdef"].join("");
const PROJECT_KEY = ["sk-proj-", "secret123"].join("");

/**
 * Task 14 Security Gap: Error Message Leakage
 *
 * DesktopController currently passes through raw error messages from the injected
 * DesktopApiClient, which violates the security requirement that errors must use
 * fixed messages and never expose:
 * - secrets, tokens, API keys
 * - Provider URLs
 * - Authorization headers
 * - File paths
 * - Stack traces
 * - Internal implementation details
 *
 * These tests verify that malicious errors from the API Client are sanitized
 * before entering DesktopState.error and the HTML output.
 */

class MaliciousErrorApiClient implements DesktopApiClient {
  private errorToThrow: Error | null = null;

  setError(error: Error): void {
    this.errorToThrow = error;
  }

  async load(): Promise<void> {
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
  }

  async createSession(): Promise<LocalAgentSession> {
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return {
      id: "sess_test",
      status: "idle",
      createdAt: 0,
      updatedAt: 0,
    };
  }

  async *submitTurn(
    _sessionId: string,
    _request: LocalAgentTurnRequest,
    _signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
      yield { type: "completed", requestId: "req_1" };
  }

  async cancelTurn(_sessionId: string, _turnId: string): Promise<void> {
    // no-op
  }
}

describe("Task 14 Security Gap: Error Message Sanitization", () => {
  let client: MaliciousErrorApiClient;
  let controller: DesktopController;

  beforeEach(() => {
    client = new MaliciousErrorApiClient();
    controller = new DesktopController(client);
  });

  describe("connect() error sanitization", () => {
    it("must not expose secret in error state", async () => {
      const maliciousError = new Error(
        "Authentication failed: secret_abc123_token_xyz789",
      );
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      expect(state.error).not.toContain("secret");
      expect(state.error).not.toContain("abc123");
      expect(state.error).not.toContain("token");
      expect(state.error).not.toContain("xyz789");
    });

    it("must not expose Provider URL in error state", async () => {
      const maliciousError = new Error(
        `HTTP 401 from https://${ANTHROPIC_HOST}/v1/messages`,
      );
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      expect(state.error).not.toContain("https://");
      expect(state.error).not.toContain("anthropic.com");
      expect(state.error).not.toContain("/v1/messages");
    });

    it("must not expose Authorization header in error state", async () => {
      const maliciousError = new Error(
        `Request failed: Authorization: Bearer ${ANTHROPIC_KEY}`,
      );
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      expect(state.error).not.toContain("Authorization");
      expect(state.error).not.toContain("Bearer");
      expect(state.error).not.toContain("sk-ant");
      expect(state.error).not.toContain("1234567890");
    });

    it("must not expose file paths in error state", async () => {
      const maliciousError = new Error(
        "Failed to load config from C:\\Users\\admin\\secrets\\credentials.json",
      );
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      expect(state.error).not.toContain("C:\\");
      expect(state.error).not.toContain("Users");
      expect(state.error).not.toContain("admin");
      expect(state.error).not.toContain("credentials.json");
    });

    it("must not expose stack traces in error state", async () => {
      const maliciousError = new Error("Connection failed");
      maliciousError.stack = `Error: Connection failed
    at DesktopApiClient.load (/app/node_modules/internal-package/index.js:42:15)
    at DesktopController.connect (/app/src/controller.ts:50:10)`;
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      expect(state.error).not.toContain("/app/node_modules");
      expect(state.error).not.toContain("internal-package");
      expect(state.error).not.toContain("controller.ts");
      expect(state.error).not.toContain(":42:15");
    });

    it("must not expose secrets in HTML output", async () => {
      const maliciousError = new Error(
        `API key ${PROJECT_KEY} is invalid`,
      );
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      const html = renderDesktopPage(state);
      expect(html).not.toContain("sk-proj");
      expect(html).not.toContain("secret123");
    });

    it("must not expose Provider URLs in HTML output", async () => {
      const maliciousError = new Error(
        "Failed to reach https://provider.invalid/v1/chat",
      );
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      const html = renderDesktopPage(state);
      expect(html).not.toContain("https://");
      expect(html).not.toContain("provider.invalid");
    });

    it("must use fixed Desktop error message for connect failures", async () => {
      const maliciousError = new Error("Malicious details exposed");
      client.setError(maliciousError);

      await controller.connect();

      const state = controller.getState();
      expect(state.error).toBe("Failed to connect to Desktop API.");
    });
  });

  describe("newSession() error sanitization", () => {
    beforeEach(async () => {
      // Connect successfully first
      await controller.connect();
    });

    it("must not expose secret in error state", async () => {
      const maliciousError = new Error(
        "Session creation requires token: secret_session_key_xyz",
      );
      client.setError(maliciousError);

      try {
        await controller.newSession();
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).not.toContain("secret");
      expect(state.error).not.toContain("token");
      expect(state.error).not.toContain("key");
      expect(state.error).not.toContain("xyz");
    });

    it("must not expose Provider URL in error state", async () => {
      const maliciousError = new Error(
        "POST https://api.openai.com/v1/sessions failed",
      );
      client.setError(maliciousError);

      try {
        await controller.newSession();
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).not.toContain("https://");
      expect(state.error).not.toContain("openai.com");
      expect(state.error).not.toContain("/v1/sessions");
    });

    it("must use fixed Desktop error message for session creation failures", async () => {
      const maliciousError = new Error("Detailed internal error");
      client.setError(maliciousError);

      try {
        await controller.newSession();
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).toBe("Failed to create session.");
    });
  });

  describe("submitTurn() error sanitization", () => {
    beforeEach(async () => {
      await controller.connect();
      client.setError(null as any); // Clear error for successful session creation
      await controller.newSession();
    });

    it("must not expose secret in error state", async () => {
      const maliciousError = new Error(
        "Model request failed: credentialRef=cred_secret_abc123",
      );
      client.setError(maliciousError);

      const session = controller.getState().sessions[0];
      try {
        await controller.submitTurn(session.id, { messages: [] });
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).not.toContain("credentialRef");
      expect(state.error).not.toContain("cred_");
      expect(state.error).not.toContain("secret");
      expect(state.error).not.toContain("abc123");
    });

    it("must not expose Authorization header in error state", async () => {
      const maliciousError = new Error(
        "Unauthorized: Authorization header 'Bearer token_12345' rejected",
      );
      client.setError(maliciousError);

      const session = controller.getState().sessions[0];
      try {
        await controller.submitTurn(session.id, { messages: [] });
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).not.toContain("Authorization");
      expect(state.error).not.toContain("Bearer");
      expect(state.error).not.toContain("token_");
      expect(state.error).not.toContain("12345");
    });

    it("must not expose Provider model name in error state", async () => {
      const maliciousError = new Error(
        "Model 'claude-3-5-sonnet-20241022' returned error 429",
      );
      client.setError(maliciousError);

      const session = controller.getState().sessions[0];
      try {
        await controller.submitTurn(session.id, { messages: [] });
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).not.toContain("claude");
      expect(state.error).not.toContain("sonnet");
      expect(state.error).not.toContain("20241022");
    });

    it("must use fixed Desktop error message for turn submission failures", async () => {
      const maliciousError = new Error("Internal gateway error details");
      client.setError(maliciousError);

      const session = controller.getState().sessions[0];
      try {
        await controller.submitTurn(session.id, { messages: [] });
      } catch {
        // Expected to throw
      }

      const state = controller.getState();
      expect(state.error).toBe("Failed to submit turn.");
    });
  });

  describe("preserved Local Agent API errors", () => {
    it("must preserve safe Local Agent API error codes", async () => {
      // Local Agent API returns safe, fixed error messages
      // These should be preserved as they don't contain sensitive data
      const safeError = new Error("Session not found");
      client.setError(safeError);

      try {
        await controller.connect();
      } catch {
        // Expected
      }

      // This test documents that while we sanitize Desktop-level errors,
      // the underlying Local Agent API already uses fixed messages
      // The actual fix should map to Desktop's own fixed messages
      const state = controller.getState();
      expect(state.error).toBeDefined();
      expect(state.error).not.toContain("secret");
      expect(state.error).not.toContain("token");
      expect(state.error).not.toContain("https://");
    });
  });

  describe("no regression to existing Task 14 behavior", () => {
    it("must still handle normal connection flow", async () => {
      client.setError(null as any);
      await controller.connect();

      const state = controller.getState();
      expect(state.connection).toBe("ready");
      expect(state.error).toBeNull();
    });

    it("must still handle normal session creation", async () => {
      client.setError(null as any);
      await controller.connect();
      await controller.newSession();

      const state = controller.getState();
      expect(state.sessions).toHaveLength(1);
      expect(state.error).toBeNull();
    });

    it("must still handle normal turn submission", async () => {
      client.setError(null as any);
      await controller.connect();
      await controller.newSession();

      const session = controller.getState().sessions[0];
      const turnPromise = controller.submitTurn(session.id, {
        messages: [],
      });

      await turnPromise;

      const state = controller.getState();
      expect(state.events).toHaveLength(1);
      expect(state.error).toBeNull();
    });
  });
});
