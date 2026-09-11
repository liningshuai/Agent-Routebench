import { describe, expect, it } from "vitest";
import { createProviderDiscovery } from "../packages/provider-discovery/src/index.js";
import {
  anthropicModelsBody,
  bodyFromChunks,
  bodyFromText,
  fakeHttpClient,
  makeAnthropicProvider,
  makeCredentialStore,
  makeRegistry,
  openaiModelsBody,
} from "./helpers/provider-discovery-fixtures.js";

async function discoveryWith(
  status: number,
  body: AsyncIterable<Uint8Array> | null,
) {
  const registry = await makeRegistry([makeAnthropicProvider()]);
  const credentialStore = await makeCredentialStore();
  const { client, calls } = fakeHttpClient(() => ({ status, body }));
  const discovery = createProviderDiscovery({
    registry,
    credentialStore,
    httpClient: client,
  });
  return { discovery, calls };
}

describe("task 10 http status mapping", () => {
  it("maps 401 to unauthorized", async () => {
    const { discovery, calls } = await discoveryWith(401, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unauthorized",
    });
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(calls).toHaveLength(2);
  });

  it("maps 403 to unauthorized", async () => {
    const { discovery } = await discoveryWith(403, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unauthorized",
    });
  });

  it("maps 429 to rate_limited", async () => {
    const { discovery } = await discoveryWith(429, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "rate_limited",
    });
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps 500 to unavailable", async () => {
    const { discovery } = await discoveryWith(500, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("maps 502 to unavailable", async () => {
    const { discovery } = await discoveryWith(502, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("maps 503 to unavailable", async () => {
    const { discovery } = await discoveryWith(503, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("maps 504 to unavailable", async () => {
    const { discovery } = await discoveryWith(504, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("maps 408 to unavailable", async () => {
    const { discovery } = await discoveryWith(408, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("maps other non-2xx to unavailable", async () => {
    const { discovery } = await discoveryWith(418, null);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("does not read the body for non-2xx responses", async () => {
    const body = bodyFromText("secret-leak-url https://evil.example.com");
    let nextCalls = 0;
    const tracked = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of body) {
          nextCalls += 1;
          yield chunk;
        }
      },
    };
    const { discovery } = await discoveryWith(401, tracked);
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "unauthorized",
    });
    expect(nextCalls).toBe(0);
  });
});

describe("task 10 protocol errors", () => {
  it("rejects unparseable JSON", async () => {
    const { discovery } = await discoveryWith(200, bodyFromText("{not-json"));
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject({
      status: "protocol_error",
    });
  });

  it("rejects a non-object JSON top level", async () => {
    const { discovery } = await discoveryWith(200, bodyFromText("[1,2,3]"));
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects a missing data field", async () => {
    const { discovery } = await discoveryWith(200, bodyFromText("{}"));
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects a non-array data field", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(JSON.stringify({ data: {} })),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects a non-object model item", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(JSON.stringify({ data: ["nope"] })),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects a missing model id", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(JSON.stringify({ data: [{ object: "model" }] })),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects an empty model id", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(JSON.stringify({ data: [{ id: "" }] })),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects a non-string model id", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(JSON.stringify({ data: [{ id: 42 }] })),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects duplicate model ids", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(
        JSON.stringify({ data: [{ id: "dup" }, { id: "dup" }] }),
      ),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "duplicate_model_id",
    });
  });

  it("rejects a non-finite created field", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(
        JSON.stringify({ data: [{ id: "m1", created: "soon" }] }),
      ),
    );
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("accepts an empty data array", async () => {
    const { discovery } = await discoveryWith(
      200,
      bodyFromText(JSON.stringify({ data: [] })),
    );
    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.models).toEqual([]);
  });

  it("rejects a body larger than the configured maximum", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const big = anthropicModelsBody() + "x".repeat(256);
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(big),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
      maxResponseBytes: 64,
    });
    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("rejects invalid maxResponseBytes", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    expect(() =>
      createProviderDiscovery({
        registry,
        credentialStore,
        httpClient: client,
        maxResponseBytes: 0,
      }),
    ).toThrow(/discovery options are invalid/);
    expect(() =>
      createProviderDiscovery({
        registry,
        credentialStore,
        httpClient: client,
        maxResponseBytes: 1.5,
      }),
    ).toThrow(/discovery options are invalid/);
  });
});

describe("task 10 protocol normalization", () => {
  it("normalizes Anthropic display_name and created_at", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(anthropicModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.models[0]).toEqual({
      id: "claude-3-5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      createdAt: "2025-01-01T00:00:00Z",
    });
  });

  it("normalizes OpenAI created and owned_by", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(openaiModelsBody()),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    // openai body against anthropic provider still parses as catalog data
    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.models[0]).toEqual({
      id: "gpt-4o",
      created: 1710000000,
      ownedBy: "openai",
    });
  });

  it("preserves model order", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(
        JSON.stringify({
          data: [{ id: "z-model" }, { id: "a-model" }, { id: "m-model" }],
        }),
      ),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.models.map((m) => m.id)).toEqual([
      "z-model",
      "a-model",
      "m-model",
    ]);
  });

  it("does not return unknown raw fields", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromText(
        JSON.stringify({
          data: [
            {
              id: "m1",
              type: "model",
              display_name: "M1",
              created_at: "2025-01-01T00:00:00Z",
              mystery: "drop-me",
              permission: [],
            },
          ],
        }),
      ),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.models[0]).toEqual({
      id: "m1",
      displayName: "M1",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(JSON.stringify(catalog)).not.toContain("mystery");
  });

  it("reassembles multi-chunk UTF-8 bodies", async () => {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const text = JSON.stringify({
      data: [{ id: "模型-🚀", display_name: "中文名称" }],
    });
    const encoder = new TextEncoder();
    const full = encoder.encode(text);
    const mid = Math.floor(full.length / 2);
    const chunks = [full.slice(0, mid), full.slice(mid)];
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromChunks(chunks),
    }));
    const discovery = createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
    const catalog = await discovery.listModels("anthropic-main");
    expect(catalog.models[0]?.id).toBe("模型-🚀");
    expect(catalog.models[0]?.displayName).toBe("中文名称");
  });
});

