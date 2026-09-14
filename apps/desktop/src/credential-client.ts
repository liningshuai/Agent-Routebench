import type { TauriInvoke } from "./config-client.js";
import { TAURI_COMMANDS } from "./tauri-api-client.js";

export interface DesktopCredentialClient {
  set(credentialRef: string, secret: string): Promise<void>;
  has(credentialRef: string): Promise<boolean>;
  delete(credentialRef: string): Promise<void>;
}

const fail = (): Error => new Error("Credential operation failed.");
export function createDesktopCredentialClient(options: { invoke: TauriInvoke }): DesktopCredentialClient {
  async function call(command: string, credentialRef: string, secret?: string): Promise<unknown> {
    if (typeof credentialRef !== "string" || !/^credential:[a-z][a-z0-9._-]{0,63}$/.test(credentialRef)) throw fail();
    if (secret !== undefined && (secret.length === 0 || new TextEncoder().encode(secret).length > 2560 || /[^\x21-\x7e]/.test(secret))) throw fail();
    try {
      return await options.invoke(command, { credentialRef, ...(secret === undefined ? {} : { secret }) });
    } catch { throw fail(); }
  }
  return {
    async set(ref, secret) { if (typeof secret !== "string") throw fail(); const reply = await call(TAURI_COMMANDS.setCredential, ref, secret); if (reply !== null) throw fail(); },
    async has(ref) { const reply = await call(TAURI_COMMANDS.hasCredential, ref); if (typeof reply !== "boolean") throw fail(); return reply; },
    async delete(ref) { const reply = await call(TAURI_COMMANDS.deleteCredential, ref); if (reply !== null) throw fail(); },
  };
}
