# 重试、故障转移与 Provider 候选（Task 5）

本文件记录 `ResilientRoutedHttpModelGateway` 的候选解析、重试、故障转移、取消与
安全边界。

> **本阶段没有任何真实供应商端到端验证。** 所有自动化测试都注入 fake HTTP client 与
> 注入式 `wait`，不访问真实网络，也没有验证过真实 API key、真实供应商限流或真实供应商错误。

## 1. 公开接口

```ts
// @agent-workbench/provider-registry
export const MAX_ROUTE_FALLBACKS = 4;              // 4

export interface RouteDefinition {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly fallbackProviderIds?: readonly string[]; // 有序候选，缺省等价于 []
}

export interface ProviderRegistry {
  resolveRoute(routeId: string): ResolvedRoute;
  resolveRouteCandidates(routeId: string): readonly ResolvedRoute[];
}

// @agent-workbench/model-gateway
export interface RetryPolicy {
  readonly maxAttemptsPerProvider: number;
  readonly maxTotalAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy;          // 2 / 8 / 250 / 2000
export const RETRYABLE_STREAM_ERROR_CODES: ReadonlySet<string>;
export const RESILIENCE_ERROR_CODES;                     // { invalidResilienceOptions }
export class ResilienceOptionError extends Error;        // code === "invalid_resilience_options"
export type RetryWait = (delayMs: number, signal?: AbortSignal) => Promise<void>;
export const defaultRetryWait: RetryWait;

export function computeBackoffDelayMs(policy: RetryPolicy, retryIndex: number): number;
export function isRetryableStreamError(event: ModelStreamEvent): boolean;
export function isVisibleStreamEvent(
  event: ModelStreamEvent,
): event is Exclude<ModelStreamEvent, { type: "error" }>;
export function normalizeRetryPolicy(input?: Partial<RetryPolicy>): RetryPolicy;

export interface ResilientRoutedHttpModelGatewayOptions
  extends RoutedHttpModelGatewayOptions {
  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly wait?: RetryWait;
}

export class ResilientRoutedHttpModelGateway implements ModelGateway { /* ... */ }
export function createResilientRoutedHttpModelGateway(
  options: ResilientRoutedHttpModelGatewayOptions,
): ResilientRoutedHttpModelGateway;
```

`createRoutedHttpModelGateway()`（Task 4）保持**单 Route、单 Provider、单次 HTTP**
行为不变；重试与故障转移只由新的 `ResilientRoutedHttpModelGateway` 提供。

## 2. Route fallback 数据模型

- `providerId` 是首选 Provider；`fallbackProviderIds` 是有序候选列表。
- 缺省（未配置）时该字段**不写入**存储对象，语义上等价于空数组。
- 上限 `MAX_ROUTE_FALLBACKS = 4`，超过即拒绝。
- 每个条目必须是合法 Provider ID（`^[a-z][a-z0-9._-]{0,63}$`），不得重复，也不得
  重复主 Provider。
- fallback 是**非敏感配置**：只保存 Provider ID，不保存 URL、header、credential value。
- 新的稳定错误码：

| code | 含义 |
|---|---|
| `invalid_fallback_provider_ids` | 列表不是数组、条目不是合法 Provider ID，或条目形似秘密 |
| `duplicate_fallback_provider_id` | 列表内重复，或重复主 Provider |
| `fallback_provider_not_found` | fallback Provider 未注册 |
| `fallback_model_not_available` | fallback Provider 不提供该 Route 的 model |
| `too_many_fallback_providers` | 超过 `MAX_ROUTE_FALLBACKS` |

复用既有错误码的映射（**报告中已说明**）：删除被 fallback 引用的 Provider →
`provider_has_routes`；更新 Provider 时移除被 fallback 使用的 model →
`model_not_available`；候选解析时 Route 不存在 / disabled → `route_not_found` /
`route_disabled`；主 Provider 不存在 → `provider_not_found`；主 Provider 不支持该
model → `invalid_registry_snapshot`；没有任何 enabled 候选 → `provider_disabled`。

## 3. Candidate 解析规则

`resolveRouteCandidates(routeId)`：

1. Route 不存在 → `route_not_found`；
2. Route disabled → `route_disabled`；
3. 依次遍历 `providerId`、`fallbackProviderIds[0..]`；
4. **disabled Provider 跳过**（包括主 Provider：主 Provider disabled 但 fallback
   enabled 时，候选从 fallback 开始）；
5. Provider 不存在 → 主 Provider 抛 `provider_not_found`，fallback 抛
   `fallback_provider_not_found`；
6. Provider 不支持该 model → 主 Provider 抛 `invalid_registry_snapshot`，
   fallback 抛 `fallback_model_not_available`；
7. 没有任何 enabled 候选 → `provider_disabled`；
8. 返回 `ResolvedRoute[]` 副本，每项只有
   `routeId / providerId / protocol / baseUrl / model / credentialRef` 六个字段。

每个候选的协议由**该 Provider 的 protocol** 决定，因此一条 Route 的候选可以混用
`anthropic_messages` 与 `openai_compatible`。

## 4. RetryPolicy 与 attempt 上限

默认值（`DEFAULT_RETRY_POLICY`）：

```text
maxAttemptsPerProvider = 2
maxTotalAttempts       = 8
initialBackoffMs       = 250
maxBackoffMs           = 2000
```

校验规则（违反时构造函数**同步**抛出固定 code `invalid_resilience_options`，且消息
不回显被拒值）：

