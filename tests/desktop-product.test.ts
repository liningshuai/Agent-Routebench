// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { mountDesktopUi } from "../apps/desktop/src/ui.js";
import { FakeDesktopApiClient } from "./helpers/desktop-fixtures.js";
import { createTauriDesktopApiClient, type TauriInvoke, type TauriListen } from "../apps/desktop/src/tauri-api-client.js";

const mounted: ReturnType<typeof mountDesktopUi>[] = [];
afterEach(() => { for (const ui of mounted.splice(0)) ui.unmount(); document.body.replaceChildren(); });
async function setup(configured = true) {
  const container = document.createElement("div"); document.body.append(container);
  const client = new FakeDesktopApiClient();
  const config = { getConfig: async () => ({ version: 1 as const, providers: [], routes: configured ? [{ id: "route-a", name: "Writing", providerId: "provider-a", model: "model-a", enabled: true }] : [] }), createProvider: vi.fn(), updateProvider: vi.fn(), deleteProvider: vi.fn(), createRoute: vi.fn(), updateRoute: vi.fn(), deleteRoute: vi.fn() };
  const ui = mountDesktopUi(container, client, config); mounted.push(ui);
  (container.querySelector(".connect-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ui.getState().connection).toBe("ready"));
  (container.querySelector(".new-session-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ui.getState().activeSessionId).not.toBeNull());
  return { container, client, ui };
}
test("typing preserves the actual focused input and caret", async () => {
  const {container} = await setup();
  const input = container.querySelector("textarea")!; input.focus(); input.value = "hello"; input.setSelectionRange(3,3);
  input.dispatchEvent(new Event("input", {bubbles:true}));
  expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(3);
});
test("a configured route is included in the real send request", async () => {
  const {container,client} = await setup();
  const input = container.querySelector("textarea")!; input.value = "hello"; input.dispatchEvent(new Event("input", {bubbles:true}));
  (container.querySelector(".send-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(client.submitTurnRequests.length).toBe(1));
  expect(client.submitTurnRequests[0].request).toMatchObject({routeId:"route-a",model:"model-a"});
});
test("empty configuration blocks send and explains what is missing", async () => {
  const {container,client} = await setup(false);
  const input = container.querySelector("textarea")!; input.value = "hello"; input.dispatchEvent(new Event("input", {bubbles:true}));
  expect((container.querySelector(".send-btn") as HTMLButtonElement).disabled).toBe(true);
  expect(container.querySelector(".setup-hint")?.textContent).toContain("路由");
  expect(client.submitTurnRequests).toHaveLength(0);
});
test("stream errors are visible and a new session clears the previous conversation", async () => {
  const {container,client,ui} = await setup();
  client.submitTurnEvents = [{type:"error",requestId:"t",code:"gateway_error",message:"private raw failure",retryable:false}];
  const input = container.querySelector("textarea")!; input.value="hello"; input.dispatchEvent(new Event("input",{bubbles:true}));
  (container.querySelector(".send-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ui.getState().error).toBeTruthy());
  expect(container.textContent).not.toContain("private raw failure");
  (container.querySelector(".new-session-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ui.getState().sessions.length).toBe(2));
  expect(ui.getState().error).toBeNull(); expect(ui.getState().events).toHaveLength(0);
});
test("native events arriving before the invoke response are retained for its turn", async () => {
  let handler: (event: {payload: unknown}) => void = () => {};
  const listen: TauriListen = async (_name, callback) => { handler = callback as typeof handler; return () => {}; };
  const invoke: TauriInvoke = async () => {
    handler({payload:{sessionId:"s",turnId:"t",event:{type:"completed",requestId:"t"}}});
    return {turnId:"t"} as never;
  };
  const client = createTauriDesktopApiClient({invoke,listen});
  const abort = new AbortController();
  const iterator = client.submitTurn("s",{messages:[{role:"user",content:[{type:"text",text:"hi"}]}]},abort.signal)[Symbol.asyncIterator]();
  const result = iterator.next();
  const timeout = setTimeout(() => abort.abort(),300);
  try { expect((await result).value).toMatchObject({type:"completed"}); } finally {clearTimeout(timeout); abort.abort(); await iterator.return?.();}
});
test("second message carries conversation history and sessions remain visually isolated", async () => {
  const {container,client,ui} = await setup();
  client.submitTurnEvents = [{type:"text_delta", requestId:"t",text:"answer"},{type:"completed",requestId:"t"}];
  async function send(text: string) {
    const input=container.querySelector("textarea")!; input.value=text; input.dispatchEvent(new Event("input",{bubbles:true}));
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(ui.getState().isSubmitting).toBe(false));
  }
  await send("first"); await send("second");
  expect(client.submitTurnRequests[1].request.messages).toEqual([
    {role:"user",content:[{type:"text",text:"first"}]},
    {role:"assistant",content:[{type:"text",text:"answer"}]},
    {role:"user",content:[{type:"text",text:"second"}]},
  ]);
  (container.querySelector(".new-session-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ui.getState().sessions.length).toBe(2));
  expect(container.querySelector(".chat-transcript")?.textContent).not.toContain("first");
  (container.querySelector('[data-session-id="sess_1"]') as HTMLButtonElement).click();
  expect(container.querySelector(".chat-transcript")?.textContent).toContain("first");
});
test("settings opens separately from chat and returns to the active session", async () => {
  const {container,ui} = await setup(); const id=ui.getState().activeSessionId;
  expect((container.querySelector(".settings-overlay") as HTMLElement).hidden).toBe(true);
  (container.querySelector(".settings-toggle") as HTMLButtonElement).click();
  expect((container.querySelector(".settings-overlay") as HTMLElement).hidden).toBe(false);
  (container.querySelector(".settings-close") as HTMLButtonElement).click();
  expect((container.querySelector(".settings-overlay") as HTMLElement).hidden).toBe(true);
  expect(ui.getState().activeSessionId).toBe(id);
});

test("provider setup stores the secret through the native credential client only", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new FakeDesktopApiClient();
  const config = {
    getConfig: async () => ({ version: 1 as const, providers: [], routes: [] }),
    createProvider: vi.fn(async (input: unknown) => input as never),
    updateProvider: vi.fn(async (input: unknown) => input as never),
    deleteProvider: vi.fn(),
    createRoute: vi.fn(),
    updateRoute: vi.fn(),
    deleteRoute: vi.fn(),
  };
  const credentialClient = {
    set: vi.fn(async (_ref: string, _secret: string) => undefined),
    has: vi.fn(async () => false),
    delete: vi.fn(async () => undefined),
  };
  const ui = mountDesktopUi(container, client, config, credentialClient);
  mounted.push(ui);
  (container.querySelector(".connect-btn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(ui.getState().connection).toBe("ready"));
  (container.querySelector(".settings-toggle") as HTMLButtonElement).click();
  const form = container.querySelector<HTMLFormElement>(".provider-form")!;
  (form.elements.namedItem("id") as HTMLInputElement).value = "provider-a";
  (form.elements.namedItem("name") as HTMLInputElement).value = "OpenAI";
  (form.elements.namedItem("baseUrl") as HTMLInputElement).value = "https://provider.test/v1";
  (form.elements.namedItem("credentialRef") as HTMLInputElement).value = "credential:provider-a";
  (form.elements.namedItem("models") as HTMLInputElement).value = "model-a";
  const secret = form.elements.namedItem("secret") as HTMLInputElement;
  expect(secret.type).toBe("password");
  secret.value = "synthetic-secret-value";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(credentialClient.set).toHaveBeenCalledWith("credential:provider-a", "synthetic-secret-value"));
  expect(config.createProvider).toHaveBeenCalledOnce();
  expect(config.createProvider.mock.calls[0]?.[0]).not.toHaveProperty("secret");
});
