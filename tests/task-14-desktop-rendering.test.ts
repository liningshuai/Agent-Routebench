import { describe, test, expect } from "vitest";
import type { AgentEvent } from "@agent-workbench/agent-core";
import type { DesktopState } from "../apps/desktop/src/types.js";
import { escapeHtml } from "../apps/desktop/src/view-model.js";

// Import will fail until render.ts is created - this is the Red phase
import { renderDesktopPage } from "../apps/desktop/src/render.js";

describe("Task 14: Desktop Rendering — Red Phase", () => {
  test("should fail to import renderDesktopPage before implementation", () => {
    // This test documents the expected Red failure
    expect(typeof renderDesktopPage).toBe("function");
  });
});

describe("Task 14: Desktop Rendering — Basic Page Structure", () => {
  test("should render idle state", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("idle");
    expect(html).toContain("<div");
    expect(html).toContain("</div>");
  });

  test("should render loading state", () => {
    const state: DesktopState = {
      connection: "loading",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("loading");
  });

  test("should render ready state", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("ready");
  });

  test("should render failed state with error", () => {
    const state: DesktopState = {
      connection: "failed",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: "Connection failed",
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("failed");
    expect(html).toContain("Connection failed");
  });
});

describe("Task 14: Desktop Rendering — Session List", () => {
  test("should render empty session list", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("session");
  });

  test("should render sessions in order", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [
        { id: "sess_1", status: "idle" as const, createdAt: 1704067200000, updatedAt: 1704067200000 },
        { id: "sess_2", status: "idle" as const, createdAt: 1704153600000, updatedAt: 1704153600000 },
      ],
      activeSessionId: "sess_1",
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("sess_1");
    expect(html).toContain("sess_2");
    const sess1Pos = html.indexOf("sess_1");
    const sess2Pos = html.indexOf("sess_2");
    expect(sess1Pos).toBeLessThan(sess2Pos);
  });

  test("should indicate active session", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [
        { id: "sess_1", status: "idle" as const, createdAt: 1704067200000, updatedAt: 1704067200000 },
        { id: "sess_2", status: "idle" as const, createdAt: 1704153600000, updatedAt: 1704153600000 },
      ],
      activeSessionId: "sess_2",
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("sess_2");
  });
});

describe("Task 14: Desktop Rendering — Transcript", () => {
  test("should render text_delta events", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "text_delta",
          requestId: "req_1",
          text: "Hello, world!",
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("Hello, world!");
  });

  test("should render tool_call events without input", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "tool_call",
          requestId: "req_1",
          id: "tool_1",
          name: "test_tool",
          input: { secret: "should_not_appear" },
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("test_tool");
    expect(html).not.toContain("should_not_appear");
    expect(html).not.toContain("secret");
  });

  test("should render usage events", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "usage",
          requestId: "req_1",
          inputTokens: 100,
          outputTokens: 50,
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("100");
    expect(html).toContain("50");
  });

  test("should render completed events", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "completed",
          requestId: "req_1",
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("completed");
  });

  test("should render error events", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "error",
          requestId: "req_1",
          code: "upstream_unavailable",
          message: "Model gateway request failed.",
          retryable: true,
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("error");
    expect(html).toContain("Model gateway request failed.");
  });
});

describe("Task 14: Desktop Rendering — Draft Input", () => {
  test("should render empty draft", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("draft");
  });

  test("should render draft text", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [],
      draft: "Hello, this is my draft message",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).toContain("Hello, this is my draft message");
  });
});

describe("Task 14: Desktop Rendering — XSS Prevention", () => {
  test("should escape <script> tags in draft", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [],
      draft: '<script>alert("XSS")</script>',
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("should escape <img onerror> in text_delta", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "text_delta",
          requestId: "req_1",
          text: '<img src=x onerror="alert(1)">',
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
  });

  test("should escape javascript: URLs", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "text_delta",
          requestId: "req_1",
          text: '<a href="javascript:alert(1)">click</a>',
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;a");
  });

  test("should escape special characters in error messages", () => {
    const state: DesktopState = {
      connection: "failed",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: '<svg onload="alert(1)">',
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg");
  });

  test("should not generate event attributes", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "text_delta",
          requestId: "req_1",
          text: "normal text",
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toMatch(/onclick\s*=/i);
    expect(html).not.toMatch(/onload\s*=/i);
    expect(html).not.toMatch(/onerror\s*=/i);
  });
});

describe("Task 14: Desktop Rendering — Security Boundaries", () => {
  test("should not expose tool_call.input", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: "sess_1",
      events: [
        {
          type: "tool_call",
          requestId: "req_1",
          id: "tool_1",
          name: "fetch_data",
          input: {
            apiKey: "secret_key_12345",
            password: "my_password",
            token: "bearer_token_xyz",
          },
        },
      ],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain("secret_key_12345");
    expect(html).not.toContain("my_password");
    expect(html).not.toContain("bearer_token_xyz");
    expect(html).not.toContain("apiKey");
  });

  test("should not expose Provider URLs", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain("https://api.openai.com");
    expect(html).not.toContain("https://api.anthropic.com");
    expect(html).not.toContain("/v1/chat/completions");
  });

  test("should not expose credentialRef", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain("credentialRef");
    expect(html).not.toContain("credential_");
  });

  test("should not expose Authorization headers", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toContain("Authorization:");
    expect(html).not.toContain("Bearer ");
  });

  test("should not expose tokens or secrets", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toMatch(/sk-[a-zA-Z0-9]{32,}/); // OpenAI-style keys
    expect(html).not.toMatch(/token["\s]*[:=]["\s]*[a-zA-Z0-9_-]{20,}/i);
  });
});

describe("Task 14: Desktop Rendering — External Content", () => {
  test("should not contain external URLs", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    expect(html).not.toMatch(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(html).not.toContain("cdn.");
  });

  test("should only reference local resources", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };

    const html = renderDesktopPage(state);
    if (html.includes("href=") || html.includes("src=")) {
      expect(html).toMatch(/(?:href|src)=["'](?:\.\/|\.\.|\/)[^"']*["']/);
    }
  });
});

describe("Task 14: Desktop Rendering — Determinism", () => {
  test("should produce identical output for same input", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [
        { id: "sess_1", status: "idle" as const, createdAt: 1704067200000, updatedAt: 1704067200000 },
      ],
      activeSessionId: "sess_1",
      events: [
        {
          type: "text_delta",
          requestId: "req_1",
          text: "Hello",
        },
      ],
      draft: "Test draft",
      error: null,
    };

    const html1 = renderDesktopPage(state);
    const html2 = renderDesktopPage(state);
    expect(html1).toBe(html2);
  });

  test("should not mutate input state", () => {
    const state: DesktopState = {
      connection: "ready",
      sessions: [
        { id: "sess_1", status: "idle" as const, createdAt: 1704067200000, updatedAt: 1704067200000 },
      ],
      activeSessionId: "sess_1",
      events: [
        {
          type: "text_delta",
          requestId: "req_1",
          text: "Hello",
        },
      ],
      draft: "Test",
      error: null,
    };

    const stateBefore = JSON.stringify(state);
    renderDesktopPage(state);
    const stateAfter = JSON.stringify(state);
    expect(stateAfter).toBe(stateBefore);
  });
});
