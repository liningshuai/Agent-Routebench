import { describe, expect, test } from "vitest";
import {
  createTauriDesktopApiClient,
  TAURI_COMMANDS,
  TAURI_EVENTS,
} from "../apps/desktop/src/tauri-api-client.js";
import {
  FakeTauriBridge,
  VALID_SESSION,
  VALID_TURN_REQUEST,
  completedEvent,
  flushTauriMicrotasks,
  textEvent,
} from "./helpers/tauri-fixtures.js";

describe("Task 17: Tauri IPC security and validation", () => {
  test("pre-cancelled submit does not listen or invoke", async () => {
    const bridge = new FakeTauriBridge();
    const client = createTauriDesktopApiClient(bridge);
    const controller = new AbortController();
    controller.abort();

    const iterator = client.submitTurn(
      "session-1",
      VALID_TURN_REQUEST,
      controller.signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      message: "Request aborted.",
    });
    expect(bridge.invokeCalls).toEqual([]);
    expect(bridge.listeners.size).toBe(0);
  });

  test("invalid session and turn identifiers are rejected before IPC", async () => {
    const bridge = new FakeTauriBridge();
    const client = createTauriDesktopApiClient(bridge);

    await expect(client.cancelTurn("", "turn-1")).rejects.toMatchObject({
      message: "Failed to cancel turn.",
    });
    expect(bridge.invokeCalls).toEqual([]);
  });

  test("unknown or sensitive turn fields are rejected before IPC", async () => {
    const bridge = new FakeTauriBridge();
    const client = createTauriDesktopApiClient(bridge);
    const request = {
      ...VALID_TURN_REQUEST,
      apiKey: "TASK17_SECRET",
    } as unknown as Parameters<typeof client.submitTurn>[1];

    const iterator = client.submitTurn("session-1", request)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      message: "Failed to submit turn.",
    });
    expect(bridge.invokeCalls).toEqual([]);
  });

  test("malformed host session data becomes a fixed error", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.createSession, {
      session: { id: "s", status: "not-a-status" },
    });
    const client = createTauriDesktopApiClient(bridge);

    await expect(client.createSession()).rejects.toMatchObject({
      message: "Failed to create session.",
    });
  });

  test("malformed event payload becomes a fixed turn error", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();

    bridge.listeners.get(TAURI_EVENTS.turnEvent)?.({
      payload: {
        sessionId: "session-1",
        turnId: "turn-1",
        event: {
          type: "error",
          requestId: "request-1",
          code: "gateway_error",
          message: "provider URL and TASK17_SECRET",
          retryable: false,
          leaked: "secret",
        },
      },
    });

    await expect(nextPromise).rejects.toMatchObject({
      message: "Failed to submit turn.",
    });
  });

  test("valid error events are sanitized before reaching DesktopController", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();

    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: {
        type: "error",
        requestId: "request-1",
        code: "gateway_error",
        message: "https://provider.invalid Authorization Bearer TASK17_SECRET",
        retryable: false,
      },
    });

    await expect(nextPromise).resolves.toEqual({
      done: false,
      value: {
        type: "error",
        requestId: "request-1",
        code: "gateway_error",
        message: "Model gateway request failed.",
        retryable: false,
      },
    });
    expect(JSON.stringify(await iterator.next())).not.toContain("TASK17_SECRET");
  });

  test("malformed events from another session do not terminate this stream", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();

    bridge.listeners.get(TAURI_EVENTS.turnEvent)?.({
      payload: { sessionId: "other-session", malicious: "TASK17_SECRET" },
    });
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: textEvent("still-alive"),
    });

    await expect(nextPromise).resolves.toEqual({
      done: false,
      value: textEvent("still-alive"),
    });
    await iterator.return?.();
  });

  test("host errors never escape their original message", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeErrors.set(
      TAURI_COMMANDS.health,
      new Error("https://provider.invalid Authorization: Bearer TASK17_SECRET"),
    );
    const client = createTauriDesktopApiClient(bridge);

    await expect(client.load()).rejects.toMatchObject({
      message: "Failed to connect to Local Agent API.",
    });
  });

  test("request objects are not mutated or augmented with transport fields", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const request = {
      messages: [...VALID_TURN_REQUEST.messages],
      model: "local-model",
    };

    const iterator = client.submitTurn("session-1", request)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: completedEvent(),
    });
    await nextPromise;

    expect(request).toEqual({
      messages: [...VALID_TURN_REQUEST.messages],
      model: "local-model",
    });
    expect(bridge.callsFor(TAURI_COMMANDS.startTurn)[0]?.args).toEqual({
      sessionId: "session-1",
      request,
    });
  });

  test("class-based invoke and listen implementations are accepted", async () => {
    class ClassBridge extends FakeTauriBridge {}
    const bridge = new ClassBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.createSession, {
      session: { ...VALID_SESSION },
    });
    const client = createTauriDesktopApiClient(bridge);

    await expect(client.createSession()).resolves.toEqual(VALID_SESSION);
    expect(typeof bridge.listen).toBe("function");
  });

  test("signal cancellation ends a pending stream and releases the listener", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const controller = new AbortController();
    const iterator = client.submitTurn(
      "session-1",
      VALID_TURN_REQUEST,
      controller.signal,
    )[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();

    controller.abort();

    await expect(nextPromise).rejects.toMatchObject({
      message: "Request aborted.",
    });
    expect(bridge.unlistenCalls).toEqual([TAURI_EVENTS.turnEvent]);
  });

  test("a valid event is delivered without exposing the IPC envelope", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: textEvent("safe"),
    });

    const result = await nextPromise;
    expect(result.value).toEqual(textEvent("safe"));
    expect(JSON.stringify(result.value)).not.toContain("sessionId");
    expect(JSON.stringify(result.value)).not.toContain("turnId");
    await iterator.return?.();
  });
});
