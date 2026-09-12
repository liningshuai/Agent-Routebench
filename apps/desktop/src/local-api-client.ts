import {
  LocalAgentApiClient,
  type LocalAgentClientOptions,
} from "@agent-workbench/local-agent-client";
import type { DesktopApiClient } from "./types.js";

export type LoopbackDesktopApiClientOptions = Pick<
  LocalAgentClientOptions,
  "baseUrl" | "fetch" | "maxLineBytes" | "maxTotalBytes" | "maxBodyBytes"
>;

export function createLoopbackDesktopApiClient(
  options: LoopbackDesktopApiClientOptions,
): DesktopApiClient {
  const client = new LocalAgentApiClient(options);
  return {
    async load(): Promise<void> {
      await client.health();
    },
    async createSession() {
      return client.createSession();
    },
    submitTurn: (sessionId, request, signal) =>
      client.runTurn(sessionId, request, signal),
    async cancelTurn(sessionId, _turnId) {
      await client.cancel(sessionId);
    },
  };
}
