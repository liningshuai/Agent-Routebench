// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeDesktopApiClient } from "./helpers/desktop-fixtures.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(testDir);

describe("Task 15: Desktop browser entry", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  test("public index loads the compiled browser entry", () => {
    const html = readFileSync(
      join(appRoot, "apps/desktop/public/index.html"),
      "utf8",
    );

    expect(html).toContain(
      '<script type="module" src="../dist/browser-entry.js"></script>',
    );
  });

  test("browser bootstrap mounts the injected DesktopApiClient", async () => {
    const { bootstrapDesktopUi } = await import(
      "../apps/desktop/src/browser-entry.js"
    );
    const client = new FakeDesktopApiClient();

    const ui = bootstrapDesktopUi(container, client);

    expect(container.querySelector(".desktop-ui")).not.toBeNull();
    expect(ui.getState().connection).toBe("idle");
    ui.unmount();
  });
});
