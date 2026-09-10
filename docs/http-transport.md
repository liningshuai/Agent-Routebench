# HTTP 传输与凭据边界（Task 4）

本文件记录 `RoutedHttpModelGateway` 的公开接口、请求构造规则、错误映射与安全边界。

> **本阶段没有任何真实供应商端到端验证。** 生产 transport 代码存在，但所有自动化测试
> 都注入 fake HTTP client，不访问真实网络，也没有验证过真实 API key。

## 1. 公开接口

```ts
export interface HttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export interface RoutedHttpModelGatewayOptions {
  readonly registry: ProviderRegistry;
  readonly credentials: CredentialStore;
  readonly httpClient?: HttpClient;
  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}

export class RoutedHttpModelGateway implements ModelGateway {
  constructor(options: RoutedHttpModelGatewayOptions);
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export function createRoutedHttpModelGateway(
  options: RoutedHttpModelGatewayOptions,
): RoutedHttpModelGateway;

export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient;
```

`http-transport.ts` 另外导出纯辅助函数：`buildProviderUrl`、`buildAnthropicHeaders`、
`buildOpenAIChatHeaders`、`mapHttpStatusToErrorCode`、`releaseResponseBody`、
`ANTHROPIC_MESSAGES_ENDPOINT`、`OPENAI_CHAT_COMPLETIONS_ENDPOINT`，以及
`FetchLike` / `FetchResponseLike` 两个类型。

## 2. 一次 `stream()` 的完整顺序

1. `signal.aborted === true` → 输出一个 `aborted` 并结束（**不查路由、不读凭据、不发请求**）。
2. `registry.resolveRoute(request.routeId)`。
3. 校验 `request.model === resolvedRoute.model`；不一致固定失败。
4. `resolvedRoute.credentialRef === null` → 固定失败，不发请求。
5. `credentials.get(credentialRef)`；缺失或为空 → 固定失败，不发请求。
6. 按 `resolvedRoute.protocol` 选择既有 adapter 并 `encode()`。
7. 拼接固定 URL、构造固定认证头。
8. 调用注入的 `HttpClient` **恰好一次**。
9. 2xx 且 body 非 `null` → 把 body 作为 `AsyncIterable<Uint8Array>` 直接交给既有 decoder。

本阶段**不会**自动尝试其他 Route 或 Provider。

## 3. URL 与请求构造

固定 endpoint：

| protocol | endpoint |
|---|---|
| `anthropic_messages` | `/v1/messages` |
| `openai_compatible` | `/chat/completions` |

- base URL 末尾的 `/` 被去除后再拼接，**不会**产生重复 `//`。
- 拼接结果会重新用 `URL` 解析，只接受 `http:` / `https:` 且不含 userinfo 的地址。
- endpoint 是常量，不能被 `ModelRequest`、Route 或额外字段覆盖。

### 3.1 Anthropic Messages 请求

```text
POST <baseUrl>/v1/messages
content-type: application/json
accept: text/event-stream
anthropic-version: 2023-06-01
x-api-key: <secret>
```

没有 `authorization`，没有用户可配置 headers，body 只来自既有 Anthropic encoder。

### 3.2 OpenAI Chat Completions 请求

```text
POST <baseUrl>/chat/completions
content-type: application/json
accept: text/event-stream
authorization: Bearer <secret>
```

没有 `x-api-key`。只覆盖既有 Chat Completions 子集，**不扩展为 Responses API**。

### 3.3 请求体

- body 是协议 JSON，由既有 adapter 生成；gateway 只做 `JSON.stringify`。
- body **不含** `requestId`、`routeId`、`credentialRef`、`baseUrl`、endpoint、headers 或
  secret。
- 若调用方试图通过额外字段注入 `headers` / `endpoint` / `baseUrl` / `authorization`，
  共享校验器会拒绝该请求（固定 `gateway_error`，且不发任何 HTTP 请求）；其他未知字段
  会被 adapter 丢弃，不会出现在协议 body 中。

## 4. 错误映射

最终错误码只能是 Agent Core 已接受的五个之一。

