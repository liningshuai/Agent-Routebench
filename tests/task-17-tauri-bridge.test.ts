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

describe("Task 17: Tauri DesktopApiClient command bridge", () => {
  test("load invokes the fixed health command without arguments", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.health, { ok: true });
    const client = createTauriDesktopApiClient(bridge);

    await client.load();

    expect(bridge.invokeCalls).toEqual([
      { command: TAURI_COMMANDS.health, args: undefined },
    ]);
  });

  test("createSession invokes the fixed command and returns a defensive copy", async () => {
    const bridge = new FakeTauriBridge();
    const response = {
      session: { ...VALID_SESSION },
    };
    bridge.invokeResponses.set(TAURI_COMMANDS.createSession, response);
    const client = createTauriDesktopApiClient(bridge);

    const session = await client.createSession();
    (session as { id: string }).id = "mutated";

    expect(response.session).toEqual(VALID_SESSION);
    expect(bridge.callsFor(TAURI_COMMANDS.createSession)).toHaveLength(1);
  });

  test("cancelTurn sends only sessionId and turnId to the fixed command", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.cancelTurn, { ok: true });
    const client = createTauriDesktopApiClient(bridge);

    await client.cancelTurn("session-1", "turn-1");

    expect(bridge.callsFor(TAURI_COMMANDS.cancelTurn)).toEqual([
      {
        command: TAURI_COMMANDS.cancelTurn,
        args: { sessionId: "session-1", turnId: "turn-1" },
      },
    ]);
  });

  test("submitTurn subscribes before starting and streams matching events", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client
      .submitTurn("session-1", VALID_TURN_REQUEST)
      [Symbol.asyncIterator]();

    const firstPromise = iterator.next();
    await flushTauriMicrotasks();
    expect(bridge.listeners.has(TAURI_EVENTS.turnEvent)).toBe(true);
    expect(bridge.callsFor(TAURI_COMMANDS.startTurn)).toEqual([
      {
        command: TAURI_COMMANDS.startTurn,
        args: { sessionId: "session-1", request: VALID_TURN_REQUEST },
      },
    ]);

    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: textEvent("hello"),
    });
    expect(await firstPromise).toEqual({
      done: false,
      value: textEvent("hello"),
    });

    const completedPromise = iterator.next();
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: completedEvent(),
    });
    expect(await completedPromise).toEqual({
      done: false,
      value: completedEvent(),
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(bridge.unlistenCalls).toEqual([TAURI_EVENTS.turnEvent]);
  });

  test("submitTurn ignores events from another session or turn", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();

    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "other-session",
      turnId: "turn-1",
      event: textEvent("wrong-session"),
    });
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "other-turn",
      event: textEvent("wrong-turn"),
    });
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: textEvent("right"),
    });

    await expect(nextPromise).resolves.toEqual({
      done: false,
      value: textEvent("right"),
    });
    await iterator.return?.();
  });

  test("iterator cleanup removes the listener when the consumer stops early", async () => {
    const bridge = new FakeTauriBridge();
    bridge.invokeResponses.set(TAURI_COMMANDS.startTurn, { turnId: "turn-1" });
    const client = createTauriDesktopApiClient(bridge);
    const iterator = client.submitTurn("session-1", VALID_TURN_REQUEST)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();
    await flushTauriMicrotasks();
    bridge.emit(TAURI_EVENTS.turnEvent, {
      sessionId: "session-1",
      turnId: "turn-1",
      event: textEvent("one"),
    });
    await nextPromise;

    await iterator.return?.();

    expect(bridge.unlistenCalls).toEqual([TAURI_EVENTS.turnEvent]);
  });
});
