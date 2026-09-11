import { describe, test, expect } from "vitest";
import type { AgentEvent } from "@agent-workbench/agent-core";
import {
  escapeHtml,
  createEventViewModel,
  renderEventToHtml,
} from "../apps/desktop/src/view-model.js";

describe("Task 14: Desktop Security — XSS Prevention", () => {
  test("should not allow innerHTML injection", () => {
    const maliciousText = '<script>alert("XSS")</script>';
    const escaped = escapeHtml(maliciousText);
    expect(escaped).toBe("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;");
  });

  test("should escape < > & \" ' characters", () => {
    const input = '<div class="test">A & B</div>';
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;div class=&quot;test&quot;&gt;A &amp; B&lt;/div&gt;");
  });

  test("should handle empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("should handle string with no special characters", () => {
    expect(escapeHtml("Hello world")).toBe("Hello world");
  });

  test("should escape single quote", () => {
    expect(escapeHtml("It's here")).toBe("It&#39;s here");
  });
});

describe("Task 14: Desktop Security — Credential Isolation", () => {
  test("should not include tool_call.input in ViewModel", () => {
    const event: AgentEvent = {
      type: "tool_call",
      requestId: "req_1",
      id: "call_1",
      name: "sensitive_tool",
      input: {
        apiKey: "secret_key_12345",
        password: "my_password",
      },
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.type).toBe("tool_call");
    expect(viewModel.name).toBe("sensitive_tool");
    expect("input" in viewModel).toBe(false);
    expect(JSON.stringify(viewModel)).not.toContain("secret_key_12345");
    expect(JSON.stringify(viewModel)).not.toContain("my_password");
  });

  test("should not expose provider URLs", () => {
    const event: AgentEvent = {
      type: "error",
      requestId: "req_1",
      code: "upstream_unavailable",
      message: "Model gateway request failed.",
      retryable: true,
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.message).toBe("Model gateway request failed.");
    expect(viewModel.message).not.toContain("http");
    expect(viewModel.message).not.toContain("Bearer");
  });

  test("should use fixed error message for text_delta", () => {
    const event: AgentEvent = {
      type: "text_delta",
      requestId: "req_1",
      text: "Hello world",
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.type).toBe("text_delta");
    expect(viewModel.text).toBe("Hello world");
  });

  test("should not include usage token counts in ViewModel", () => {
    const event: AgentEvent = {
      type: "usage",
      requestId: "req_1",
      inputTokens: 100,
      outputTokens: 50,
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.type).toBe("usage");
    // Usage can be included but must not leak provider-specific details
    expect(viewModel.inputTokens).toBe(100);
    expect(viewModel.outputTokens).toBe(50);
  });
});

describe("Task 14: Desktop Security — Route Selection", () => {
  test("should not expose model or routeId", () => {
    const event: AgentEvent = {
      type: "route_selected",
      requestId: "req_1",
      routeId: "internal_route_123",
      model: "provider/secret-model-v1",
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.type).toBe("route_selected");
    expect("routeId" in viewModel).toBe(false);
    expect("model" in viewModel).toBe(false);
  });
});

describe("Task 14: Desktop Security — Error Messages", () => {
  test("should use fixed error message", () => {
    const event: AgentEvent = {
      type: "error",
      requestId: "req_1",
      code: "gateway_error",
      message: "Model gateway request failed.",
      retryable: false,
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.message).toBe("Model gateway request failed.");
  });

  test("should not expose error codes beyond safe set", () => {
    const event: AgentEvent = {
      type: "error",
      requestId: "req_1",
      code: "rate_limited",
      message: "Model gateway request failed.",
      retryable: true,
    };

    const viewModel = createEventViewModel(event);
    expect(viewModel.code).toBe("rate_limited");
  });
});

describe("Task 14: Desktop Rendering — HTML Generation", () => {
  test("should render text_delta with escaped HTML", () => {
    const event: AgentEvent = {
      type: "text_delta",
      requestId: "req_1",
      text: '<script>alert("XSS")</script>',
    };

    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  test("should render tool_call without input", () => {
    const event: AgentEvent = {
      type: "tool_call",
      requestId: "req_1",
      id: "call_1",
      name: "test_tool",
      input: { secret: "hidden" },
    };

    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    expect(html).toContain("test_tool");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("hidden");
  });

  test("should render error with escaped message", () => {
    const event: AgentEvent = {
      type: "error",
      requestId: "req_1",
      code: "gateway_error",
      message: "Failed: <details>",
      retryable: false,
    };

    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    expect(html).toContain("&lt;details&gt;");
    expect(html).not.toContain("<details>");
  });

  test("should render usage with token counts", () => {
    const event: AgentEvent = {
      type: "usage",
      requestId: "req_1",
      inputTokens: 100,
      outputTokens: 50,
    };

    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    expect(html).toContain("100 in");
    expect(html).toContain("50 out");
  });

  test("should render completed event", () => {
    const event: AgentEvent = {
      type: "completed",
      requestId: "req_1",
    };

    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    expect(html).toContain("Completed");
  });

  test("should render route_selected without details", () => {
    const event: AgentEvent = {
      type: "route_selected",
      requestId: "req_1",
      routeId: "internal_route",
      model: "secret-model",
    };

    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    expect(html).toContain("Route selected");
    expect(html).not.toContain("internal_route");
    expect(html).not.toContain("secret-model");
  });
});
