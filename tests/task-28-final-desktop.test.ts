// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { mountDesktopUi } from "../apps/desktop/src/ui.js";
import type { DesktopUi } from "../apps/desktop/src/ui.js";
import { renderDesktopPage } from "../apps/desktop/src/render.js";
import { escapeHtml } from "../apps/desktop/src/view-model.js";
import type { DesktopApiClient } from "../apps/desktop/src/types.js";
import type { DesktopConfigApiClient } from "../apps/desktop/src/config-client.js";
import type { AgentEvent } from "../packages/agent-core/src/index.js";
import type { PersistedConfigV1 } from "../packages/local-persistence/src/index.js";
import { FakeDesktopApiClient } from "./helpers/desktop-fixtures.js";

/* ------------------------------------------------------------------ *
 * Task 28 — final Desktop UI acceptance.
 * ------------------------------------------------------------------ */

const XSS = `<img src=x onerror="alert('pwned')">`;

function session(id: string) {
  return { id, status: "idle" as const, createdAt: 1, updatedAt: 1 };
}

const provider = {
  id: "provider-one",
  name: "Provider One",
  protocol: "openai_compatible" as const,
  baseUrl: "https://api.example.invalid/v1",
  credentialRef: "credential:provider-one",
  models: ["model-one"],
  enabled: true,
};

const route = {
  id: "route-one",
  name: "Route One",
  providerId: "provider-one",
  model: "model-one",
  enabled: true,
};

class FakeConfigClient implements DesktopConfigApiClient {
  public snapshot: PersistedConfigV1 = { version: 1, providers: [provider], routes: [route] };
  public getConfigCalls = 0;
  public shouldFail = false;
  public created: unknown[] = [];
  public updated: unknown[] = [];
  public deleted: string[] = [];

  async getConfig(): Promise<PersistedConfigV1> {
    this.getConfigCalls += 1;
    if (this.shouldFail) {
      throw new Error("boom");
    }
    return structuredClone(this.snapshot);
  }
  async createProvider(input: unknown) {
    this.created.push(input);
    return input as never;
  }
  async updateProvider(input: unknown) {
    this.updated.push(input);
    return input as never;
  }
  async deleteProvider(providerId: string): Promise<void> {
    this.deleted.push(providerId);
  }
  async createRoute(input: unknown) {
    this.created.push(input);
    return input as never;
  }
  async updateRoute(input: unknown) {
    this.updated.push(input);
    return input as never;
  }
  async deleteRoute(routeId: string): Promise<void> {
    this.deleted.push(routeId);
  }
}

let container: HTMLElement;
let ui: DesktopUi | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  ui?.unmount();
  ui = undefined;
  container.remove();
});

