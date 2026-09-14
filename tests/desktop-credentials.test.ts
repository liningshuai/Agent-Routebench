import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WindowsCredentialSource } from "../apps/local-agent-host/src/credential-source.js";
import { createDesktopCredentialClient } from "../apps/desktop/src/credential-client.js";
import { isCredentialStore } from "../packages/agent-backend/src/validation.js";

describe("desktop credential boundary", () => {
  it("registers the native credential commands in the Tauri handler", () => {
    const lib = readFileSync(resolve("apps/desktop/src-tauri/src/lib.rs"), "utf8");
    expect(lib).toContain("commands::agent_set_credential");
    expect(lib).toContain("commands::agent_has_credential");
    expect(lib).toContain("commands::agent_delete_credential");
  });
  it("rejects unscoped references before IPC", async () => {
    let called = false;
    const client = createDesktopCredentialClient({ invoke: async () => { called = true; return undefined as never; } });
    await expect(client.set("other:account", "synthetic")).rejects.toThrow();
    expect(called).toBe(false);
  });
  it("rejects header control characters and oversized keys before IPC", async () => {
    let called = false;
    const client = createDesktopCredentialClient({ invoke: async () => { called = true; return undefined as never; } });
    for (const secret of ["", "a\nb", "a".repeat(2561)]) await expect(client.set("credential:test", secret)).rejects.toThrow();
    expect(called).toBe(false);
  });
  it("does not expose native error text or malformed replies", async () => {
    const client = createDesktopCredentialClient({ invoke: async () => { throw new Error("synthetic-sensitive-value"); } });
    await expect(client.has("credential:test")).rejects.toThrow("Credential operation failed.");
    const bad = createDesktopCredentialClient({ invoke: async () => "secret" as never });
    await expect(bad.has("credential:test")).rejects.toThrow("Credential operation failed.");
  });
  it("accepts a class store and fails closed for invalid refs/missing helper", async () => {
    const store = new WindowsCredentialSource(process.execPath + ".missing.exe");
    expect(isCredentialStore(store)).toBe(true);
    expect(await store.get("credential:test")).toBeUndefined();
    expect(await store.get("../outside")).toBeUndefined();
    await expect(store.set("credential:test", "synthetic")).rejects.toThrow();
  });
  it("rejects relative helper paths", () => {
    expect(() => new WindowsCredentialSource("host.exe")).toThrow();
  });
});
