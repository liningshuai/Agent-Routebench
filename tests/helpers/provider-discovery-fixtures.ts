import type {
  CredentialStore,
  ProviderDefinition,
  ProviderRegistry,
} from "../../packages/provider-registry/src/index.js";
import {
  InMemoryCredentialStore,
  InMemoryProviderRegistry,
} from "../../packages/provider-registry/src/index.js";
import type {
  DiscoveryHttpClient,
  DiscoveryHttpRequest,
  DiscoveryHttpResponse,
} from "../../packages/provider-discovery/src/index.js";

export const ANTHROPIC_BASE = "https://api.anthropic.com";
export const OPENAI_BASE = "https://api.openai.com/v1";
export const FIXTURE_SECRET = "fixture-credential-value";

export function makeAnthropicProvider(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "anthropic-main",
    name: "Anthropic Main",
    protocol: "anthropic_messages",
    baseUrl: ANTHROPIC_BASE,
    credentialRef: "credential:anthropic-main",
    models: ["claude-3-5-sonnet"],
    enabled: true,
    ...overrides,
  };
}

export function makeOpenAIProvider(
  overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    id: "openai-main",
    name: "OpenAI Main",
    protocol: "openai_compatible",
    baseUrl: OPENAI_BASE,
    credentialRef: "credential:openai-main",
    models: ["gpt-4o"],
    enabled: true,
    ...overrides,
  };
}

export async function makeRegistry(
  providers: readonly ProviderDefinition[] = [
    makeAnthropicProvider(),
    makeOpenAIProvider(),
  ],
): Promise<ProviderRegistry> {
  const registry = new InMemoryProviderRegistry();
  for (const provider of providers) {
    registry.registerProvider(provider);
  }
  return registry;
}

export async function makeCredentialStore(
  entries: Record<string, string> = {
    "credential:anthropic-main": FIXTURE_SECRET,
    "credential:openai-main": FIXTURE_SECRET,
  },
): Promise<CredentialStore> {
  const store = new InMemoryCredentialStore();
  for (const [ref, secret] of Object.entries(entries)) {
    await store.set(ref, secret);
  }
  return store;
}

export function anthropicModelsBody(): string {
  return JSON.stringify({
    data: [
      {
        id: "claude-3-5-sonnet",
        type: "model",
        display_name: "Claude 3.5 Sonnet",
        created_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "claude-3-5-haiku",
        type: "model",
        display_name: "Claude 3.5 Haiku",
        created_at: "2025-01-02T00:00:00Z",
      },
    ],
  });
}

export function openaiModelsBody(): string {
  return JSON.stringify({
    object: "list",
    data: [
      {
        id: "gpt-4o",
        object: "model",
        created: 1710000000,
        owned_by: "openai",
      },
      {
        id: "gpt-4o-mini",
        object: "model",
        created: 1710000001,
        owned_by: "openai",
      },
    ],
  });
}

export function bytesOf(text: string): Uint8Array[] {
  return [new TextEncoder().encode(text)];
}

export function bodyFromText(text: string): AsyncIterable<Uint8Array> {
  const chunks = bytesOf(text);
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

export function bodyFromChunks(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> & { nextCalls: number; released: boolean } {
  let index = 0;
  let nextCalls = 0;
  let released = false;
  return {
    get nextCalls() {
      return nextCalls;
    },
    get released() {
      return released;
    },
    async *[Symbol.asyncIterator]() {
      try {
        while (index < chunks.length) {
          nextCalls += 1;
          const chunk = chunks[index];
          index += 1;
          if (chunk !== undefined) {
            yield chunk;
          }
        }
      } finally {
        released = true;
      }
    },
  };
}

export interface FakeHttpCall {
  readonly request: DiscoveryHttpRequest;
}

export function fakeHttpClient(
  respond: (request: DiscoveryHttpRequest) => Promise<DiscoveryHttpResponse> | DiscoveryHttpResponse,
): {
  client: DiscoveryHttpClient;
  calls: FakeHttpCall[];
} {
  const calls: FakeHttpCall[] = [];
  const client: DiscoveryHttpClient = async (request) => {
    calls.push({ request });
    return respond(request);
  };
  return { client, calls };
}

export function trackingCredentialStore(
  inner: CredentialStore,
): CredentialStore & { getCalls: string[]; setCalls: number; deleteCalls: number } {
  const getCalls: string[] = [];
  let setCalls = 0;
  let deleteCalls = 0;
  return {
    getCalls,
    get setCalls() {
      return setCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
    async get(ref) {
      getCalls.push(ref);
      return inner.get(ref);
    },
    async set(ref, secret) {
      setCalls += 1;
      return inner.set(ref, secret);
    },
    async has(ref) {
      return inner.has(ref);
    },
    async delete(ref) {
      deleteCalls += 1;
      return inner.delete(ref);
    },
  };
}

export function trackingRegistry(
  inner: ProviderRegistry,
): ProviderRegistry & { registerCalls: number; updateCalls: number } {
  let registerCalls = 0;
  let updateCalls = 0;
  return {
    get registerCalls() {
      return registerCalls;
    },
    get updateCalls() {
      return updateCalls;
    },
    registerProvider(provider) {
      registerCalls += 1;
      inner.registerProvider(provider);
    },
    updateProvider(provider) {
      updateCalls += 1;
      inner.updateProvider(provider);
    },
    removeProvider(id) {
      inner.removeProvider(id);
    },
    getProvider(id) {
      return inner.getProvider(id);
    },
    listProviders() {
      return inner.listProviders();
    },
    registerRoute(route) {
      inner.registerRoute(route);
    },
    updateRoute(route) {
      inner.updateRoute(route);
    },
    removeRoute(id) {
      inner.removeRoute(id);
    },
    getRoute(id) {
      return inner.getRoute(id);
    },
    listRoutes() {
      return inner.listRoutes();
    },
    resolveRoute(id) {
      return inner.resolveRoute(id);
    },
    resolveRouteCandidates(id) {
      return inner.resolveRouteCandidates(id);
    },
  };
}
