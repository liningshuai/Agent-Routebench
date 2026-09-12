import { describe, test, expect, beforeEach, afterEach } from "vitest";

/**
 * Task 15: Desktop UI — Cancel Interaction
 * 
 * Red tests for cancel button interaction. Tests verify that:
 * - Cancel button appears during streaming
 * - Cancel button triggers abort
 * - UI updates after cancel
 * - Multiple cancels are handled correctly
 */

describe("Task 15: Desktop UI — Cancel Button", () => {
  let container: HTMLElement;
  
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  
  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });
  
  test("should show cancel button during turn submission", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnDelay = 1000;
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
    const cancelBtn = container.querySelector(".cancel-btn");
    expect(cancelBtn).toBeTruthy();
  });
  
  test("should hide cancel button after turn completes", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnEvents = [
      { type: "text_delta", requestId: "req_15", text: "response" }
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
    await new Promise(r => setTimeout(r, 200));
    const cancelBtn = container.querySelector(".cancel-btn");
    expect(cancelBtn).toBeFalsy();
  });
  
  test("should call cancelTurn when cancel button is clicked", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnDelay = 2000;
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
    const cancelBtn = container.querySelector(".cancel-btn") as HTMLElement;
    cancelBtn?.click();
    await new Promise(r => setTimeout(r, 100));
    expect(client.cancelTurnCalled).toBe(true);
  });
  
  test("should disable send button during turn submission", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnDelay = 1000;
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
    const cancelBtn = container.querySelector(".cancel-btn");
    expect(cancelBtn).toBeTruthy();
    const sendBtnAfter = container.querySelector(".send-btn");
    expect(sendBtnAfter).toBeFalsy();
  });
  
  test("should re-enable send button after cancel", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnDelay = 500;
    const ui = mountDesktopUi(container, client);
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
    await new Promise(r => setTimeout(r, 50));
    const cancelBtn = container.querySelector(".cancel-btn") as HTMLElement;
    
    // Wait for cancel to complete via subscription
    const cancelPromise = new Promise<void>((resolve) => {
      const unsubscribe = ui.subscribe((state) => {
        if (!state.isSubmitting && state.draft === "test") {
          unsubscribe();
          resolve();
        }
      });
    });
    
    cancelBtn?.click();
    
    await Promise.race([
      cancelPromise,
      new Promise(r => setTimeout(r, 500))
    ]);
    
    const sendBtnAfter = container.querySelector(".send-btn") as HTMLButtonElement;
    expect(sendBtnAfter).toBeTruthy();
    // After cancel, draft is restored to "test", so send button should be enabled
    expect(sendBtnAfter.disabled).toBe(false);
  });
  
  test("should preserve draft text after cancel", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnDelay = 500;
    const draftText = "test message";
    const ui = mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const textarea = container.querySelector(".draft-input") as HTMLTextAreaElement;
    textarea.value = draftText;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    
    // Verify draft is in state before sending
    expect(ui.getState().draft).toBe(draftText);
    
    const sendBtn = container.querySelector(".send-btn") as HTMLElement;
    sendBtn?.click();
    
    // Wait for submission to start
    await new Promise(r => setTimeout(r, 50));
    
    // Cancel should be visible now
    const cancelBtn = container.querySelector(".cancel-btn") as HTMLElement;
    expect(cancelBtn).toBeTruthy();
    
    // Use promise to wait for cancel to complete
    const cancelPromise = new Promise<void>((resolve) => {
      const unsubscribe = ui.subscribe((state) => {
        if (!state.isSubmitting && state.draft === draftText) {
          unsubscribe();
          resolve();
        }
      });
    });
    
    cancelBtn?.click();
    
    // Wait for cancel to complete via subscription or timeout
    await Promise.race([
      cancelPromise,
      new Promise(r => setTimeout(r, 500))
    ]);
    
    // Final state check - isSubmitting should be false and draft should be restored
    const finalState = ui.getState();
    expect(finalState.isSubmitting).toBe(false);
    expect(finalState.draft).toBe(draftText);
  });
});
// @vitest-environment jsdom
