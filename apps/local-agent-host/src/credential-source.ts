import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CredentialStore } from "@agent-workbench/provider-registry";

/** Read-only native source. The absolute executable is supplied by the native host, never config. */
export class WindowsCredentialSource implements CredentialStore {
  constructor(private readonly helperPath: string) {
    if (!isAbsolute(helperPath) || helperPath.includes("\0") || !helperPath.toLowerCase().endsWith(".exe")) throw new Error("Credential helper is invalid.");
  }
  async get(ref: string): Promise<string | undefined> {
    if (typeof ref !== "string" || !/^credential:[a-z][a-z0-9._-]{0,63}$/.test(ref)) return undefined;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let done = false;
      let child: ReturnType<typeof spawn>;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const chunk of chunks) chunk.fill(0);
        resolve(value);
      };
      try {
        child = spawn(this.helperPath, ["--credential-read", ref], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        timer = setTimeout(() => { child.kill(); finish(); }, 5000);
        child.stdout!.on("data", (chunk: Buffer) => {
          if (done) { chunk.fill(0); return; }
          bytes += chunk.length;
          if (bytes > 2560) { chunk.fill(0); child.kill(); finish(); return; }
          chunks.push(chunk);
        });
        child.on("error", () => finish());
        child.on("close", (code) => {
          if (done) return;
          const buffer = Buffer.concat(chunks);
          const value = buffer.toString("utf8");
          buffer.fill(0);
          finish(code === 0 && value.length > 0 && !/[^\x21-\x7e]/.test(value) ? value : undefined);
        });
      } catch { finish(); }
    });
  }
  async has(ref: string): Promise<boolean> { return (await this.get(ref)) !== undefined; }
  async set(_ref: string, _secret: string): Promise<void> { throw new Error("Credential source is read-only."); }
  async delete(_ref: string): Promise<void> { throw new Error("Credential source is read-only."); }
}
