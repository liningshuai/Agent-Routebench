import { DesktopController } from "./controller.js";
import type { DesktopApiClient } from "./types.js";
import type { DesktopState } from "./types.js";
import type {
  DesktopConfigApiClient,
} from "./config-client.js";
import type {
  PersistedConfigV1,
} from "@agent-workbench/local-persistence";
import type {
  ProviderDefinition,
  RouteDefinition,
} from "@agent-workbench/provider-registry";

/**
 * Desktop UI interface for interactive renderer.
 */
export interface DesktopUi {
  unmount(): void;
  getState(): Readonly<DesktopState>;
  subscribe(callback: (state: Readonly<DesktopState>) => void): () => void;
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

interface ConfigUiState {
  status: "idle" | "loading" | "ready" | "failed";
  snapshot: PersistedConfigV1 | null;
  error: string | null;
}

function isConfigClient(value: unknown): value is DesktopConfigApiClient {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return [
    "getConfig",
    "createProvider",
    "updateProvider",
    "deleteProvider",
    "createRoute",
    "updateRoute",
    "deleteRoute",
  ].every((method) => typeof candidate[method] === "function");
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const value = form.elements.namedItem(name);
  return value instanceof HTMLInputElement || value instanceof HTMLSelectElement
    ? value.value
    : "";
}

function checkboxValue(form: HTMLFormElement, name: string): boolean {
  const value = form.elements.namedItem(name);
  return value instanceof HTMLInputElement && value.checked;
}

function renderConfigPanel(
  state: ConfigUiState,
  editingProviderId: string | null,
  editingRouteId: string | null,
): string {
  let html = '<section class="config-panel" aria-label="Configuration">';
  html += '<div class="config-panel-header"><div><h2>Configuration</h2><p>Providers and routes</p></div>';
  html += '<button type="button" class="config-refresh">Refresh</button></div>';
  if (state.status === "loading") {
    html += '<div class="config-status">Loading configuration...</div>';
  } else if (state.status === "failed") {
    html += `<div class="config-status config-error">${escapeHtml(state.error ?? "Configuration unavailable.")}</div>`;
  }

  const providers = state.snapshot?.providers ?? [];
  const routes = state.snapshot?.routes ?? [];
  html += '<div class="config-summary">';
  html += `<div class="config-count"><strong>${providers.length}</strong><span>Providers</span></div>`;
  html += `<div class="config-count"><strong>${routes.length}</strong><span>Routes</span></div>`;
  html += "</div>";
  html += '<div class="config-lists">';
  html += '<div class="config-list"><h3>Providers</h3>';
  if (providers.length === 0) {
    html += '<p class="config-empty">No providers configured.</p>';
  }
  for (const provider of providers) {
    html += renderProviderItem(provider, editingProviderId);
  }
  html += '</div><div class="config-list"><h3>Routes</h3>';
  if (routes.length === 0) {
    html += '<p class="config-empty">No routes configured.</p>';
  }
  for (const route of routes) {
    html += renderRouteItem(route, editingRouteId);
  }
  html += "</div></div>";
  html += renderProviderForm(state.snapshot, editingProviderId);
  html += renderRouteForm(state.snapshot, editingRouteId);
  html += "</section>";
  return html;
}

function renderProviderItem(
  provider: ProviderDefinition,
  editingProviderId: string | null,
): string {
  const id = escapeHtml(provider.id);
  const models = escapeHtml(provider.models.join(", "));
  const active = provider.id === editingProviderId ? " config-item-active" : "";
  return `<article class="config-item${active}"><div class="config-item-title"><strong>${escapeHtml(provider.name)}</strong><span>${id}</span></div><div class="config-item-meta"><span>${escapeHtml(provider.protocol)}</span><span>${models}</span><span>${provider.enabled ? "Enabled" : "Disabled"}</span></div><div class="config-item-actions"><button type="button" data-edit-provider="${id}">Edit</button><button type="button" data-delete-provider="${id}">Delete</button></div></article>`;
}

function renderRouteItem(route: RouteDefinition, editingRouteId: string | null): string {
  const id = escapeHtml(route.id);
  const fallbacks = route.fallbackProviderIds?.join(", ") ?? "No fallback";
  const active = route.id === editingRouteId ? " config-item-active" : "";
  return `<article class="config-item${active}"><div class="config-item-title"><strong>${escapeHtml(route.name)}</strong><span>${id}</span></div><div class="config-item-meta"><span>${escapeHtml(route.providerId)} / ${escapeHtml(route.model)}</span><span>${escapeHtml(fallbacks)}</span><span>${route.enabled ? "Enabled" : "Disabled"}</span></div><div class="config-item-actions"><button type="button" data-edit-route="${id}">Edit</button><button type="button" data-delete-route="${id}">Delete</button></div></article>`;
}

function renderProviderForm(
  snapshot: PersistedConfigV1 | null,
  editingProviderId: string | null,
): string {
  const provider = snapshot?.providers.find((item) => item.id === editingProviderId);
  const value = (input: string | undefined): string => escapeHtml(input ?? "");
  return `<form class="provider-form config-form"><h3>${provider ? "Edit provider" : "Add provider"}</h3><label>Id<input name="id" required value="${value(provider?.id)}"></label><label>Name<input name="name" required value="${value(provider?.name)}"></label><label>Protocol<select name="protocol"><option value="openai_compatible"${provider?.protocol === "openai_compatible" || !provider ? " selected" : ""}>OpenAI compatible</option><option value="anthropic_messages"${provider?.protocol === "anthropic_messages" ? " selected" : ""}>Anthropic Messages</option></select></label><label>Base URL<input name="baseUrl" required value="${value(provider?.baseUrl)}"></label><label>Credential reference<input name="credentialRef" placeholder="credential:example" value="${value(provider?.credentialRef ?? "")}"></label><label>Models<input name="models" required placeholder="model-a, model-b" value="${value(provider?.models.join(", "))}"></label><label class="config-checkbox"><input type="checkbox" name="enabled"${provider?.enabled !== false ? " checked" : ""}> Enabled</label><button type="submit">${provider ? "Save provider" : "Add provider"}</button></form>`;
}

function renderRouteForm(
  snapshot: PersistedConfigV1 | null,
  editingRouteId: string | null,
): string {
  const route = snapshot?.routes.find((item) => item.id === editingRouteId);
  const value = (input: string | undefined): string => escapeHtml(input ?? "");
  return `<form class="route-form config-form"><h3>${route ? "Edit route" : "Add route"}</h3><label>Id<input name="id" required value="${value(route?.id)}"></label><label>Name<input name="name" required value="${value(route?.name)}"></label><label>Provider id<input name="providerId" required value="${value(route?.providerId)}"></label><label>Model<input name="model" required value="${value(route?.model)}"></label><label>Fallback provider ids<input name="fallbackProviderIds" placeholder="provider-b, provider-c" value="${value(route?.fallbackProviderIds?.join(", "))}"></label><label class="config-checkbox"><input type="checkbox" name="enabled"${route?.enabled !== false ? " checked" : ""}> Enabled</label><button type="submit">${route ? "Save route" : "Add route"}</button></form>`;
}

/**
 * Mount interactive Desktop UI to a DOM container.
 */
export function mountDesktopUi(
  container: HTMLElement,
  client: DesktopApiClient,
  configClient?: DesktopConfigApiClient,
): DesktopUi {
  if (!container) {
    throw new Error("Container element is required.");
  }
  if (!client) {
    throw new Error("DesktopApiClient is required.");
  }
  if (configClient !== undefined && !isConfigClient(configClient)) {
    throw new Error("DesktopConfigApiClient is invalid.");
  }

  const controller = new DesktopController(client);
  const configState: ConfigUiState = {
    status: configClient === undefined ? "idle" : "loading",
    snapshot: null,
    error: null,
  };
  let editingProviderId: string | null = null;
  let editingRouteId: string | null = null;
  let unmounted = false;

  function render(): void {
    if (unmounted) {
      return;
    }
    const state = controller.getState();
    const html = renderHtml(state);
    container.innerHTML = html;
    attachEventListeners();
  }

  // Subscribe to controller state changes
  const unsubscribeController = controller.subscribe(() => {
    render();
  });

  function renderHtml(state: DesktopState): string {
    let html = '<div class="desktop-ui">';

    // Error message
    if (state.error) {
      html += `<div class="error">${escapeHtml(state.error)}</div>`;
    }

    // Connection section - map "idle" to same UI as disconnected
    if (state.connection === "idle" || state.connection === "failed") {
      html += '<button class="connect-btn">Connect</button>';
    } else if (state.connection === "loading") {
      html += '<button class="connect-btn" disabled>Connecting...</button>';
    } else if (state.connection === "ready") {
      html += '<div class="connection-status">Connected</div>';
      html += renderSessionSection(state);
      if (configClient !== undefined) {
        html += renderConfigPanel(configState, editingProviderId, editingRouteId);
      }
    }

    html += "</div>";
    return html;
  }

  function renderSessionSection(state: DesktopState): string {
    let html = '<div class="session-section">';

    // New session button
    html += '<button class="new-session-btn">New Session</button>';

    // Session list - always render the list element
    html += '<ul class="session-list">';
    for (const session of state.sessions) {
      const activeClass =
        state.activeSessionId === session.id ? " active" : "";
      html += `<li class="session-item${activeClass}" data-session-id="${escapeHtml(session.id)}">${escapeHtml(session.id)}</li>`;
    }
    html += "</ul>";

    // Draft and streaming section for active session
    if (state.activeSessionId) {
      html += '<div class="draft-section">';
      html += `<textarea class="draft-input" placeholder="Enter message...">${escapeHtml(state.draft)}</textarea>`;

      if (state.isSubmitting) {
        html += '<button class="cancel-btn">Cancel</button>';
      } else {
        const disabled = state.draft.trim() === "" ? " disabled" : "";
        html += `<button class="send-btn"${disabled}>Send</button>`;
      }

      html += "</div>";

      // Streaming events
      if (state.events.length > 0) {
        html += '<div class="streaming-events">';
        let accumulatedText = "";
        for (const event of state.events) {
          if (event.type === "text_delta") {
            accumulatedText += event.text;
          }
        }
        if (accumulatedText) {
          html += `<div class="streaming-text">${escapeHtml(accumulatedText)}</div>`;
        }
        html += "</div>";
      }
    }

    html += "</div>";
    return html;
  }

  function attachEventListeners(): void {
    const connectBtn = container.querySelector(".connect-btn");
    if (connectBtn) {
      connectBtn.addEventListener("click", handleConnect);
    }

    const newSessionBtn = container.querySelector(".new-session-btn");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", handleNewSession);
    }

    const sessionItems = container.querySelectorAll(".session-item");
    for (const item of sessionItems) {
      item.addEventListener("click", handleSessionClick);
    }

    const draftInput = container.querySelector(".draft-input");
    if (draftInput) {
      draftInput.addEventListener("input", handleDraftInput);
    }

    const sendBtn = container.querySelector(".send-btn");
    if (sendBtn) {
      sendBtn.addEventListener("click", handleSend);
    }

    const cancelBtn = container.querySelector(".cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", handleCancel);
    }

