import { describe, expect, test } from "vitest";
import {
  createTauriDesktopApiClient,
  TAURI_COMMANDS,
  TAURI_EVENTS,
} from "../apps/desktop/src/tauri-api-client.js";
import {
  Deferred,
  FakeTauriBridge,
  VALID_TURN_REQUEST,
  completedEvent,
  flushTauriMicrotasks,
  textEvent,
} from "./helpers/tauri-fixtures.js";

describe("Task 17: Tauri bridge lifecycle and cancellation", () => {
  test("rejects a bridge without callable invoke and listen methods", () => {
    expect(() =>
      createTauriDesktopApiClient({ invoke: null, listen: null } as never),
    ).toThrow("Failed to connect to Local Agent API.");
  });

  test("maps a rejected listener registration to a fixed turn error", async () => {
    const bridge = new FakeTauriBridge();
    const failing = {
      invoke: bridge.invoke.bind(bridge),
      listen: async () => {
        throw new Error("provider URL TASK17_SECRET");
      },
    };
    const client = createTauriDesktopApiClient(failing);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      message: "Failed to submit turn.",
    });
  });

  test("maps a malformed start response to a fixed turn error", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { id: "wrong" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      message: "Failed to submit turn.",
    });
    expect(bridge.unlistenCalls).toEqual([TAURI_EVENTS.turnEvent]);
  });

  test("a terminal error event closes the stream after delivering one safe event", async () => {
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
        message: "raw provider failure TASK17_SECRET",
        retryable: false,
      },
    });

    await expect(nextPromise).resolves.toMatchObject({
      done: false,
      value: {
        type: "error",
        message: "Model gateway request failed.",
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test("abort during a pending start command ends without waiting for the host", async () => {
    const bridge = new FakeTauriBridge();
    const deferred = new Deferred<unknown>();
    bridge.invokeDeferred.set(TAURI_COMMANDS.startTurn, deferred);
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
    deferred.resolve({ turnId: "late-turn" });
    await flushTauriMicrotasks();
  });

  test("abort while listener registration is pending does not wait for registration", async () => {
    const listenerDeferred = new Deferred<() => void>();
    const bridge = new FakeTauriBridge();
    const client = createTauriDesktopApiClient({
      invoke: bridge.invoke.bind(bridge),
      listen: async () => listenerDeferred.promise,
    });
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
    listenerDeferred.resolve(() => undefined);
    await flushTauriMicrotasks();
  });

  test("two concurrent streams receive only their matching events", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const first = client.submitTurn("session-a", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const second = client.submitTurn("session-b", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const firstNext = first.next();
    const secondNext = second.next();
    await flushTauriMicrotasks();

    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-a",
      turnId: "turn-1",
      event: textEvent("a"),
    });
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-b",
      turnId: "turn-1",
      event: textEvent("b"),
    });

    await expect(firstNext).resolves.toMatchObject({ value: textEvent("a"), done: false });
    await expect(secondNext).resolves.toMatchObject({ value: textEvent("b"), done: false });
    await first.return?.();
    await second.return?.();
    expect(bridge.listenerSets.get(TAURI_EVENTS.turnEvent)?.size ?? 0).toBe(0);
  });

  test("cancelTurn maps a host rejection to a fixed error", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeErrors.set(
      TAURI_COMMANDS.cancelTurn,
      new Error("native stack https://provider.invalid TASK17_SECRET"),
    );
    const client = createTauriDesktopApiClient(bridge);

    await expect(client.cancelTurn("session-1", "turn-1")).rejects.toMatchObject({
      message: "Failed to cancel turn.",
    });
  });

  test("createSession rejects an envelope with extra fields", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.createSession, {
      session: {
        id: "session-1",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      },
      secret: "TASK17_SECRET",
    });
    const client = createTauriDesktopApiClient(bridge);

    await expect(client.createSession()).rejects.toMatchObject({
      message: "Failed to create session.",
    });
  });

  test("a completed event prevents later event delivery", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const first = iterator.next();
    await flushTauriMicrotasks();
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: completedEvent(),
    });
    await expect(first).resolves.toMatchObject({ value: completedEvent(), done: false });

    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: textEvent("late"),
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
