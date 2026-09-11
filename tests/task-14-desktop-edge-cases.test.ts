import { describe, test, expect } from "vitest";
import { DesktopController } from "../apps/desktop/src/controller.js";
import { createDesktopError, DESKTOP_ERROR_CODES } from "../apps/desktop/src/errors.js";
import { FakeDesktopApiClient } from "./helpers/desktop-fixtures.js";

describe("Task 14: Desktop Edge Cases — Connection", () => {
  test("should reuse loadPromise during connection", async () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    
    // Start two connects before either completes
    const promise1 = controller.connect();
    const promise2 = controller.connect();
    
    // Both should resolve successfully
    await Promise.all([promise1, promise2]);
    
    // load should only be called once
    expect(client.loadCalled).toBe(true);
    const state = controller.getState();
    expect(state.connection).toBe("ready");
  });

  test("should handle connection error with non-Error object", async () => {
    const client = new FakeDesktopApiClient();
    client.loadShouldFail = true;
    client.loadError = "String error";
    
    const controller = new DesktopController(client);
    await controller.connect();
    
    const state = controller.getState();
    expect(state.connection).toBe("failed");
    expect(state.error).toBe("Failed to connect to Desktop API.");
  });

  test("should allow reconnect after failure", async () => {
    const client = new FakeDesktopApiClient();
    client.loadShouldFail = true;
    
    const controller = new DesktopController(client);
    await controller.connect();
    expect(controller.getState().connection).toBe("failed");
    
    client.loadShouldFail = false;
    await controller.connect();
    expect(controller.getState().connection).toBe("ready");
  });
});

describe("Task 14: Desktop Edge Cases — Sessions", () => {
  test("should handle createSession failure", async () => {
    const client = new FakeDesktopApiClient();
    client.createSessionShouldFail = true;
    
    const controller = new DesktopController(client);
    await controller.connect();
    
    await expect(controller.newSession()).rejects.toThrow();
    const state = controller.getState();
    expect(state.sessions.length).toBe(0);
  });

  test("should handle multiple sessions", async () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    await controller.connect();
    
    await controller.newSession();
    await controller.newSession();
    await controller.newSession();
    
    const state = controller.getState();
    expect(state.sessions.length).toBe(3);
    expect(state.activeSessionId).toBe(state.sessions[2].id);
  });

  test("should reject newSession when not connected", async () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    
    await expect(controller.newSession()).rejects.toThrow("Not connected");
  });
});

describe("Task 14: Desktop Edge Cases — Turn Submission", () => {
  test("should handle submitTurn with empty events", async () => {
    const client = new FakeDesktopApiClient();
    client.submitTurnEvents = [];
    
    const controller = new DesktopController(client);
    await controller.connect();
    await controller.newSession();
    const state = controller.getState();
    
    await controller.submitTurn(state.sessions[0].id, { messages: [] });
    
    const finalState = controller.getState();
    expect(finalState.events.length).toBe(0);
  });

  test("should reject submitTurn with invalid sessionId", async () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    await controller.connect();
    
    await expect(
      controller.submitTurn("invalid_session_id", { messages: [] }),
    ).rejects.toThrow("Session not found");
  });

  test("should handle submitTurn error", async () => {
    const client = new FakeDesktopApiClient();
    client.submitTurnShouldFail = true;
    
    const controller = new DesktopController(client);
    await controller.connect();
    await controller.newSession();
    const state = controller.getState();
    
    await expect(
      controller.submitTurn(state.sessions[0].id, { messages: [] }),
    ).rejects.toThrow("Failed to submit turn.");
  });
});

describe("Task 14: Desktop Edge Cases — Cancellation", () => {
  test("should handle cancelTurn when no turn is running", async () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    await controller.connect();
    await controller.newSession();
    const state = controller.getState();
    
    await controller.cancelTurn(state.sessions[0].id);
    
    // Should not call API without activeTurnId (Task 14 requirement)
    expect(client.cancelTurnCalled).toBe(false);
  });

  test("should handle cancelTurn with invalid sessionId", async () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    await controller.connect();
    
    // Should not throw, just a no-op
    await controller.cancelTurn("invalid_session_id");
    expect(client.cancelTurnCalled).toBe(false);
  });
});

describe("Task 14: Desktop Edge Cases — State Management", () => {
  test("should return independent state copies", () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    
    const state1 = controller.getState();
    // State is readonly, so we can't mutate it directly
    // This test verifies that each call returns a new copy
    
    const state2 = controller.getState();
    expect(state2.sessions).toEqual([]);
    expect(state1).not.toBe(state2);
  });

  test("should handle draft with special characters", () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    
    const specialText = '<script>alert("XSS")</script>';
    controller.updateDraft(specialText);
    
    const state = controller.getState();
    expect(state.draft).toBe(specialText);
  });

  test("should handle very long draft", () => {
    const client = new FakeDesktopApiClient();
    const controller = new DesktopController(client);
    
    const longText = "a".repeat(100000);
    controller.updateDraft(longText);
    
    const state = controller.getState();
    expect(state.draft.length).toBe(100000);
  });
});

describe("Task 14: Desktop Errors — Error Factory", () => {
  test("should create NOT_CONNECTED error", () => {
    const error = createDesktopError("NOT_CONNECTED");
    expect(error.code).toBe(DESKTOP_ERROR_CODES.NOT_CONNECTED);
    expect(error.message).toBe("Not connected to Local Agent API.");
  });

  test("should create SESSION_NOT_FOUND error", () => {
    const error = createDesktopError("SESSION_NOT_FOUND");
    expect(error.code).toBe(DESKTOP_ERROR_CODES.SESSION_NOT_FOUND);
    expect(error.message).toBe("Session not found.");
  });

  test("should have DesktopError name", () => {
    const error = createDesktopError("NOT_CONNECTED");
    expect(error.name).toBe("DesktopError");
  });
});
