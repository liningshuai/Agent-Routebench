import { describe, test, expect, beforeEach, afterEach } from "vitest";

describe("Task 15: Desktop UI — Connect Button", () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); });
  afterEach(() => { if (container?.parentNode) container.parentNode.removeChild(container); });
  
  test("should render connect button when disconnected", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    mountDesktopUi(container, new FakeDesktopApiClient());
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Connect");
  });
  
  test("should trigger connection when connect button clicked", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(client.loadCalled).toBe(true);
  });
  
  test("should show loading state during connection", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.loadDelay = 100;
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 20)); // Wait for loading state to render
    expect(container.innerHTML).toContain("Connecting");
    await new Promise(r => setTimeout(r, 150));
  });
  
  test("should show connected state after successful connection", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    mountDesktopUi(container, new FakeDesktopApiClient());
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(container.innerHTML).toContain("Connected");
  });
  
  test("should show error message on connection failure", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.loadShouldFail = true;
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(container.innerHTML).toContain("Failed to connect to Desktop API");
  });
  
  test("should disable connect button during connection", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.loadDelay = 100;
    mountDesktopUi(container, client);
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 20)); // Wait for loading state to render
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn?.disabled).toBe(true);
    await new Promise(r => setTimeout(r, 150));
  });
  
  test("should allow reconnect after failure", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    const client = new FakeDesktopApiClient();
    client.loadShouldFail = true;
    mountDesktopUi(container, client);
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    client.loadShouldFail = false;
    client.loadCalled = false;
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(client.loadCalled).toBe(true);
    expect(container.innerHTML).toContain("Connected");
  });
  
  test("should not show session UI when disconnected", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    mountDesktopUi(container, new FakeDesktopApiClient());
    expect(container.innerHTML).not.toContain("New Session");
  });
  
  test("should show session UI when connected", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    mountDesktopUi(container, new FakeDesktopApiClient());
    await new Promise(r => setTimeout(r, 10)); // Wait for initial render
    container.querySelector("button")?.click();
    await new Promise(r => setTimeout(r, 50));
    expect(container.innerHTML).toContain("New Session");
  });
});
