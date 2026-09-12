import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { DesktopUi } from "../apps/desktop/src/ui.js";

/**
 * Task 15: Desktop UI — Mount and Unmount
 * 
 * Red tests for interactive Desktop UI mounting, unmounting, and lifecycle.
 * Tests verify that the UI can be mounted to a DOM container, renders initial
 * state, and can be cleanly unmounted.
 */

describe("Task 15: Desktop UI — Mount", () => {
  let container: HTMLElement;
  
  beforeEach(() => {
    container = document.createElement("div");
    container.id = "desktop-ui-test-container";
    document.body.appendChild(container);
  });
  
  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });
  
  test("should mount to DOM container", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    
    expect(ui).toBeDefined();
    expect(container.children.length).toBeGreaterThan(0);
  });
  
  test("should render initial disconnected state", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client = new FakeDesktopApiClient();
    mountDesktopUi(container, client);
    
    // Should show connect button (initial state is "idle")
    const html = container.innerHTML;
    expect(html).toContain("Connect");
    const button = container.querySelector("button");
    expect(button).toBeDefined();
  });
  
  test("should throw when mounting to null container", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client = new FakeDesktopApiClient();
    // @ts-expect-error - intentionally passing null
    expect(() => mountDesktopUi(null, client)).toThrow();
  });
  
  test("should throw when mounting with null client", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    
    // @ts-expect-error - intentionally passing null
    expect(() => mountDesktopUi(container, null)).toThrow();
  });
  
  test("should unmount and clean up DOM", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    
    expect(container.children.length).toBeGreaterThan(0);
    
    ui.unmount();
    
    expect(container.children.length).toBe(0);
  });
  
  test("should not throw on double unmount", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    
    ui.unmount();
    expect(() => ui.unmount()).not.toThrow();
  });
  
  test("should return DesktopUi interface", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);
    
    // Verify interface methods exist
    expect(typeof ui.unmount).toBe("function");
    expect(typeof ui.getState).toBe("function");
    expect(typeof ui.subscribe).toBe("function");
  });
});

describe("Task 15: Desktop UI — Multiple Instances", () => {
  let container1: HTMLElement;
  let container2: HTMLElement;
  
  beforeEach(() => {
    container1 = document.createElement("div");
    container1.id = "desktop-ui-test-container-1";
    document.body.appendChild(container1);
    
    container2 = document.createElement("div");
    container2.id = "desktop-ui-test-container-2";
    document.body.appendChild(container2);
  });
  
  afterEach(() => {
    if (container1 && container1.parentNode) {
      container1.parentNode.removeChild(container1);
    }
    if (container2 && container2.parentNode) {
      container2.parentNode.removeChild(container2);
    }
  });
  
  test("should support multiple independent instances", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client1 = new FakeDesktopApiClient();
    const client2 = new FakeDesktopApiClient();
    
    const ui1 = mountDesktopUi(container1, client1);
    const ui2 = mountDesktopUi(container2, client2);
    
    expect(ui1).not.toBe(ui2);
    expect(container1.children.length).toBeGreaterThan(0);
    expect(container2.children.length).toBeGreaterThan(0);
  });
  
  test("should unmount instances independently", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const { FakeDesktopApiClient } = await import("./helpers/desktop-fixtures.js");
    
    const client1 = new FakeDesktopApiClient();
    const client2 = new FakeDesktopApiClient();
    
    const ui1 = mountDesktopUi(container1, client1);
    const ui2 = mountDesktopUi(container2, client2);
    
    ui1.unmount();
    
    expect(container1.children.length).toBe(0);
    expect(container2.children.length).toBeGreaterThan(0);
    
    ui2.unmount();
    expect(container2.children.length).toBe(0);
  });
});
// @vitest-environment jsdom
