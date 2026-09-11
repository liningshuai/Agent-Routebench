import { describe, test, expect } from "vitest";
import { escapeHtml, renderEventToHtml, createEventViewModel } from "../apps/desktop/src/view-model.js";
import type { AgentEvent } from "@agent-workbench/agent-core";

describe("Task 14: Desktop XSS — Extended Attack Vectors", () => {
  test("should escape SVG with script", () => {
    const input = '<svg onload="alert(1)">';
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;svg onload=&quot;alert(1)&quot;&gt;");
    expect(escaped).not.toContain("<svg");
  });

  test("should escape event handler attributes", () => {
    const input = '<img onerror="alert(1)" src="x">';
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;img onerror=&quot;alert(1)&quot; src=&quot;x&quot;&gt;");
    expect(escaped).not.toContain("<img");
  });

  test("should escape javascript: protocol", () => {
    const input = '<a href="javascript:alert(1)">click</a>';
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;");
    expect(escaped).not.toContain("<a href=");
  });

  test("should escape data: URI with script", () => {
    const input = '<iframe src="data:text/html,<script>alert(1)</script>">';
    const escaped = escapeHtml(input);
    expect(escaped).not.toContain("<iframe");
    expect(escaped).not.toContain("<script");
  });

  test("should escape HTML entities recursively", () => {
    const input = "&lt;script&gt;";
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&amp;lt;script&amp;gt;");
  });

  test("should escape newlines and special formatting", () => {
    const input = "<script>\nalert('XSS')\n</script>";
    const escaped = escapeHtml(input);
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("\n");
  });

  test("should escape unicode characters safely", () => {
    const input = "<script>alert('测试')</script>";
    const escaped = escapeHtml(input);
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("测试");
  });

  test("should escape mixed quotes", () => {
    const input = `<img src='x' onerror="alert('XSS')">`;
    const escaped = escapeHtml(input);
    expect(escaped).toContain("&#39;");
    expect(escaped).toContain("&quot;");
  });
});

describe("Task 14: Desktop XSS — Rendering Safety", () => {
  test("should render text_delta with XSS safely", () => {
    const event: AgentEvent = {
      type: "text_delta",
      requestId: "req_1",
      text: '<script>alert("XSS")</script>',
    };
    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("should render tool_call name with XSS safely", () => {
    const event: AgentEvent = {
      type: "tool_call",
      requestId: "req_1",
      id: "tool_1",
      name: '<img src=x onerror="alert(1)">',
      input: { malicious: "data" },
    };
    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("should render error message with XSS safely", () => {
    const event: AgentEvent = {
      type: "error",
      requestId: "req_1",
      code: "test_error",
      message: '<svg onload="alert(1)">',
      retryable: false,
    };
    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;svg");
  });

  test("should render thinking with XSS safely", () => {
    // Cast to AgentEvent to test unknown event type handling
    const event = {
      type: "thinking",
      requestId: "req_1",
      content: '<iframe src="javascript:alert(1)">',
    } as unknown as AgentEvent;
    const viewModel = createEventViewModel(event);
    const html = renderEventToHtml(viewModel);
    
    // thinking is not a recognized event type in current implementation
    // so it renders as "unknown" - verify it doesn't contain unescaped content
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Unknown event");
  });
});

describe("Task 14: Desktop XSS — Empty and Edge Cases", () => {
  test("should handle empty string", () => {
    const escaped = escapeHtml("");
    expect(escaped).toBe("");
  });

  test("should handle string with only special chars", () => {
    const input = "<>&\"'";
    const escaped = escapeHtml(input);
    expect(escaped).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  test("should handle very long XSS payload", () => {
    const input = "<script>" + "a".repeat(10000) + "</script>";
    const escaped = escapeHtml(input);
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped.length).toBeGreaterThan(10000);
  });

  test("should handle null bytes safely", () => {
    const input = "<script\0>alert(1)</script>";
    const escaped = escapeHtml(input);
    expect(escaped).toContain("&lt;script");
  });
});
