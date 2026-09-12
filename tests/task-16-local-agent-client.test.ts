import { describe, expect, it } from "vitest";
import {
  LocalAgentApiClient,
  LocalAgentClientError,
  LOCAL_AGENT_CLIENT_ERROR_CODES,
} from "../packages/local-agent-client/src/index.js";
import {
  jsonResponse,
  session,
  streamResponse,
  textEvent,
  completedEvent,
  userRequest,
} from "./helpers/local-agent-client-fixtures.js";

function captureFetch(response: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return response;
  };
  return { calls, fetch };
}

describe("Task 16 shared Local Agent API client", () => {
  it("accepts loopback URLs and removes one trailing slash", async () => {
    const { calls, fetch } = captureFetch(jsonResponse({ ok: true }));
    const client = new LocalAgentApiClient("http://127.0.0.1:4317/", fetch);

    await client.health();

    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/health");
  });

  it.each([
    "https://127.0.0.1:4317",
    "http://192.168.1.2:4317",
    "http://evil.example:4317",
    "http://user:pass@127.0.0.1:4317",
    "http://127.0.0.1:4317/?token=secret",
    "not a URL",
  ])("rejects non-loopback base URL %s", (baseUrl) => {
    expect(() => new LocalAgentApiClient(baseUrl, async () => jsonResponse({}))).toThrowError(
      LocalAgentClientError,
    );
    try {
      new LocalAgentApiClient(baseUrl, async () => jsonResponse({}));
    } catch (error) {
      expect(error).toMatchObject({
        code: LOCAL_AGENT_CLIENT_ERROR_CODES.invalidBaseUrl,
        message: "Local API URL is invalid.",
      });
    }
  });

  it("creates a session with an empty JSON body and unwraps the response", async () => {
    const { calls, fetch } = captureFetch(jsonResponse({ session: session("created") }));
    const client = new LocalAgentApiClient("http://localhost:4317", fetch);

    await expect(client.createSession()).resolves.toEqual(session("created"));
    expect(calls[0]?.url).toBe("http://localhost:4317/v1/sessions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("{}");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("gets a session and unwraps the response", async () => {
    const { calls, fetch } = captureFetch(jsonResponse({ session: session("s 1") }));
    const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

    await expect(client.getSession("s 1")).resolves.toEqual(session("s 1"));
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/v1/sessions/s%201");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("unwraps the events response envelope", async () => {
    const events = [textEvent(), completedEvent()];
    const { fetch } = captureFetch(jsonResponse({ sessionId: "sess-1", events }));
    const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

    await expect(client.listEvents("sess-1")).resolves.toEqual(events);
  });

  it("sends only the allowed turn fields", async () => {
    const { calls, fetch } = captureFetch(streamResponse([completedEvent()]));
    const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

    for await (const _event of client.runTurn("sess-1", {
      ...userRequest("hello"),
      routeId: "route-1",
      model: "model-1",
      maxTokens: 20,
    })) {
      // consume
    }

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      messages: userRequest("hello").messages,
      routeId: "route-1",
      model: "model-1",
      maxTokens: 20,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/v1/sessions/sess-1/turns");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("posts an empty JSON body to cancel", async () => {
    const { calls, fetch } = captureFetch(jsonResponse({ ok: true }));
    const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

    await client.cancel("sess-1");

    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/v1/sessions/sess-1/cancel");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe("{}");
  });

  it("supports class instances as injected fetch owners", async () => {
    class FetchOwner {
      async call(_url: string, _init?: RequestInit): Promise<Response> {
        return jsonResponse({ ok: true });
      }
    }
    const owner = new FetchOwner();
    const client = new LocalAgentApiClient(
      "http://localhost:4317",
      owner.call.bind(owner),
    );

    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  it("maps malformed JSON to a fixed protocol error", async () => {
    const { fetch } = captureFetch(new Response("not-json", { status: 200 }));
    const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

    await expect(client.health()).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiProtocolError,
      message: "Local Agent API returned invalid data.",
    });
  });

  it("maps non-2xx responses without consuming the error body", async () => {
    let nextCalls = 0;
    let cancelCalls = 0;
    const body = {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
      getReader() {
        return {
          read() {
            nextCalls += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
          releaseLock() {
            // no-op
          },
        };
      },
    };
    const { fetch } = captureFetch({
      ok: false,
      status: 500,
      body,
    } as unknown as Response);
    const client = new LocalAgentApiClient("http://127.0.0.1:4317", fetch);

    await expect(client.health()).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiHttpError,
      message: "Local Agent API request failed.",
    });
    expect(nextCalls).toBe(0);
    expect(cancelCalls).toBe(1);
  });

  it("maps fetch failures to a fixed unavailable error", async () => {
    const client = new LocalAgentApiClient(
      "http://127.0.0.1:4317",
      async () => {
        throw new Error("SECRET URL and stack");
      },
    );

    await expect(client.health()).rejects.toMatchObject({
      code: LOCAL_AGENT_CLIENT_ERROR_CODES.apiUnavailable,
      message: "Local Agent API is unavailable.",
    });
  });

  it.each([
    { maxLineBytes: 0 },
    { maxTotalBytes: 0 },
    { maxBodyBytes: 0 },
    { maxLineBytes: Number.POSITIVE_INFINITY },
    { maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxBodyBytes: 17 * 1024 * 1024 },
  ])("rejects invalid response limits: %o", (limits) => {
    expect(
      () => new LocalAgentApiClient({
        baseUrl: "http://127.0.0.1:4317",
        ...limits,
      }),
    ).toThrowError(LocalAgentClientError);
  });
});