describe("task 10 invalid UTF-8 rejection", () => {
  async function discoveryWithRawBytes(chunks: Uint8Array[]) {
    const registry = await makeRegistry([makeAnthropicProvider()]);
    const credentialStore = await makeCredentialStore();
    const { client } = fakeHttpClient(() => ({
      status: 200,
      body: bodyFromChunks(chunks),
    }));
    return createProviderDiscovery({
      registry,
      credentialStore,
      httpClient: client,
    });
  }

  it("rejects invalid UTF-8 bytes inside a JSON string value", async () => {
    // 0xFF is never valid in UTF-8. Embed it inside display_name.
    const prefix = new TextEncoder().encode(
      '{"data":[{"id":"model","display_name":"',
    );
    const invalid = new Uint8Array([0xff]);
    const suffix = new TextEncoder().encode('"}]}');
    const discovery = await discoveryWithRawBytes([prefix, invalid, suffix]);

    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
    await expect(discovery.checkProvider("anthropic-main")).resolves.toMatchObject(
      { status: "protocol_error" },
    );
  });

  it("rejects invalid UTF-8 split across chunks", async () => {
    // C3 28 is an invalid two-byte sequence; split so each chunk alone looks
    // incomplete and the decoder must still reject the stream.
    const prefix = new TextEncoder().encode('{"data":[{"id":"x","display_name":"');
    const broken = new Uint8Array([0xc3, 0x28]);
    const suffix = new TextEncoder().encode('"}]}');
    const discovery = await discoveryWithRawBytes([
      prefix,
      broken.slice(0, 1),
      broken.slice(1),
      suffix,
    ]);

    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("rejects invalid UTF-8 outside a JSON string while still looking like JSON", async () => {
    // Valid JSON prefix, then a lone 0xC0 (always invalid), then more JSON text.
    const text = new TextEncoder().encode('{"data":[]}');
    const withGarbage = new Uint8Array(text.length + 1);
    withGarbage.set(text, 0);
    withGarbage[text.length] = 0xc0;
    const discovery = await discoveryWithRawBytes([withGarbage]);

    await expect(discovery.listModels("anthropic-main")).rejects.toMatchObject({
      code: "provider_protocol_error",
    });
  });

  it("does not return a catalog containing the replacement character", async () => {
    const prefix = new TextEncoder().encode('{"data":[{"id":"m1","display_name":"');
    const invalid = new Uint8Array([0xed, 0xa0, 0x80]);
    const suffix = new TextEncoder().encode('"}]}');
    const discovery = await discoveryWithRawBytes([prefix, invalid, suffix]);

    let result: unknown;
    try {
      result = await discovery.listModels("anthropic-main");
    } catch (error) {
      expect(error).toMatchObject({ code: "provider_protocol_error" });
      return;
    }
    // If it somehow resolved, it must not contain U+FFFD.
    expect(JSON.stringify(result)).not.toContain("�");
  });
});