| 情况 | code | retryable |
|---|---|---:|
| 已取消，或取消导致的请求失败 | `aborted` | false |
| HTTP 429 | `rate_limited` | true |
| HTTP 408 / 425 / 500 / 502 / 503 / 504 | `upstream_unavailable` | true |
| HTTP 客户端抛出的传输异常或 rejected promise | `upstream_unavailable` | true |
| 2xx 但 `body === null` | `provider_protocol_error` | false |
| Adapter 解码失败（非法 SSE / 非法 JSON / 截断） | `provider_protocol_error` | false |
| 其他 HTTP 状态（含其他 4xx、未列出的 5xx、3xx） | `gateway_error` | false |
| Route / Provider / Credential 配置错误 | `gateway_error` | false |
| 编码失败或其他内部异常 | `gateway_error` | false |

规则：

- 错误消息来自 `adapters/errors.ts` 的**固定文案表**，是唯一来源：
  `Request aborted.` / `Upstream provider is currently unavailable.` /
  `The upstream provider rate limited this request.` /
  `The provider stream is outside the supported protocol subset.` /
  `Model gateway request failed.`
- **不使用** HTTP `statusText`、响应 body、原始异常 `message`；Provider 自定义错误码不
  透传；`AbortSignal.reason` 与堆栈不进入事件。
- 每次请求最多一个终止错误事件；错误后不输出 `completed`，也不继续读取上游 body。
- 覆盖到 Agent Core 后，消息统一变成 `Model gateway request failed.`
  （`aborted` 为 `Request aborted.`），符合 Task 1 的固定文案规则。

## 5. 流式与取消

- 响应 body 是增量 `AsyncIterable<Uint8Array>`，直接转交给既有 decoder；**不先收集完整
  响应**。第一个 SSE 事件在第二个上游 chunk 释放之前就可能被观察到。
- 取消检查发生在读取 chunk 之前、推进帧迭代器之前、以及每次事件 yield 恢复之后
  （Task 3 的运行时保证）。
- 预取消：**不调用** `resolveRoute()` 之后的任何一步，不读凭据，不调用 `HttpClient`，
  只输出一个 `aborted`。
- 中途取消：同一个 `AbortSignal` 传给 `HttpClient`；等待响应期间用信号竞速，因此即使
  HTTP 客户端永远不 settle 也能立即结束；body 的迭代器被 `return()` 释放。
- 上游 body 的 `return()` 若悬挂，**不会被等待**，不会阻塞对外结束。
- 迟到的响应或迟到的失败都有 rejection handler；不产生 unhandled rejection。
- 一个 Gateway 实例可以并发处理多个请求：route、secret、decoder 状态与 `AbortSignal`
  都不共享。

## 6. 凭据边界

- secret 只在**单次 `HttpRequest.headers`** 中存在，随请求交给 `HttpClient`。
- secret **不进入**：`ModelRequest`、`ProviderDefinition`、`RouteDefinition`、
  `ResolvedRoute`、encoded body、`ModelStreamEvent`、`AgentEvent`、错误消息、日志。
- `credentialRef` 只是引用（`credential:<id>`），**永远不是秘密本身**。
- 非 2xx 响应的 body 会被释放但**从不读取**，因此敌对响应体无法通过错误路径外泄。
- `ProviderRegistry` / `CredentialStore` 本身仍然不打印、不持久化、不联网。
- 当前 `CredentialStore` 只有 Task 2 的内存测试实现，生产级 OS Keychain
  **尚未实现**。

## 7. 依赖边界

- `model-gateway` 依赖 `@agent-workbench/agent-contracts` 与
  `@agent-workbench/provider-registry`（均为公开 workspace 接口）。
- `model-gateway` **不依赖** `agent-core`，也不使用任何跨包 `src` 穿透导入。
- `provider-registry` 保持零依赖，且不反向依赖 `model-gateway`。
- 未新增 axios、undici、node-fetch、Provider SDK 或数据库依赖。
- 全局 `fetch` 只在 `http-transport.ts` 中被引用。
- 协议 adapter 目录保持纯转换：不含 `CredentialStore`、`credentialRef`、
  `provider-registry` 或全局 `fetch`。

## 8. 尚未实现

重试、故障转移、多 Provider fallback、Provider 轮换、探活、模型列表请求、
Provider / Route / 凭据持久化、OS Keychain、Agent Loop、多轮模型调用、工具执行、
审批、Desktop / Tauri、CLI、Memory、上下文压缩、真实供应商端到端验证。