- attempt 计数必须是**安全整数且 ≥ 1**；
- 延迟必须是**安全整数且 ≥ 0**；
- `maxBackoffMs >= initialBackoffMs`；
- 非对象配置同样拒绝。

Attempt 顺序固定且串行：

```text
primary      attempt 1 .. maxAttemptsPerProvider
fallback 1   attempt 1 .. maxAttemptsPerProvider
fallback 2   attempt 1 .. maxAttemptsPerProvider
```

同时受 `maxTotalAttempts` 限制。不会并行请求多个 Provider，不会回到已耗尽的
Provider，每个 attempt 只调用一次注入的 `HttpClient`，且各自拥有独立的 decoder
状态、认证头与取消处理。

## 5. Backoff 规则

```text
delay(retryIndex) = min(initialBackoffMs * 2 ** retryIndex, maxBackoffMs)
```

- `retryIndex` 是该 Provider 内**第几次重试**（第一次重试为 0）。
- Provider 的**首次 attempt 不等待**；切换 Provider 也不等待。
- 无 jitter，完全确定性。
- 等待通过注入的 `wait(delayMs, signal)` 完成；默认实现使用真实定时器（`unref`），
  并在 `AbortSignal` 触发时立即 resolve。
- 测试注入 `wait`，不真实等待数百毫秒。

## 6. retryable 判断

只有同时满足以下条件才允许重试或切换 Provider：

```text
event.type === "error"
event.retryable === true
event.code ∈ { "rate_limited", "upstream_unavailable" }
```

覆盖 HTTP 429 / 408 / 425 / 500 / 502 / 503 / 504 与非取消的传输失败。

**绝不重试**：`aborted`、`provider_protocol_error`、`gateway_error`、任何
`retryable === false` 的错误、Route 配置错误、Credential 缺失、model 不一致、
Adapter 编码错误。判断只看结构化 code 与受控 `retryable` 标志，**不看 message 文本**。

## 7. 已输出事件后的禁止切换规则

一次 attempt 一旦输出过
`text_delta` / `tool_call` / `usage` / `completed` 中的任意一个，该 attempt 即视为
**已提交**：

- 不再 retry，不再 failover；
- 保留已经输出的正常事件；
- 继续输出该 attempt 的最终错误（若之后出现 retryable 错误）；
- 不重新发送请求，因此不会重复文本、tool_call 或 usage。

只有「仅输出一个 retryable error、没有任何正常事件」的 attempt 才允许被抑制并进入
下一次 attempt。

## 8. 最终结果

- 所有 attempt 失败 → 只输出**一个**最终 error，code 取**最后一次安全 retryable
  错误**的 code；
- 过程中出现不可重试错误 → 立即输出该固定安全错误并结束；
- 任意候选成功 → 输出该候选的正常事件与 `completed`，不再访问其余候选，
  也不输出此前被抑制的中间错误；
- 对外事件**不含** Provider ID、URL、`credentialRef`、headers 或原始异常；
- 经 Agent Core 后仍折叠为固定文案（`aborted` 为 `Request aborted.`，其余为
  `Model gateway request failed.`）。

## 9. 取消与资源释放

取消检查覆盖：候选解析前、读取凭据前、HTTP pending、response body pending、
decoder 增量读取、backoff 等待、切换 Provider 前。

- 预取消：不调用 `resolveRouteCandidates`、不读 `CredentialStore`、不调用 `HttpClient`，
  只输出一个 `aborted`。
- 中途取消：恰一个 `aborted`；不再开始下一次 attempt；不输出 `completed`，
  也不输出新的 text/tool/usage。
- backoff 等待期间取消：等待立即结束，运行随即结束。
- 上游 body 迭代器被 `return()` 释放；悬挂 `return()` 不会被等待。
- 挂起的 `HttpClient` / body rejection 都有 handler，不产生 unhandled rejection。
- 并发请求的候选顺序、attempt 计数、secret 与 decoder 状态互不污染。

> 说明：backoff 等待之后、调用 attempt 之前还有一次取消检查，属于**纵深防御**；
> attempt 内部在发起 HTTP 前也会检查一次，因此该处取消的可观察保证由两者共同满足。

## 10. 凭据安全边界

- 候选只携带 `credentialRef`，**永远不携带 secret**。
- 每次 attempt 才按该候选的引用调用 `CredentialStore.get()`，secret 只进入该次请求的
  认证头，attempt 结束后不再持有。
- secret 不会进入：`RouteDefinition`、`ResolvedRoute`、候选列表、请求体、
  `ModelStreamEvent`、`AgentEvent`、重试错误、故障转移错误、日志。
- 错误消息固定，不使用 `error.message` 拼接，不回显 URL、Provider ID 或状态文本。
- 非 2xx 响应体**从不读取**，只做释放。
- 测试使用合成 secret（如 `TASK5_SYNTHETIC_SECRET_VALUE`），不使用真实凭据或环境变量。

## 11. 依赖与离线

- `provider-registry` 仍然零运行时依赖，且不依赖 `model-gateway`。
- `model-gateway` 依赖 `agent-contracts` 与 `provider-registry`，未新增任何依赖。
- 全局 `fetch` 仍只出现在 `http-transport.ts`。
- 协议 adapter 目录保持纯转换，不含凭据与路由。
- `agent-core` 的错误清洗逻辑与安全错误白名单未被修改。

## 12. 尚未实现

健康检查、模型列表、Provider / Route / Credential 持久化、SQLite、OS Keychain、
Agent Loop、多轮模型调用、工具执行、审批、Memory、上下文压缩、Desktop / Tauri、
CLI、CC Switch / Claude Code 集成、真实供应商端到端验证。
