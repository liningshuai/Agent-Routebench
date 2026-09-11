import { describe, test, expect, beforeEach, afterEach } from "vitest";

/**
 * Task 15: Desktop UI — Subscription Mechanism
 * 
 * Red tests for the subscription/observer pattern. Tests verify that:
 * - External observers can subscribe to state changes
 * - Subscribers receive notifications on state updates
 * - Multiple subscribers are supported
 * - Unsubscribe prevents further notifications
 * - Subscribers receive correct state data
 */

describe("Task 15: Desktop UI — Subscribe", () => {
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
  
  test("should allow external observers to subscribe", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    let callCount = 0;
    ui.subscribe(() => callCount++);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBeGreaterThan(0);
  });
  
  test("should notify subscriber on connection state change", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    const states: string[] = [];
    ui.subscribe((state) => states.push(state.connection));
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(states).toContain("loading");
    expect(states).toContain("ready");
  });
  
  test("should support multiple subscribers", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    let count1 = 0;
    let count2 = 0;
    ui.subscribe(() => count1++);
    ui.subscribe(() => count2++);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(count1).toBeGreaterThan(0);
    expect(count2).toBeGreaterThan(0);
    expect(count1).toBe(count2);
  });
  
  test("should stop notifying after unsubscribe", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    let callCount = 0;
    const unsubscribe = ui.subscribe(() => callCount++);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const countAfterFirst = callCount;
    unsubscribe();
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(countAfterFirst);
  });
  
  test("should receive session data in subscriber callback", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    let sessionId: string | undefined;
    ui.subscribe((state) => {
      if (state.activeSessionId) {
        sessionId = state.activeSessionId;
      }
    });
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^sess_/);
  });
  
  test("should receive error state in subscriber callback", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.loadShouldFail = true;
    const ui = mountDesktopUi(container, client);
    let errorMessage: string | undefined;
    ui.subscribe((state) => {
      if (state.error) {
        errorMessage = state.error;
      }
    });
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toContain("Failed to connect");
  });
  
  test("should receive draft text in subscriber callback", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    let draftText: string | undefined;
    ui.subscribe((state) => {
      if (state.draft) {
        draftText = state.draft;
      }
    });
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    const textarea = container.querySelector(".draft-input") as HTMLTextAreaElement;
    textarea.value = "test draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    expect(draftText).toBe("test draft");
  });
  
  test("should not expose internal controller state directly", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    let receivedState: any;
    ui.subscribe((state) => {
      receivedState = state;
    });
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(receivedState).toBeTruthy();
    // State should not have internal methods or private data
    expect(typeof receivedState.setState).toBe("undefined");
    expect(typeof receivedState.connect).toBe("undefined");
    expect(typeof receivedState.newSession).toBe("undefined");
  });
});
