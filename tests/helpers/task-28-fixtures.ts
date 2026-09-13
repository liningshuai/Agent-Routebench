import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import type { AgentEvent } from "../../packages/agent-core/src/index.js";
import type { PersistedConfigV1 } from "../../packages/local-persistence/src/index.js";
import type { CredentialBackend } from "../../packages/provider-registry/src/index.js";
import { createSecureCredentialStore } from "../../packages/provider-registry/src/index.js";
import type { CredentialStore } from "../../packages/provider-registry/src/index.js";

/* ------------------------------------------------------------------ *
 * Task 28 neutral offline fixtures.
 *
 * Everything below is invented for these tests. The credential values are
 * deliberately short, obviously synthetic strings so the repository secret
 * scanner never mistakes them for a real secret.
 * ------------------------------------------------------------------ */

export const T28_PROVIDER_ID = "provider-t28";
export const T28_ROUTE_ID = "route-t28";
export const T28_MODEL = "offline-model";
export const T28_CREDENTIAL_REF = "credential:t28";
/** Synthetic secret. Never a real credential. */
export const T28_SECRET = "t28-synthetic-credential";
/** A second synthetic secret used to prove failover never reuses the first. */
export const T28_FALLBACK_SECRET = "t28-synthetic-fallback";
export const T28_FALLBACK_PROVIDER_ID = "provider-t28-b";
export const T28_BASE_URL = "https://api.t28.test";
export const T28_FALLBACK_BASE_URL = "https://api.t28-b.test";

/** Builds the non-sensitive provider entry used by the config file. */
export function t28Provider(
  overrides: Partial<{
    id: string;
    baseUrl: string;
    credentialRef: string | null;
    models: string[];
    enabled: boolean;
    protocol: "anthropic_messages" | "openai_compatible";
  }> = {},
): PersistedConfigV1["providers"][number] {
  return {
    id: overrides.id ?? T28_PROVIDER_ID,
    name: "Provider T28",
    protocol: overrides.protocol ?? "anthropic_messages",
    baseUrl: overrides.baseUrl ?? T28_BASE_URL,
    credentialRef:
      overrides.credentialRef === undefined
        ? T28_CREDENTIAL_REF
        : overrides.credentialRef,
    models: overrides.models ?? [T28_MODEL],
    enabled: overrides.enabled ?? true,
  };
}

export function t28Route(
  overrides: Partial<{
    id: string;
    providerId: string;
    model: string;
    enabled: boolean;
    fallbackProviderIds: string[];
  }> = {},
): PersistedConfigV1["routes"][number] {
  return {
    id: overrides.id ?? T28_ROUTE_ID,
    name: "Route T28",
    providerId: overrides.providerId ?? T28_PROVIDER_ID,
    model: overrides.model ?? T28_MODEL,
    enabled: overrides.enabled ?? true,
    ...(overrides.fallbackProviderIds === undefined
      ? {}
      : { fallbackProviderIds: overrides.fallbackProviderIds }),
  };
}

export function t28Snapshot(
  providers: PersistedConfigV1["providers"] = [t28Provider()],
  routes: PersistedConfigV1["routes"] = [t28Route()],
): PersistedConfigV1 {
  return { version: 1, providers, routes };
}

export interface TempConfig {
  readonly dir: string;
  readonly filePath: string;
  dispose(): Promise<void>;
}

/** Creates an isolated temp directory for a config file. */
export async function createTempConfigDir(): Promise<TempConfig> {
  const dir = await mkdtemp(join(tmpdir(), "task28-"));
  return {
    dir,
    filePath: join(dir, "config.json"),
    async dispose(): Promise<void> {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Writes a validated snapshot to disk as pretty JSON. */
export async function writeSnapshot(
  filePath: string,
  snapshot: PersistedConfigV1,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

/** Allocates an ephemeral loopback port, then releases it. */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("no port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface RecordedCredentialCall {
  readonly op: "get" | "set" | "has" | "delete";
  readonly ref: string;
}

export interface RecordingCredentialBackend {
  readonly backend: CredentialBackend;
  readonly calls: () => readonly RecordedCredentialCall[];
  readonly gets: () => number;
  readonly store: () => CredentialStore;
}

/**
 * Fake, purely in-memory CredentialBackend that records every operation so
 * the "read only on demand" boundary can be asserted.
 */
export function createRecordingCredentialBackend(
  initial: Readonly<Record<string, string>> = {},
): RecordingCredentialBackend {
  const values = new Map<string, string>(Object.entries(initial));
  const calls: RecordedCredentialCall[] = [];
  const backend: CredentialBackend = {
    get(ref: string): string | undefined {
      calls.push({ op: "get", ref });
      return values.get(ref);
    },
    set(ref: string, secret: string): void {
      calls.push({ op: "set", ref });
      values.set(ref, secret);
    },
    has(ref: string): boolean {
      calls.push({ op: "has", ref });
      return values.has(ref);
    },
    delete(ref: string): void {
      calls.push({ op: "delete", ref });
      values.delete(ref);
    },
  };
  return {
    backend,
    calls: () => [...calls],
    gets: () => calls.filter((call) => call.op === "get").length,
    store: () => createSecureCredentialStore({ backend }),
  };
}

export interface TurnStreamResult {
  readonly status: number;
  readonly turnId: string | null;
  readonly raw: string;
  readonly events: readonly AgentEvent[];
}

/** Reads a turn NDJSON response fully, keeping the raw text for leak checks. */
export async function readTurnStream(response: Response): Promise<TurnStreamResult> {
  const raw = await response.text();
  const events: AgentEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    events.push(JSON.parse(line) as AgentEvent);
  }
  return {
    status: response.status,
    turnId: response.headers.get("x-agent-turn-id"),
    raw,
    events,
  };
}

/** POSTs a turn request and returns the parsed NDJSON stream. */
export async function runTurn(
  baseUrl: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<TurnStreamResult> {
  const response = await fetch(`${baseUrl}/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readTurnStream(response);
}

/** POSTs a new session and returns its id. */
export async function createSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = (await response.json()) as { session: { id: string } };
  return payload.session.id;
}

/** The default turn body used across the Task 28 suites. */
export function t28TurnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    routeId: T28_ROUTE_ID,
    model: T28_MODEL,
    ...overrides,
  };
}

/** Extracts the types of a stream in order. */
export function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}
