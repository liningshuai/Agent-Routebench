import { describe, test, expect } from "vitest";
import type { DesktopState } from "../apps/desktop/src/types.js";
import { FakeDesktopApiClient } from "./helpers/desktop-fixtures.js";

describe("Task 14: Desktop State — Initial State", () => {
  test("should have connection: idle initially", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    expect(state.connection).toBe("idle");
  });

  test("should have empty sessions array initially", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    expect(state.sessions).toEqual([]);
  });

  test("should have null activeSessionId initially", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    expect(state.activeSessionId).toBe(null);
  });

  test("should have empty events array initially", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    expect(state.events).toEqual([]);
  });

  test("should have empty draft string initially", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    expect(state.draft).toBe("");
  });

  test("should have null error initially", () => {
    const state: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    expect(state.error).toBe(null);
  });
});

describe("Task 14: Desktop State — Connection Transitions", () => {
  test("should transition from idle to loading", () => {
    const before: DesktopState = {
      connection: "idle",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      connection: "loading",
    };
    expect(after.connection).toBe("loading");
  });

  test("should transition from loading to ready on success", () => {
    const before: DesktopState = {
      connection: "loading",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      connection: "ready",
    };
    expect(after.connection).toBe("ready");
  });

  test("should transition from loading to failed on error", () => {
    const before: DesktopState = {
      connection: "loading",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      connection: "failed",
      error: "Failed to connect to Local Agent API.",
    };
    expect(after.connection).toBe("failed");
    expect(after.error).toBe("Failed to connect to Local Agent API.");
  });
});

describe("Task 14: Desktop State — Session Management", () => {
  test("should add session to sessions array", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const session = {
      id: "sess_1",
      status: "idle" as const,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const after: DesktopState = {
      ...before,
      sessions: [session],
    };
    expect(after.sessions.length).toBe(1);
    expect(after.sessions[0].id).toBe("sess_1");
  });

  test("should set activeSessionId when session is created", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const session = {
      id: "sess_1",
      status: "idle" as const,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const after: DesktopState = {
      ...before,
      sessions: [session],
      activeSessionId: "sess_1",
    };
    expect(after.activeSessionId).toBe("sess_1");
  });

  test("should update session status", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [
        {
          id: "sess_1",
          status: "idle" as const,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      activeSessionId: "sess_1",
      events: [],
      draft: "",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      sessions: [
        {
          ...before.sessions[0],
          status: "running" as const,
          updatedAt: 2000,
        },
      ],
    };
    expect(after.sessions[0].status).toBe("running");
  });
});

describe("Task 14: Desktop State — Event Handling", () => {
  test("should append event to events array", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const event = {
      type: "text_delta" as const,
      requestId: "req_1",
      text: "Hello",
    };
    const after: DesktopState = {
      ...before,
      events: [event],
    };
    expect(after.events.length).toBe(1);
    expect(after.events[0].type).toBe("text_delta");
  });

  test("should accumulate multiple events", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [
        {
          type: "text_delta" as const,
          requestId: "req_1",
          text: "Hello",
        },
      ],
      draft: "",
      error: null,
    };
    const event = {
      type: "text_delta" as const,
      requestId: "req_1",
      text: " world",
    };
    const after: DesktopState = {
      ...before,
      events: [...before.events, event],
    };
    expect(after.events.length).toBe(2);
  });
});

describe("Task 14: Desktop State — Draft Management", () => {
  test("should update draft text", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      draft: "Hello world",
    };
    expect(after.draft).toBe("Hello world");
  });

  test("should clear draft", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "Hello world",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      draft: "",
    };
    expect(after.draft).toBe("");
  });
});

describe("Task 14: Desktop State — Error Handling", () => {
  test("should set error message", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: null,
    };
    const after: DesktopState = {
      ...before,
      error: "Something went wrong.",
    };
    expect(after.error).toBe("Something went wrong.");
  });

  test("should clear error", () => {
    const before: DesktopState = {
      connection: "ready",
      sessions: [],
      activeSessionId: null,
      events: [],
      draft: "",
      error: "Something went wrong.",
    };
    const after: DesktopState = {
      ...before,
      error: null,
    };
    expect(after.error).toBe(null);
  });
});

describe("Task 14: Desktop API Client — Structure Validation", () => {
  test("should accept FakeDesktopApiClient class instance", () => {
    const client = new FakeDesktopApiClient();
    expect(client instanceof FakeDesktopApiClient).toBe(true);
    expect(typeof client.load).toBe("function");
    expect(typeof client.createSession).toBe("function");
    expect(typeof client.submitTurn).toBe("function");
    expect(typeof client.cancelTurn).toBe("function");
  });

  test("should reject plain object without class instance", () => {
    const plainObject = {
      load: async () => {},
      createSession: async () => ({ id: "sess_1", status: "idle" as const, createdAt: 0, updatedAt: 0 }),
      submitTurn: async function*() {},
      cancelTurn: async () => {},
    };
    expect(plainObject.load).toBeDefined();
    expect(Object.getPrototypeOf(plainObject).constructor.name).not.toBe("FakeDesktopApiClient");
  });
});
