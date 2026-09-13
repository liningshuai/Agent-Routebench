import { describe, expect, it } from "vitest";
import {
  createDesktopConfigClient,
  type DesktopConfigApiClient,
} from "../apps/desktop/src/config-client.js";

function makeInvoke(response: unknown) {
  return async <T>(): Promise<T> => response as T;
}

function makeListen() {
  return async () => () => undefined;
}

describe("task 27 desktop config client", () => {
  it("getConfig returns a valid snapshot", async () => {
    const client = createDesktopConfigClient({
      invoke: makeInvoke({ version: 1, providers: [], routes: [] }),
      listen: makeListen(),
    });
    const result = await client.getConfig();
    expect(result.version).toBe(1);
    expect(Array.isArray(result.providers)).toBe(true);
  });

  it("createProvider returns a valid provider", async () => {
    const client = createDesktopConfigClient({
      invoke: makeInvoke({
        provider: {
          id: "p1",
          name: "P1",
          protocol: "openai_compatible",
          baseUrl: "https://api.example.invalid/v1",
          credentialRef: "credential:p1",
          models: ["m1"],
          enabled: true,
        },
      }),
      listen: makeListen(),
    });
    const result = await client.createProvider({
      id: "p1",
      name: "P1",
      protocol: "openai_compatible",
      baseUrl: "https://api.example.invalid/v1",
      credentialRef: "credential:p1",
      models: ["m1"],
      enabled: true,
    });
    expect(result.id).toBe("p1");
  });

  it("deleteProvider returns void on success", async () => {
    const client = createDesktopConfigClient({
      invoke: makeInvoke({ ok: true }),
      listen: makeListen(),
    });
    await expect(client.deleteProvider("p1")).resolves.toBeUndefined();
  });

  it("rejects invalid invoke options", () => {
    expect(() =>
      createDesktopConfigClient({ invoke: null, listen: makeListen() } as never),
    ).toThrow();
  });

  it("rejects missing listen", () => {
    expect(() =>
      createDesktopConfigClient({ invoke: makeInvoke({}), listen: null } as never),
    ).toThrow();
  });

  it("passes AbortSignal through getConfig", async () => {
    const controller = new AbortController();
    const client = createDesktopConfigClient({
      invoke: makeInvoke({ version: 1, providers: [], routes: [] }),
      listen: makeListen(),
    });
    // Should not throw with a valid signal.
    const result = await client.getConfig(controller.signal);
    expect(result.version).toBe(1);
  });

  it("rejects when response has wrong shape", async () => {
    const client = createDesktopConfigClient({
      invoke: makeInvoke({ wrong: true }),
      listen: makeListen(),
    });
    await expect(client.getConfig()).rejects.toThrow();
  });

  it("rejects provider response with missing fields", async () => {
    const client = createDesktopConfigClient({
      invoke: makeInvoke({ provider: { id: "p1" } }),
      listen: makeListen(),
    });
    await expect(
      client.createProvider({ id: "p1" } as never),
    ).rejects.toThrow();
  });
});
