import { DesktopController } from "./controller.js";
import type { DesktopApiClient } from "./types.js";
import type { DesktopState } from "./types.js";
import type {
  DesktopConfigApiClient,
} from "./config-client.js";
import type { DesktopCredentialClient } from "./credential-client.js";
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
  return div.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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

function isCredentialClient(value: unknown): value is DesktopCredentialClient {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return ["set", "has", "delete"].every((method) => typeof candidate[method] === "function");
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
  hasCredentialClient: boolean,
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
  html += renderProviderForm(state.snapshot, editingProviderId, hasCredentialClient);
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
  hasCredentialClient: boolean,
): string {
  const provider = snapshot?.providers.find((item) => item.id === editingProviderId);
  const value = (input: string | undefined): string => escapeHtml(input ?? "");
  const credentialField = hasCredentialClient
    ? `<label>API key<input name="secret" type="password" autocomplete="new-password" placeholder="Enter a key (never stored in config)"></label><p class="credential-help">The key is stored in Windows Credential Manager. Leave it blank to keep the existing key.</p>`
    : "";
  return `<form class="provider-form config-form"><h3>${provider ? "Edit provider" : "Add provider"}</h3><label>Id<input name="id" required value="${value(provider?.id)}"></label><label>Name<input name="name" required value="${value(provider?.name)}"></label><label>Protocol<select name="protocol"><option value="openai_compatible"${provider?.protocol === "openai_compatible" || !provider ? " selected" : ""}>OpenAI compatible</option><option value="anthropic_messages"${provider?.protocol === "anthropic_messages" ? " selected" : ""}>Anthropic Messages</option></select></label><label>Base URL<input name="baseUrl" required value="${value(provider?.baseUrl)}"></label><label>Credential reference<input name="credentialRef" placeholder="credential:example" value="${value(provider?.credentialRef ?? "")}"></label>${credentialField}<label>Models<input name="models" required placeholder="model-a, model-b" value="${value(provider?.models.join(", "))}"></label><label class="config-checkbox"><input type="checkbox" name="enabled"${provider?.enabled !== false ? " checked" : ""}> Enabled</label><button type="submit">${provider ? "Save provider" : "Add provider"}</button></form>`;
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
  credentialClient?: DesktopCredentialClient,
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
  if (credentialClient !== undefined && !isCredentialClient(credentialClient)) {
    throw new Error("DesktopCredentialClient is invalid.");
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
  let settingsOpen = false;
  let selectedRouteId = "";
  let inputUpdate = false;
  let creatingSession = false;
  type ChatMessage = { role: "user" | "assistant"; text: string };
  const conversations = new Map<string, ChatMessage[]>();

  function currentRoute(): RouteDefinition | undefined {
    const routes = configState.snapshot?.routes.filter(route => route.enabled) ?? [];
    return routes.find(route => route.id === selectedRouteId) ?? routes[0];
  }

  function canSend(state: DesktopState): boolean {
    return !state.isSubmitting && state.draft.trim().length > 0 &&
      (configClient === undefined || (configState.status === "ready" && currentRoute() !== undefined));
  }

  function render(): void {
    if (unmounted) {
      return;
    }
    const state = controller.getState();
    if (inputUpdate) {
      const button = container.querySelector<HTMLButtonElement>(".send-btn");
      if (button) button.disabled = !canSend(state);
      return;
    }
    const scroll = container.querySelector<HTMLElement>(".chat-transcript");
    const nearBottom = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    const html = renderHtml(state);
    container.innerHTML = html;
    attachEventListeners();
    const nextScroll = container.querySelector<HTMLElement>(".chat-transcript");
    if (nextScroll && nearBottom) nextScroll.scrollTop = nextScroll.scrollHeight;
  }

  // Subscribe to controller state changes
  const unsubscribeController = controller.subscribe(() => {
    render();
  });

  function renderHtml(state: DesktopState): string {
    let html = '<div class="desktop-ui product-shell">';

    // Error message
    if (state.error) {
      html += `<div class="error product-error" role="alert">${escapeHtml(state.error)}</div>`;
    }

    // Connection section - map "idle" to same UI as disconnected
    if (state.connection === "idle" || state.connection === "failed") {
      html += '<main class="welcome"><div class="brand-mark">R</div><h1>Agent Routebench</h1><p>你的本地 Agent 工作台</p><button class="connect-btn primary-button">Connect</button><p class="muted">连接本机服务，开始新的对话。</p></main>';
    } else if (state.connection === "loading") {
      html += '<button class="connect-btn" disabled>Connecting...</button>';
    } else if (state.connection === "ready") {
      html += renderSessionSection(state);
      if (configClient !== undefined) {
        html += `<div class="settings-overlay"${settingsOpen ? "" : " hidden"}><div class="settings-sheet"><button class="settings-close" type="button">返回对话 ×</button>`;
        html += renderConfigPanel(configState, editingProviderId, editingRouteId, credentialClient !== undefined);
        html += '</div></div>';
      }
    }

    html += "</div>";
    return html;
  }

  function renderSessionSection(state: DesktopState): string {
    let html = '<aside class="product-sidebar"><div class="product-brand"><span class="brand-mark">R</span><strong>Routebench</strong><span class="edition">LOCAL</span></div>';

    // New session button
    html += `<button class="new-session-btn"${creatingSession || state.isSubmitting ? " disabled" : ""}>＋ ${creatingSession ? "Creating…" : "New Session"}</button><div class="workspace-label">本地工作区 <span>会话</span></div>`;

    // Session list - always render the list element
    html += '<ul class="session-list">';
    for (const session of state.sessions) {
      const activeClass =
        state.activeSessionId === session.id ? " active" : "";
      const title = conversations.get(session.id)?.find(message => message.role === "user")?.text.slice(0,36) ?? "新对话";
      html += `<li><button class="session-item${activeClass}" data-session-id="${escapeHtml(session.id)}"${state.isSubmitting ? " disabled" : ""}><span class="session-title">${escapeHtml(title)}</span><span class="session-id">${escapeHtml(session.id.slice(0,8))}</span></button></li>`;
    }
    html += '</ul><div class="sidebar-bottom"><button class="settings-toggle" type="button">⚙ 设置与模型</button><div class="connection-status"><span class="status-dot"></span>Connected <span>本地服务</span></div></div></aside><main class="session-section chat-main"><header class="chat-header"><div><span class="eyebrow">AGENT WORKSPACE</span><h1>一起把想法变成行动</h1></div><span class="local-badge">本地运行</span></header>';
    html += '<div class="chat-transcript" aria-live="polite">';
    const history = conversations.get(state.activeSessionId ?? "") ?? [];
    if (history.length === 0 && state.events.length === 0) {
      html += '<div class="chat-empty"><div class="empty-mark">↗</div><h2>今天想完成什么？</h2><p>选择一条模型路由，开始一段专注的对话。</p><div class="starter-tags"><span>梳理思路</span><span>解释代码</span><span>起草方案</span></div></div>';
    }
    for (const message of history) {
      html += `<article class="chat-message ${message.role}"><div class="message-author">${message.role === "user" ? "你" : "Routebench"}</div><div class="message-text${message.role === "assistant" ? " streaming-text" : ""}">${escapeHtml(message.text)}</div></article>`;
    }
    let accumulatedText = "";
    for (const event of state.events) if (event.type === "text_delta") accumulatedText += event.text;
    if (accumulatedText && state.isSubmitting) html += `<article class="chat-message assistant streaming-events"><div class="message-author">Routebench</div><div class="streaming-text message-text">${escapeHtml(accumulatedText)}</div></article>`;
    if (state.isSubmitting && !accumulatedText) html += '<div class="working-indicator" role="status">正在等待模型响应…</div>';
    html += '</div>';

    // Draft and streaming section for active session
    if (state.activeSessionId) {
      html += '<div class="draft-section">';
      if (configClient !== undefined) {
        const route = currentRoute();
        html += '<label class="route-picker">模型路由 <select class="route-select" aria-label="模型路由">';
        if (!route) html += '<option value="">尚未配置路由</option>';
        for (const item of configState.snapshot?.routes.filter(item => item.enabled) ?? []) html += `<option value="${escapeHtml(item.id)}"${route?.id === item.id ? " selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.model)}</option>`;
        html += '</select></label>';
        if (!route) html += '<p class="setup-hint">请先在设置中添加 Provider 和路由，再发送消息。</p>';
      }
      html += `<div class="composer-box"><textarea class="draft-input" aria-label="消息" placeholder="Enter message..."${state.isSubmitting ? " disabled" : ""}>${escapeHtml(state.draft)}</textarea><div class="composer-actions"><span>Enter 发送 · Shift+Enter 换行</span>`;

      if (state.isSubmitting) {
        html += '<button class="cancel-btn">Cancel</button>';
      } else {
        const disabled = canSend(state) ? "" : " disabled";
        html += `<button class="send-btn"${disabled}>Send</button>`;
      }

      html += "</div></div></div>";

    }

    html += "</main>";
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
      draftInput.addEventListener("keydown", (event) => {
        const key = event as KeyboardEvent;
        if (key.key === "Enter" && !key.shiftKey && !key.isComposing) { key.preventDefault(); void handleSend(); }
      });
    }
    container.querySelector(".settings-toggle")?.addEventListener("click", () => { settingsOpen = true; render(); });
    container.querySelector(".settings-close")?.addEventListener("click", () => { settingsOpen = false; render(); });
    container.querySelector(".route-select")?.addEventListener("change", event => { selectedRouteId = (event.target as HTMLSelectElement).value; render(); });

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
    const secret = fieldValue(form, "secret");
    try {
      if (secret.length > 0) {
        if (credentialClient === undefined || input.credentialRef === null) {
          throw new Error("credential unavailable");
        }
        await credentialClient.set(input.credentialRef, secret);
      }
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
    if (creatingSession || controller.getState().isSubmitting) return;
    creatingSession = true;
    render();
    try {
      await controller.newSession();
    } catch (err) {
      // Error already set in controller state
    } finally { creatingSession = false; render(); container.querySelector<HTMLTextAreaElement>(".draft-input")?.focus(); }
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
    inputUpdate = true;
    controller.updateDraft(target.value);
    inputUpdate = false;
  }

  async function handleSend(): Promise<void> {
    const state = controller.getState();
    if (!state.activeSessionId || !canSend(state)) {
      return;
    }

    const route = currentRoute();
    const history = conversations.get(state.activeSessionId) ?? [];
    const requestMessages = [...history, {role: "user" as const, text: state.draft}].map(message => ({role:message.role, content:[{type:"text" as const,text:message.text}]}));
    conversations.set(state.activeSessionId, [...history, {role:"user",text:state.draft}]);
    try {
      await controller.submitTurn(state.activeSessionId, {
        messages: requestMessages,
        ...(route ? {routeId:route.id,model:route.model} : {}),
      });
    } catch (err: unknown) {
      // Error already set in controller state
    } finally {
      const text = controller.getState().events.filter(event => event.type === "text_delta").map(event => event.text).join("");
      const messages = conversations.get(state.activeSessionId) ?? [];
      if (text) conversations.set(state.activeSessionId, [...messages, {role:"assistant",text}]);
      render();
      container.querySelector<HTMLTextAreaElement>(".draft-input")?.focus();
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