function client(): FakeDesktopApiClient {
  return new FakeDesktopApiClient();
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountWithConfig(
  apiClient: FakeDesktopApiClient,
  configClient: FakeConfigClient,
): Promise<FakeConfigClient> {
  ui = mountDesktopUi(container, apiClient as unknown as DesktopApiClient, configClient);
  container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
  await flush();
  return configClient;
}

describe("Task 28 final Desktop: session surface", () => {
  it("shows the current session after it is created", async () => {
    const api = client();
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();

    expect(container.querySelectorAll(".session-item").length).toBe(1);
    expect(container.querySelector(".session-item")?.textContent).toBe("sess_1");
  });

  it("disables Send while the draft is empty and enables it afterwards", async () => {
    const api = client();
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();

    expect(container.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBe(true);

    const textarea = container.querySelector<HTMLTextAreaElement>(".draft-input");
    textarea!.value = "hello";
    textarea!.dispatchEvent(new Event("input"));
    await flush();
    expect(container.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBe(false);
  });

  it("shows Cancel and hides Send while a turn is in flight", async () => {
    const api = client();
    api.submitTurnDelay = 50;
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();

    const textarea = container.querySelector<HTMLTextAreaElement>(".draft-input");
    textarea!.value = "hello";
    textarea!.dispatchEvent(new Event("input"));
    await flush();
    container.querySelector<HTMLButtonElement>(".send-btn")?.click();
    await flush();

    expect(container.querySelector(".cancel-btn")).not.toBeNull();
    expect(container.querySelector(".send-btn")).toBeNull();
  });

  it("keeps the draft after the turn is cancelled", async () => {
    const api = client();
    api.submitTurnDelay = 50;
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();

    const textarea = container.querySelector<HTMLTextAreaElement>(".draft-input");
    textarea!.value = "keep me";
    textarea!.dispatchEvent(new Event("input"));
    await flush();
    container.querySelector<HTMLButtonElement>(".send-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".cancel-btn")?.click();
    // The fake client only settles its delayed turn after 50ms.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush();

    expect(container.querySelector<HTMLTextAreaElement>(".draft-input")?.value).toBe("keep me");
    expect(container.querySelector(".send-btn")).not.toBeNull();
  });

  it("renders streamed text deltas", async () => {
    const api = client();
    api.submitTurnEvents = [
      { type: "text_delta", requestId: "t", text: "hello " },
      { type: "text_delta", requestId: "t", text: "world" },
      { type: "completed", requestId: "t" },
    ];
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();
    const textarea = container.querySelector<HTMLTextAreaElement>(".draft-input");
    textarea!.value = "go";
    textarea!.dispatchEvent(new Event("input"));
    await flush();
    container.querySelector<HTMLButtonElement>(".send-btn")?.click();
    await flush();

    expect(container.querySelector(".streaming-text")?.textContent).toBe("hello world");
  });

  it("escapes every streamed XSS payload", async () => {
    const api = client();
    api.submitTurnEvents = [
      { type: "text_delta", requestId: "t", text: XSS },
      { type: "completed", requestId: "t" },
    ];
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();
    const textarea = container.querySelector<HTMLTextAreaElement>(".draft-input");
    textarea!.value = "go";
    textarea!.dispatchEvent(new Event("input"));
    await flush();
    container.querySelector<HTMLButtonElement>(".send-btn")?.click();
    await flush();

    expect(container.querySelector(".streaming-text")?.innerHTML).not.toContain("<img");
    expect(container.querySelector(".streaming-text")?.textContent).toBe(XSS);
  });

  it("never renders a tool_call input in the session surface", async () => {
    const api = client();
    api.submitTurnEvents = [
      {
        type: "tool_call",
        requestId: "t",
        id: "call-1",
        name: "read_file",
        input: { apiKey: "T28_SYNTHETIC_VALUE", path: "/etc/passwd" },
      },
      { type: "text_delta", requestId: "t", text: "ok" },
      { type: "completed", requestId: "t" },
    ] as unknown as AgentEvent[];
    ui = mountDesktopUi(container, api as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    container.querySelector<HTMLButtonElement>(".new-session-btn")?.click();
    await flush();
    const textarea = container.querySelector<HTMLTextAreaElement>(".draft-input");
    textarea!.value = "go";
    textarea!.dispatchEvent(new Event("input"));
    await flush();
    container.querySelector<HTMLButtonElement>(".send-btn")?.click();
    await flush();

    expect(container.innerHTML).not.toContain("apiKey");
    expect(container.innerHTML).not.toContain("T28_SYNTHETIC_VALUE");
    expect(container.innerHTML).not.toContain("/etc/passwd");
  });
});

describe("Task 28 final Desktop: configuration surface", () => {
  it("lists providers and routes after connecting", async () => {
    const config = await mountWithConfig(client(), new FakeConfigClient());
    expect(container.querySelector(".config-panel")).not.toBeNull();
    expect(container.textContent).toContain("Provider One");
    expect(container.textContent).toContain("Route One");
    expect(config.getConfigCalls).toBe(1);
  });

  it("refreshes the configuration on demand", async () => {
    const config = await mountWithConfig(client(), new FakeConfigClient());
    container.querySelector<HTMLButtonElement>(".config-refresh")?.click();
    await flush();
    expect(config.getConfigCalls).toBe(2);
  });

  it("creates a provider from the form", async () => {
    const config = await mountWithConfig(client(), new FakeConfigClient());
    const form = container.querySelector<HTMLFormElement>(".provider-form")!;
    (form.elements.namedItem("id") as HTMLInputElement).value = "provider-two";
    (form.elements.namedItem("name") as HTMLInputElement).value = "Provider Two";
    (form.elements.namedItem("baseUrl") as HTMLInputElement).value = "https://api.two.invalid/v1";
    (form.elements.namedItem("models") as HTMLInputElement).value = "model-two";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(config.created).toHaveLength(1);
    expect(config.created[0]).toMatchObject({ id: "provider-two", enabled: true });
  });

  it("updates an existing provider instead of creating a duplicate", async () => {
    const config = await mountWithConfig(client(), new FakeConfigClient());
    container.querySelector<HTMLButtonElement>("[data-edit-provider]")?.click();
    await flush();
    const form = container.querySelector<HTMLFormElement>(".provider-form")!;
    expect((form.elements.namedItem("id") as HTMLInputElement).value).toBe("provider-one");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(config.updated).toHaveLength(1);
    expect(config.created).toHaveLength(0);
  });

  it("deletes a provider from the list", async () => {
    const config = await mountWithConfig(client(), new FakeConfigClient());
    container.querySelector<HTMLButtonElement>("[data-delete-provider]")?.click();
    await flush();
    expect(config.deleted).toEqual(["provider-one"]);
  });

  it("deletes a route from the list", async () => {
    const config = await mountWithConfig(client(), new FakeConfigClient());
    container.querySelector<HTMLButtonElement>("[data-delete-route]")?.click();
    await flush();
    expect(config.deleted).toEqual(["route-one"]);
  });

  it("shows a fixed safe message when configuration loading fails", async () => {
    const config = new FakeConfigClient();
    config.shouldFail = true;
    await mountWithConfig(client(), config);

    const status = container.querySelector(".config-status");
    expect(status?.textContent).toBe("Failed to load configuration.");
    expect(container.innerHTML).not.toContain("boom");
  });

  it("shows a fixed safe message when saving a provider fails", async () => {
    const config = new FakeConfigClient();
    config.createProvider = async () => {
      throw new Error("disk exploded at C:/secret/path");
    };
    await mountWithConfig(client(), config);

    const form = container.querySelector<HTMLFormElement>(".provider-form")!;
    (form.elements.namedItem("id") as HTMLInputElement).value = "provider-nine";
    (form.elements.namedItem("name") as HTMLInputElement).value = "Nine";
    (form.elements.namedItem("baseUrl") as HTMLInputElement).value = "https://api.nine.invalid";
    (form.elements.namedItem("models") as HTMLInputElement).value = "model-nine";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(container.querySelector(".config-status")?.textContent).toBe(
      "Failed to save provider.",
    );
    expect(container.innerHTML).not.toContain("disk exploded");
    expect(container.innerHTML).not.toContain("C:/secret/path");
  });

  it("only exposes whitelisted, non-secret configuration fields", async () => {
    await mountWithConfig(client(), new FakeConfigClient());
    const html = container.innerHTML;
    for (const forbidden of [
      "apiKey",
      "api_key",
      "token",
      "authorization",
      "Authorization",
      "password",
      "secret",
    ]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
    for (const field of ["id", "name", "protocol", "baseUrl", "credentialRef", "models", "enabled"]) {
      expect(html, field).toContain(`name="${field}"`);
    }
  });

  it("escapes XSS payloads coming from configuration values", async () => {
    const config = new FakeConfigClient();
    config.snapshot = {
      version: 1,
      providers: [{ ...provider, name: XSS }],
      routes: [],
    };
    await mountWithConfig(client(), config);
    expect(container.innerHTML).not.toContain("<img");
    expect(container.textContent).toContain(XSS);
  });

  it("renders no configuration panel without an injected config client", async () => {
    ui = mountDesktopUi(container, client() as unknown as DesktopApiClient);
    container.querySelector<HTMLButtonElement>(".connect-btn")?.click();
    await flush();
    expect(container.querySelector(".config-panel")).toBeNull();
  });
});

describe("Task 28 final Desktop: static renderer guarantees", () => {
  it("escapes the draft, session ids and error text", () => {
    const html = renderDesktopPage({
      connection: "ready",
      sessions: [session(XSS)],
      activeSessionId: XSS,
      events: [{ type: "text_delta", requestId: "t", text: XSS } as AgentEvent],
      draft: XSS,
      error: XSS,
    });
    // No live tag and no live attribute can be introduced by escaped text.
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).not.toContain("alert('pwned')");
    expect(html).toContain("&lt;img");
  });

  it("never renders a tool_call input, provider URL or credential reference", () => {
    const html = renderDesktopPage({
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [
        {
          type: "tool_call",
          requestId: "t",
          id: "call-1",
          name: "read_file",
          input: { apiKey: "T28_SYNTHETIC_VALUE", url: "https://api.example.invalid" },
        } as AgentEvent,
        {
          type: "route_selected",
          requestId: "t",
          routeId: "route-one",
          model: "model-one",
        } as AgentEvent,
      ],
      draft: "",
      error: null,
    });
    expect(html).not.toContain("T28_SYNTHETIC_VALUE");
    expect(html).not.toContain("api.example.invalid");
    expect(html).not.toContain("credential:");
    expect(html).not.toContain("route-one");
    expect(html).not.toContain("model-one");
  });

  it("emits no javascript: URL, live event attribute or external reference", () => {
    const html = renderDesktopPage({
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: 'javascript:alert(1)" onmouseover="alert(2)',
      error: null,
    });
    // No live handler attribute: an injected payload can only appear as
    // escaped text, never as a real attribute of a real tag.
    expect(html).not.toMatch(/<[a-zA-Z][^>]*\son\w+=/);
    expect(html).not.toContain('onmouseover="');
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    // The literal text may survive escaped; what must never exist is a URL
    // attribute that actually points at a javascript: target.
    expect(html).not.toMatch(/(href|src)\s*=\s*["']?javascript:/i);
    expect(html).toContain("./styles.css");
  });

  it("escapes every HTML metacharacter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
