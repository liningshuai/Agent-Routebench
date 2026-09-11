import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("Task 15: Desktop UI — Session Interaction", () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(() => { if (container?.parentNode) container.parentNode.removeChild(container); });
  
  test("should render New Session button when connected", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(container.innerHTML).toContain("New Session");
  });
  
  test("should not render New Session button when disconnected", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    mountDesktopUi(container, new FakeDesktopApiClient());
    await new Promise(r => setTimeout(r, 10));
    expect(container.innerHTML).not.toContain("New Session");
  });
  
  test("should call apiClient.createSession when New Session clicked", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const buttons = Array.from(container.querySelectorAll("button"));
    const newSessionBtn = buttons.find(b => b.textContent?.includes("New Session"));
    expect(newSessionBtn).toBeDefined();
    expect(client.createSessionCalled).toBe(false);
    newSessionBtn?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(client.createSessionCalled).toBe(true);
  });
  
  test("should render empty session list when no sessions exist", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10));
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    const sessionList = container.querySelector(".session-list");
    expect(sessionList).toBeDefined();
    expect(sessionList?.children.length).toBe(0);
  });
  
  test("should render session in list after creation", async () => {
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
    const sessionList = container.querySelector(".session-list");
    expect(sessionList?.children.length).toBe(1);
  });
  
  test("should render session with session id visible", async () => {
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
    const sessionItem = container.querySelector(".session-item");
    expect(sessionItem).toBeDefined();
    expect(sessionItem?.textContent).toContain("sess_");
  });
  
  test("should mark selected session as active", async () => {
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
    const sessionItem = container.querySelector(".session-item") as HTMLElement;
    expect(sessionItem?.classList.contains("active")).toBe(true);
    sessionItem?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(sessionItem?.classList.contains("active")).toBe(true);
  });
  
  test("should auto-select newly created session", async () => {
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
    const sessionItem = container.querySelector(".session-item") as HTMLElement;
    expect(sessionItem?.classList.contains("active")).toBe(true);
  });
});
