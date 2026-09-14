import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { WindowsCredentialSource } from "../apps/local-agent-host/src/credential-source.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
function processFixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}
describe("credential subprocess limits", () => {
  it("passes only ref on a shell-free private pipe and returns valid output", async () => {
    const child = processFixture();
    const result = new WindowsCredentialSource(process.execPath).get("credential:test");
    child.stdout.write("synthetic-value");
    child.emit("close", 0);
    expect(await result).toBe("synthetic-value");
    expect(spawn).toHaveBeenCalledWith(process.execPath, ["--credential-read", "credential:test"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  });
  it("kills oversized output and never returns a partial key", async () => {
    const child = processFixture();
    const result = new WindowsCredentialSource(process.execPath).get("credential:test");
    child.stdout.write("a".repeat(2561));
    expect(await result).toBeUndefined();
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it("kills a stuck helper after the fixed timeout", async () => {
    vi.useFakeTimers();
    const child = processFixture();
    const result = new WindowsCredentialSource(process.execPath).get("credential:test");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBeUndefined();
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it.each([[0, "a\nb"], [2, "synthetic-value"], [0, ""]])("rejects failed or malformed responses (%s)", async (code, value) => {
    const child = processFixture();
    const result = new WindowsCredentialSource(process.execPath).get("credential:test");
    child.stdout.write(value);
    child.emit("close", code);
    expect(await result).toBeUndefined();
  });
});
