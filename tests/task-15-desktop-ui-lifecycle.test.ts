// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeDesktopApiClient } from "./helpers/desktop-fixtures.js";

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Task 15: Desktop UI lifecycle and session selection", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  test("clicking a session changes the active session", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const client = new FakeDesktopApiClient();
    const ui = mountDesktopUi(container, client);

    container.querySelector(".connect-btn")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await waitFor(0);
    container.querySelector(".new-session-btn")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await waitFor(0);
    container.querySelector(".new-session-btn")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await waitFor(0);

    const items = Array.from(
      container.querySelectorAll<HTMLElement>(".session-item"),
    );
    expect(items).toHaveLength(2);
    expect(ui.getState().activeSessionId).toBe("sess_2");

    items[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(ui.getState().activeSessionId).toBe("sess_1");
    const refreshedItems = Array.from(
      container.querySelectorAll<HTMLElement>(".session-item"),
    );
    expect(refreshedItems[0].classList.contains("active")).toBe(true);
    expect(refreshedItems[1].classList.contains("active")).toBe(false);
  });

  test("unmount prevents a late turn completion from rendering into the container", async () => {
    const { mountDesktopUi } = await import("../apps/desktop/src/ui.js");
    const client = new FakeDesktopApiClient();
    client.submitTurnDelay = 25;
    const ui = mountDesktopUi(container, client);

    container.querySelector(".connect-btn")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await waitFor(0);
    container.querySelector(".new-session-btn")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await waitFor(0);

    const draft = container.querySelector<HTMLTextAreaElement>(".draft-input");
    expect(draft).not.toBeNull();
    draft!.value = "late result";
    draft!.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(0);
    container.querySelector(".send-btn")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await waitFor(1);

    ui.unmount();
    expect(container.innerHTML).toBe("");

    await waitFor(50);

    expect(container.innerHTML).toBe("");
  });
});