    const refresh = container.querySelector(".config-refresh");
    refresh?.addEventListener("click", () => {
      void loadConfig();
    });
    const providerForm = container.querySelector<HTMLFormElement>(".provider-form");
    providerForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveProvider(providerForm);
    });
    const routeForm = container.querySelector<HTMLFormElement>(".route-form");
    routeForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveRoute(routeForm);
    });
    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-edit-provider]")) {
      button.addEventListener("click", () => {
        editingProviderId = button.dataset.editProvider ?? null;
        editingRouteId = null;
        render();
      });
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-delete-provider]")) {
      button.addEventListener("click", () => {
        void deleteProvider(button.dataset.deleteProvider ?? "");
      });
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-edit-route]")) {
      button.addEventListener("click", () => {
        editingRouteId = button.dataset.editRoute ?? null;
        editingProviderId = null;
        render();
      });
    }
    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-delete-route]")) {
      button.addEventListener("click", () => {
        void deleteRoute(button.dataset.deleteRoute ?? "");
      });
    }
  }

  async function handleConnect(): Promise<void> {
    await controller.connect();
    if (controller.getState().connection === "ready") {
      await loadConfig();
    }
  }

  async function loadConfig(): Promise<void> {
    if (configClient === undefined || unmounted) {
      return;
    }
    configState.status = "loading";
    configState.error = null;
    render();
    try {
      configState.snapshot = await configClient.getConfig();
      configState.status = "ready";
    } catch {
      configState.status = "failed";
      configState.error = "Failed to load configuration.";
    }
    render();
  }

  async function saveProvider(form: HTMLFormElement): Promise<void> {
    if (configClient === undefined) return;
    const input = {
      id: fieldValue(form, "id"),
      name: fieldValue(form, "name"),
      protocol: fieldValue(form, "protocol"),
      baseUrl: fieldValue(form, "baseUrl"),
      credentialRef: fieldValue(form, "credentialRef") || null,
      models: fieldValue(form, "models").split(",").map((item) => item.trim()).filter(Boolean),
      enabled: checkboxValue(form, "enabled"),
    };
    try {
      if (configState.snapshot?.providers.some((item) => item.id === input.id)) {
        await configClient.updateProvider(input);
      } else {
        await configClient.createProvider(input);
      }
      editingProviderId = null;
      await loadConfig();
    } catch {
      configState.status = "failed";
      configState.error = "Failed to save provider.";
      render();
    }
  }

  async function saveRoute(form: HTMLFormElement): Promise<void> {
    if (configClient === undefined) return;
    const input = {
      id: fieldValue(form, "id"),
      name: fieldValue(form, "name"),
      providerId: fieldValue(form, "providerId"),
      model: fieldValue(form, "model"),
      enabled: checkboxValue(form, "enabled"),
      fallbackProviderIds: fieldValue(form, "fallbackProviderIds").split(",").map((item) => item.trim()).filter(Boolean),
    };
    try {
      if (configState.snapshot?.routes.some((item) => item.id === input.id)) {
        await configClient.updateRoute(input);
      } else {
        await configClient.createRoute(input);
      }
      editingRouteId = null;
      await loadConfig();
    } catch {
      configState.status = "failed";
      configState.error = "Failed to save route.";
      render();
    }
  }

  async function deleteProvider(providerId: string): Promise<void> {
    if (configClient === undefined || providerId.length === 0) return;
    try {
      await configClient.deleteProvider(providerId);
      await loadConfig();
    } catch {
      configState.status = "failed";
      configState.error = "Failed to delete provider.";
      render();
    }
  }

  async function deleteRoute(routeId: string): Promise<void> {
    if (configClient === undefined || routeId.length === 0) return;
    try {
      await configClient.deleteRoute(routeId);
      await loadConfig();
    } catch {
      configState.status = "failed";
      configState.error = "Failed to delete route.";
      render();
    }
  }

  async function handleNewSession(): Promise<void> {
    try {
      await controller.newSession();
    } catch (err) {
      // Error already set in controller state
    }
  }

  function handleSessionClick(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    const sessionId = target.dataset.sessionId;
    if (sessionId) {
      try {
        controller.setActiveSession(sessionId);
      } catch (_err: unknown) {
        // The session was removed between render and click; keep the UI stable.
      }
    }
  }

  function handleDraftInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    controller.updateDraft(target.value);
  }

  async function handleSend(): Promise<void> {
    const state = controller.getState();
    if (!state.activeSessionId || !state.draft.trim()) {
      return;
    }

    try {
      await controller.submitTurn(state.activeSessionId, {
        messages: [{ role: "user", content: [{ type: "text", text: state.draft }] }],
      });
    } catch (err: unknown) {
      // Error already set in controller state
    }
  }

  async function handleCancel(): Promise<void> {
    const state = controller.getState();
    if (!state.activeSessionId) {
      return;
    }

    try {
      await controller.cancelTurn(state.activeSessionId);
    } catch (err: unknown) {
      // Error already set in controller state
    }
  }

  // Initial render
  render();

  return {
    unmount(): void {
      if (unmounted) {
        return;
      }
      unmounted = true;
      unsubscribeController();
      controller.dispose();
      container.replaceChildren();
    },

    getState(): Readonly<DesktopState> {
      return controller.getState();
    },

    subscribe(callback: (state: Readonly<DesktopState>) => void): () => void {
      if (unmounted) {
        return () => undefined;
      }
      return controller.subscribe(callback);
    },
  };
}
