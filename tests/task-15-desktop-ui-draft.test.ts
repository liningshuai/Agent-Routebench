import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("Task 15: Desktop UI — Draft and Send Interaction", () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(() => { if (container?.parentNode) container.parentNode.removeChild(container); });
  
  test("should render draft textarea when session is active", async () => {
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
    const textarea = container.querySelector(".draft-input");
    expect(textarea).toBeDefined();
  });
  
  test("should not render draft textarea when no session is active", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const textarea = container.querySelector(".draft-input");
    expect(textarea).toBeNull();
  });
  
  test("should update draft state when typing in textarea", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const textarea = container.querySelector(".draft-input") as HTMLTextAreaElement;
    textarea.value = "hello world";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const state = ui.getState();
    expect(state.draft).toBe("hello world");
  });
  
  test("should render Send button when session is not streaming", async () => {
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
    const sendBtn = container.querySelector(".send-btn");
    expect(sendBtn).toBeDefined();
    expect(sendBtn?.textContent).toContain("Send");
  });
  
  test("should call submitTurn when Send button is clicked", async () => {
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
    textarea.value = "test message";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const sendBtn = container.querySelector(".send-btn") as HTMLElement;
    expect(client.submitTurnCalled).toBe(false);
    sendBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(client.submitTurnCalled).toBe(true);
  });
});
// @vitest-environment jsdom
