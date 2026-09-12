import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("Task 15: Desktop UI — XSS Prevention", () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(() => { if (container?.parentNode) container.parentNode.removeChild(container); });
  
  test("should escape HTML in error messages", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.loadShouldFail = true;
    client.loadError = "<script>alert('xss')</script>";
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const html = container.innerHTML;
    expect(html).not.toContain("<script>");
    // Error is sanitized by controller - expect fixed message
    expect(html).toContain("Failed to connect to Desktop API");
  });
  
  test("should escape HTML in session IDs", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const html = container.innerHTML;
    expect(html).toContain("sess_");
    expect(html).not.toContain("<img");
  });
  
  test("should escape HTML in streaming text events", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnEvents = [
      {
        type: "text_delta",
        requestId: "req_15",
        text: "<img src=x onerror=alert(1)>",
      }
    ];
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const textarea = container.querySelector(".draft-input") as HTMLTextAreaElement;
    textarea.value = "test";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const sendBtn = container.querySelector(".send-btn") as HTMLElement;
    sendBtn?.click();
    await new Promise(r => setTimeout(r, 100));
    const html = container.innerHTML;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
  
  test("should not execute scripts in draft text", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const textarea = container.querySelector(".draft-input") as HTMLTextAreaElement;
    textarea.value = "<script>window.xssExecuted=true</script>";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    expect((window as any).xssExecuted).toBeUndefined();
  });
  
  test("should not render event handlers in session IDs", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const html = container.innerHTML;
    expect(html).not.toContain("onclick=");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("onload=");
  });
  
  test("should escape angle brackets in error messages", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.createSessionShouldFail = true;
    client.createSessionError = "Error: <invalid>";
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const html = container.innerHTML;
    // Error is sanitized by controller - expect fixed message
    expect(html).toContain("Failed to create session");
    expect(html).not.toContain("<invalid>");
  });
  
  test("should escape quotes in data attributes", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const sessionItems = container.querySelectorAll(".session-item");
    for (const item of sessionItems) {
      const sessionId = item.getAttribute("data-session-id");
      expect(sessionId).toBeDefined();
      expect(sessionId).not.toContain('"');
      expect(sessionId).not.toContain("'");
      expect(sessionId).not.toContain("<");
      expect(sessionId).not.toContain(">");
    }
  });
  
  test("should not allow javascript URLs in rendered content", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnEvents = [
      {
        type: "text_delta",
        requestId: "req_15",
        text: "javascript:alert(1)",
      }
    ];
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50))
;
    const textarea = container.querySelector(".draft-input") as HTMLTextAreaElement;
    textarea.value = "test";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const sendBtn = container.querySelector(".send-btn") as HTMLElement;
    sendBtn?.click();
    await new Promise(r => setTimeout(r, 100));
    const links = container.querySelectorAll("a[href^='javascript:']");
    expect(links.length).toBe(0);
  });
});
// @vitest-environment jsdom
