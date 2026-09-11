import type { AgentEvent } from "@agent-workbench/agent-core";
import type { LocalAgentSession, LocalAgentTurnRequest } from "@agent-workbench/local-agent-api";
import { failCli } from "./errors.js";
import { parseNDJSONStream } from "./ndjson.js";

export type CliFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class LocalAgentApiClient {
  readonly #baseUrl: string;
  readonly #fetch: CliFetch;

  constructor(baseUrl: string, fetch: CliFetch) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetch;
  }

  async health(signal?: AbortSignal): Promise<unknown> {
    const response = await this.#fetchJson("GET", "/health", undefined, signal);
    return response;
  }

  async createSession(signal?: AbortSignal): Promise<LocalAgentSession> {
    const response = await this.#fetchJson("POST", "/v1/sessions", {}, signal);
    
    // Server wraps session in { session: {...} }
    if (response && typeof response === "object" && "session" in response) {
      return this.#validateSession((response as { session: unknown }).session);
    }
    
    return this.#validateSession(response);
  }

  async getSession(id: string, signal?: AbortSignal): Promise<LocalAgentSession> {
    const response = await this.#fetchJson("GET", `/v1/sessions/${id}`, undefined, signal);
    
    // Server wraps session in { session: {...} }
    if (response && typeof response === "object" && "session" in response) {
      return this.#validateSession((response as { session: unknown }).session);
    }
    
    return this.#validateSession(response);
  }

  async listEvents(id: string, signal?: AbortSignal): Promise<readonly AgentEvent[]> {
    const response = await this.#fetchJson("GET", `/v1/sessions/${id}/events`, undefined, signal);
    if (!Array.isArray(response)) {
      failCli("apiProtocolError");
    }
    return response as readonly AgentEvent[];
  }

  async cancel(id: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.#fetchJson("POST", `/v1/sessions/${id}/cancel`, {}, signal);
    return response;
  }

  async *runTurn(
    id: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const url = `${this.#baseUrl}/v1/sessions/${id}/turns`;
    
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        failCli("aborted");
      }
      failCli("apiUnavailable");
    }

    if (!response.ok) {
      failCli("apiHttpError");
    }

    if (!response.body) {
      failCli("apiProtocolError");
    }

    yield* parseNDJSONStream(response.body, signal);
  }

  async #fetchJson(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    
    const init: RequestInit = {
      method,
      signal,
    };

    if (body !== undefined) {
      init.headers = {
        "Content-Type": "application/json",
      };
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        failCli("aborted");
      }
      failCli("apiUnavailable");
    }

    if (!response.ok) {
      failCli("apiHttpError");
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      failCli("apiProtocolError");
    }

    return json;
  }

  #validateSession(value: unknown): LocalAgentSession {
    if (!value || typeof value !== "object") {
      failCli("apiProtocolError");
    }

    const obj = value as Record<string, unknown>;
    
    if (
      typeof obj.id !== "string" ||
      typeof obj.status !== "string" ||
      typeof obj.createdAt !== "number" ||
      typeof obj.updatedAt !== "number"
    ) {
      failCli("apiProtocolError");
    }

    if (obj.activeTurnId !== undefined && typeof obj.activeTurnId !== "string") {
      failCli("apiProtocolError");
    }

    return obj as unknown as LocalAgentSession;
  }
}
