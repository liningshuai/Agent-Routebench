# Task 5 执行报告：有界重试、有序 Provider 故障转移与候选解析

## 1. 基线提交

- 工作目录：`C:\Users\liningshuai\Desktop\科研PART\学习\agent-workbench\agent-workbench-app`
- 分支：`workbench/agent-core`
- 基线 HEAD：**`edf5a6e48b21243edaf1151d7d9faa90f64bb9e2`**（`docs(gateway): correct Task 4 verification wording`）
- 父链完整：`edf5a6e → 6451596 → d548c0c → e931482 → fa10eab → e98d345 → d223a76 → ebe7925`
- 基线工作区除未跟踪 `.superpowers/` 外无其他改动
- 基线验证（改动前）：`verify:layout` / `typecheck` / `test`（15 files, 395 tests）/
  `security:scan` / `evals:deterministic` 全部 **exit 0**

## 2. 最终状态

**DONE_WITH_CONCERNS**

代码与测试全部完成，全部验证命令退出码为 0（除评测入口在报告文件缺失时**真实失败**——
见 §16）。唯一 concern 是 **Git 分支引用无法写入**：提交对象已正确生成（父提交为
基线 `edf5a6e…`，完整 hash 见交付回复），但本环境的 git 无法把嵌套引用
`refs/heads/workbench/agent-core` 落盘。按提示词要求**未做任何绕过**，改动完整保留在
索引与工作区（二者都与提交对象一致）。详见 §20。

## 3. Route fallback 数据模型

```ts
export const MAX_ROUTE_FALLBACKS = 4;

export interface RouteDefinition {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;              // 首选 Provider
  readonly model: string;
  readonly enabled: boolean;
  readonly fallbackProviderIds?: readonly string[];  // 有序候选，缺省等价于 []
}
```

- 缺省时该字段**不写入**存储对象，因此 `getRoute()` 与调用方传入的形状一致；语义上
  等价于空数组（`route.fallbackProviderIds ?? []`）。
- 上限 4，超出抛 `too_many_fallback_providers`。
- 每个条目必须是合法 Provider ID；重复、重复主 Provider、形似秘密 → 拒绝。
- 未新增任何 Route 传输字段（`baseUrl` / `endpoint` / `headers` / `apiKey` / `token` /
  `secret` 仍被 `forbidden_route_field` 拒绝）。
- 新稳定错误码：`invalid_fallback_provider_ids`、`duplicate_fallback_provider_id`、
  `fallback_provider_not_found`、`fallback_model_not_available`、
  `too_many_fallback_providers`（消息固定，不回显输入）。

**复用既有错误码的映射**（提示词要求说明）：删除仍被 fallback 引用的 Provider →
`provider_has_routes`；更新 Provider 时移除被 fallback 使用的 model →
`model_not_available`；候选解析中 Route 缺失/disabled → `route_not_found` /
`route_disabled`；主 Provider 缺失 → `provider_not_found`；主 Provider 不支持该 model
→ `invalid_registry_snapshot`；无任何 enabled 候选 → `provider_disabled`。

## 4. candidate 解析规则

`resolveRouteCandidates(routeId)`：

1. Route 不存在 → `route_not_found`；
2. Route disabled → `route_disabled`；
3. 按 `providerId` → `fallbackProviderIds[0..]` 顺序遍历；
4. **disabled Provider 跳过**（主 Provider 亦适用：主 disabled + fallback enabled 时
   候选从 fallback 开始）；
5. Provider 不存在 → 主 `provider_not_found` / fallback `fallback_provider_not_found`；
6. Provider 不支持该 model → 主 `invalid_registry_snapshot` /
   fallback `fallback_model_not_available`；
7. 无 enabled 候选 → `provider_disabled`；
8. 每项只返回 `routeId / providerId / protocol / baseUrl / model / credentialRef` 六个
   字段的**副本**，无 secret、无 headers、无 Provider 原始对象。

协议由**候选 Provider 自身**的 protocol 决定，因此一条 Route 可以混用
`anthropic_messages` 与 `openai_compatible`（已测试）。

`resolveRoute()` 的既有行为与字段集合**逐字保持不变**（有专门测试对整对象做深度断言）。

## 5. RetryPolicy

```ts
export interface RetryPolicy {
  readonly maxAttemptsPerProvider: number;
  readonly maxTotalAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttemptsPerProvider: 2,
  maxTotalAttempts: 8,
  initialBackoffMs: 250,
  maxBackoffMs: 2000,
});
```

校验（违反时构造函数**同步**抛出 `invalid_resilience_options`，消息固定）：

- `maxAttemptsPerProvider` / `maxTotalAttempts`：安全整数且 ≥ 1；
- `initialBackoffMs` / `maxBackoffMs`：安全整数且 ≥ 0；
- `maxBackoffMs >= initialBackoffMs`；
- 非对象配置同样拒绝。

`ResilienceOptionError` 携带固定 code；另外构造函数会校验
`registry.resolveRouteCandidates` 存在，否则同样抛该错误。

## 6. attempt 上限

- 每个 Provider 最多 `maxAttemptsPerProvider` 次；
- 所有 Provider 合计最多 `maxTotalAttempts` 次；
- 不超过候选列表长度；
- 不回到已耗尽的 Provider；
- 不并行请求；每个 attempt 只调用一次注入的 `HttpClient`；
- 每个 attempt 拥有独立的 decoder 状态、认证头与取消处理。

实测（见 §16 变异 B1/B5）：`maxAttemptsPerProvider: 2` + 1 个 fallback →
请求序列恰为 `[primary, primary, fallback, fallback]`；`maxTotalAttempts: 3` +
1 个 fallback → 恰 3 次且全部落在 primary。

## 7. backoff 规则

```text
delay(retryIndex) = min(initialBackoffMs * 2 ** retryIndex, maxBackoffMs)
```

`retryIndex` 是**同一 Provider 内**第几次重试（首次重试为 0）。Provider 的首次
attempt 不等待，切换 Provider 也不等待。无 jitter。

实测：`initialBackoffMs: 100, maxBackoffMs: 300, maxAttemptsPerProvider: 4` →
`wait` 收到的延迟恰为 `[100, 200, 300]`；首次 attempt 的 `wait` 调用次数为 0。

默认 `defaultRetryWait` 使用真实定时器（`unref`），并监听 `AbortSignal`：signal 触发时
立即 resolve 并清理监听器；测试一律注入自己的 `wait`，不真实等待数百毫秒。

## 8. retryable error 判断

允许重试/切换当且仅当：

```text
event.type === "error" && event.retryable === true &&
event.code ∈ { "rate_limited", "upstream_unavailable" }
```

覆盖 429 / 408 / 425 / 500 / 502 / 503 / 504 与非取消传输失败。
**绝不重试** `aborted`、`provider_protocol_error`、`gateway_error`、
`retryable === false`、Route 配置错误、Credential 缺失、model 不一致、编码错误。
判断只依据结构化 code 与受控 `retryable` 标志，**不读 message 文本**。

## 9. failover 顺序

候选顺序即 `resolveRouteCandidates` 的返回顺序：主 Provider → fallback[0] → fallback[1] …
仅在前一候选的 retry 预算耗尽（或 `maxTotalAttempts` 用尽）后进入下一候选；成功后
立刻停止，不访问剩余候选。实测 3 候选场景请求序列为
`[p, one, two]`，且 `maxInFlight` 恒为 1（无并行）。

## 10. 已输出事件后的禁止切换规则

`isVisibleStreamEvent()` 对 `text_delta` / `tool_call` / `usage` / `completed` 都返回
`true`。一旦某 attempt 输出过其中任意一个，该 attempt 视为已提交：

- 不再 retry、不再 failover；
- 已输出的正常事件保留；
- 继续输出该 attempt 的最终错误（若随后出现 retryable 错误）；
- 不重发请求，因此不会重复文本 / tool_call / usage。

实测 4 条：Anthropic 文本 delta 后接 `overloaded_error`→ 只 1 次 HTTP、事件恰为
`[text_delta, error(upstream_unavailable)]`；OpenAI 文本 delta 后接
`rate_limit_error`；OpenAI `finish_reason: tool_calls` 后再接 `rate_limit_error`；
OpenAI usage chunk 后再接 `rate_limit_error` —— 四种情况都只有 1 次 HTTP 调用。

被抑制的中间错误对消费者不可见：成功 failover 场景的事件里 `error` 数量为 0。

## 11. 取消和资源释放

| 场景 | 断言 |
|---|---|
| 预取消 | 恰一个 `aborted`；`resolveRouteCandidates` 调用 0 次；CredentialStore 查询 0 次；HTTP 0 次 |
| backoff 等待期间取消 | 等待立即结束；恰一个 `aborted`；不开始下一次 attempt；HTTP 仍为 1 次 |
| 切换 Provider 前取消 | 不发起 fallback 请求 |
| HTTP pending 取消 | 恰一个 `aborted`，随后 `done` |
| body pending 取消 | 同上 |
| 客户端 abort 后 reject | 挂 `process.on("unhandledRejection")` 断言为空 |
| 并发 | 两个并发请求各自完成自己的重试与 failover，互不干扰 |

> 透明说明：backoff 等待之后、调用 attempt 之前的那次取消检查属于**纵深防御**。
> 变异 B4 删掉它之后测试仍全绿，因为 attempt 内部在发起 HTTP 前也会检查取消，
> 可观察保证仍然成立（不产生额外 HTTP 请求）。报告中不声称该处产生了红绿差异。

## 12. 凭据安全边界

- 候选只携带 `credentialRef`；每次 attempt 才按引用读取 secret，且只放进该次请求的
  认证头，attempt 结束即不再持有。
- 实测：主 Provider 请求头带 `t5-secret-a`、fallback 请求头带 `t5-secret-b`；
  主 Provider 的请求头里**没有** fallback 的 secret（反之亦然）。
- secret 不出现在：RouteDefinition、ResolvedRoute、候选列表、请求体、ModelStreamEvent、
  AgentEvent、重试错误、failover 错误、最终错误。
- 事件 JSON 中不含 `credential:`、Provider ID、`baseUrl`、`headers`、`x-api-key`、
  `authorization`、`content-type`。
- 非 2xx 响应体**从不读取**：用计数 body 断言 `next()` 调用数为 **0**。
- 测试 secret 为合成值（`TASK5_SYNTHETIC_SECRET_VALUE`、`t5-secret-a/b`），未使用真实
  API key、token 或环境变量。

## 13. TDD Red 证据

命令（与提示词一致）：

```powershell
corepack pnpm test -- tests/task-5-provider-candidates.test.ts tests/task-5-resilience.test.ts tests/task-5-resilience-security.test.ts
```

退出码：**1**

```text
Test Files  3 failed (3)
     Tests  80 failed | 13 passed (93)
```

分文件：`task-5-provider-candidates.test.ts` 28 tests / 25 failed；
`task-5-resilience-security.test.ts` 25 tests / 16 failed；
`task-5-resilience.test.ts` 40 tests / 39 failed。

真实错误摘要（**不只是「模块不存在」**）：

| 失败原因 | 条数 | 对应缺失行为 |
|---|---:|---|
| `(0 , createResilientRoutedHttpModelGateway) is not a function` | 45 | 整个重试/故障转移能力不存在 |
| `fixture.registry.resolveRouteCandidates is not a function` | 7 | 候选解析不存在 |
| `expected a ProviderRegistryError with code "fallback_provider_not_found" …` | 2 | 注册时**未校验** fallback Provider 是否存在 |
| `expected a ProviderRegistryError with code "fallback_model_not_available"` | 1 | 未校验 fallback 是否支持该 model |
| `expected a ProviderRegistryError with code "duplicate_fallback_provider_id"` | 2 | 未拒绝重复 fallback ID |
| `expected a ProviderRegistryError with code "too_many_fallback_providers"` | 1 | 无数量上限 |
| `expected a ProviderRegistryError with code "provider_has_routes"` | 1 | 删除仅被 fallback 引用的 Provider 未被拒绝 |
| `expected a ProviderRegistryError with code "model_not_available"` | 1 | 更新 Provider 可移除被 fallback 使用的 model |
| `expected undefined to deeply equal [ 'b-one' ]` / `[…'b-one','b-two','b-three']` | 3 | fallback 列表未被存储/解析 |
| `missing error code invalid_fallback_provider_ids` | 1 | 错误码缺失 |
| `expected undefined to be 4` | 1 | `MAX_ROUTE_FALLBACKS` 缺失 |
| `{"maxAttemptsPerProvider":0}: expected undefined to be 'invalid_resilience_options'` | 1 | 配置校验缺失 |
| `RETRYABLE_STREAM_ERROR_CODES is not iterable` | 1 | retryable 白名单缺失 |

## 14. TDD Green 证据

实现后聚焦运行：退出码 **0**，`Test Files 3 passed (3)`、`Tests 93 passed (93)`。

全量：退出码 **0**，`Test Files 18 passed (18)`、`Tests 488 passed (488)`
（**395 → 488，新增 93**）。

Green 过程中修正的问题（如实记录，均为**测试或 fixture 自身的问题**，未放宽任何断言）：

1. `typecheck`：3 处 readonly 数组的强制转换需经 `unknown`；
2. fixture：`enabled: false` 的 Provider 在注册 Route 时会被
   `provider_disabled` 拒绝，因此改为「先按 enabled 注册，Route 建好后再 disable」；
3. 若干用例的脚本长度不足，导致「超预算请求」落到了 overrun 标记而非预期失败
   → 补齐脚本条目（并保留 overrun 标记，使任何多余 attempt 都会体现在事件里）；
4. 并发用例原本用位置脚本描述两个交错请求，语义不确定 → 改为按 URL 驱动的 fake client；
5. 候选列表断言误把 `credentialRef` 与 `baseUrl` 当作泄漏 → 拆分出
   「消费者可见文本」的严格断言（事件/错误禁止引用与 URL），候选作为内部数据允许携带。

**受控变异检查**（备份 → 变异 → 运行 → 还原，已确认无 `MUTATION` 残留）：

| 变异 | 结果 | 说明 |
|---|---|---|
| B1 只尝试第一个候选（禁止 failover） | **12 failed** | failover 断言 load-bearing |
| B2 忽略「已输出事件」守卫 | **4 failed** | 恰为 text_delta×2 / tool_call / usage 四条守卫用例 |
| B3 backoff 退化为常量 | **1 failed** | `expected [100,100,100] to deeply equal [100,200,300]` |
| B4 删除 backoff 后的取消检查 | **0 failed** | 该处为纵深防御，可观察保证由 attempt 内部检查兜底（已如实说明） |
| B5 候选解析不跳过 disabled | **4 failed** | disabled 跳过规则 load-bearing |
| B6 忽略受控 `retryable` 标志 | **1 failed** | `never retries an error that is not marked retryable` |

## 15. 测试数量

| 文件 | 测试数 |
|---|---:|
| `tests/task-5-provider-candidates.test.ts` | 28 |
| `tests/task-5-resilience.test.ts` | 40 |
| `tests/task-5-resilience-security.test.ts` | 25 |
| **Task 5 新增合计** | **93**（要求 ≥ 35） |
| 既有测试 | 395（全部保持通过） |
| **全量** | **488** |

## 16. 完整命令和退出码

| # | 命令 | 退出码 | 关键输出 |
|---|---|---:|---|
| 1 | `corepack pnpm install --frozen-lockfile` | **0** | `Lockfile is up to date, resolution step is skipped` / `Done in 306ms using pnpm v12.3.4`（第 1 次即成功） |
| 2 | `corepack pnpm verify:layout` | **0** | 通过 |
| 3 | `corepack pnpm typecheck` | **0** | 无错误 |
| 4 | `corepack pnpm test` | **0** | `Test Files 18 passed (18)` / `Tests 488 passed (488)` |
| 5 | `corepack pnpm security:scan` | **0** | `security:scan passed (72 files scanned…)` |
| 6 | `corepack pnpm evals:deterministic` | **0** | stage 1 通过；stage 2 三组场景（Task 3 / Task 4 / Task 5）全部通过 |
| 7 | Task 5 聚焦测试（三个文件） | **0** | `Tests 93 passed (93)` |
| 8 | `git diff --check` | **0** | 无空白错误 |
| 9 | `git diff --cached --check` | **0** | 无空白错误 |

关于第 6 项：在 `docs/verification/task-5-report.md` 尚未创建时，该入口**真实失败**
（退出码 1，`AssertionError: docs/verification/task-5-report.md must exist`），
证明它不是固定打印 passed；补齐后才变为 0。

## 17. 包依赖变化

- **无新增依赖**。`package.json` 与 `pnpm-lock.yaml` 均未修改。
- `model-gateway` 依赖仍为 `agent-contracts` + `provider-registry`（workspace 协议）。
- `provider-registry` 仍零运行时依赖，且不依赖 `model-gateway`。
- `model-gateway` 不依赖 `agent-core`；无跨包 `src` 穿透导入。
- 全局 `fetch` 仍只出现在 `packages/model-gateway/src/http-transport.ts`（有断言锁定）。

## 18. 修改文件

**provider-registry**

| 文件 | 变更 |
|---|---|
| `src/types.ts` | `RouteDefinition.fallbackProviderIds?`、`MAX_ROUTE_FALLBACKS`、fallback 校验、`cloneRouteDefinition` 条件拷贝 |
| `src/errors.ts` | 新增 5 个 fallback 错误码与固定消息 |
| `src/registry.ts` | `resolveRouteCandidates()`；注册/更新时校验 fallback；`removeProvider` / `updateProvider` 覆盖 fallback 引用；`routeProviderIds` / `routeReferencesProvider` 辅助 |
| `src/index.ts` | 导出 `MAX_ROUTE_FALLBACKS` |

**model-gateway**

| 文件 | 变更 |
|---|---|
| `src/candidate-attempt.ts`（新增） | 从 Task 4 抽出的**单候选单次尝试**运行器：凭据读取、编码、URL/头、单次 HTTP、增量解码、取消；`isAborted` |
| `src/routed-http-gateway.ts` | 改为复用 `runCandidateAttempt`；对外行为与公开接口不变（Task 4 的 395 项断言与 Task 4 聚焦测试全部保持通过） |
| `src/resilience.ts`（新增） | `RetryPolicy`、默认值、归一化与校验、退避计算、retryable/visible 判定、`defaultRetryWait`、`ResilienceOptionError` |
| `src/resilient-routed-gateway.ts`（新增） | `ResilientRoutedHttpModelGateway` / 工厂：候选循环、有界重试、退避、failover、已输出守卫、取消 |
| `src/index.ts` | 导出上述内容 |

**测试**：`tests/helpers/http-fixtures.ts`（Task 5 fixture：多 Provider 候选、脚本化/按 URL 驱动的 fake client、合成 secret）、
`tests/task-5-provider-candidates.test.ts`、`tests/task-5-resilience.test.ts`、`tests/task-5-resilience-security.test.ts`

**文档与评测**：`docs/resilience.md`（新增）、`docs/verification/task-5-report.md`（本文件）、
`README.md`、`docs/architecture.md`、`scripts/evals-deterministic.mjs`

**未修改**：`agent-contracts`、`agent-core`（错误清洗逻辑与安全错误白名单均未触碰，
有断言锁定）、Task 1–4 的任何既有测试期望。

## 19. 未实现范围

健康检查、模型列表、Provider / Route / Credential 持久化、文件 / SQLite / OS Keychain、
Agent Loop、多轮模型调用、工具执行、审批、Memory、上下文压缩、Desktop / Tauri、CLI、
CC Switch 集成、Claude Code 集成、真实供应商端到端验证。

## 20. Git 状态

- 分支：`workbench/agent-core`
- 基线 HEAD：`edf5a6e48b21243edaf1151d7d9faa90f64bb9e2`
- 父提交：`edf5a6e48b21243edaf1151d7d9faa90f64bb9e2`
- 提交信息：`feat(gateway): add bounded retry and provider failover`
- **本次提交对象的完整 hash 见交付回复**（本文件随该提交保存，因此不写自身 hash）
- **分支引用：未写入。** 提交后 `git rev-parse --verify HEAD` 退出 128、
  `git show-ref` 退出 1、`.git/refs/` 为空、`git status` 显示
  `## No commits yet on workbench/agent-core`。

实际过程与 Task 3/4 相同：`git commit` 返回 0 并打印提交摘要，提交对象确实写入对象库，
但嵌套引用没有落盘，分支回到 unborn。随后用标准命令
`git update-ref refs/heads/workbench/agent-core <hash> 0000…` 恢复，退出码 0 但引用仍未落盘
（普通权限与受控权限各一次，结果相同）。

**未做任何绕过**：没有手写 `.git/refs`、没有手工创建 Git 内部目录、没有修改
`HEAD` / `packed-refs` / reflog、没有重新 `git init`、没有在 unborn HEAD 上创建根提交、
没有重复提交伪造成功、没有 `reset` / `checkout` / `clean`、没有 `git add .`。

**改动没有丢失**：`git diff --quiet <提交对象>` 与 `git diff --cached --quiet <提交对象>`
均为空（工作区 == 索引 == 提交）。`git ls-files --others --exclude-standard` 只剩
`.superpowers/sdd/2026-09-10-independent-agent-workbench-plan/{progress.md,task-0-brief.md,task-0-dispatch.md}`
（mtime 仍为 12:55，未修改、未暂存、未提交）。

**在可正常写引用的环境恢复（一步）**：

```powershell
git update-ref refs/heads/workbench/agent-core <交付回复中的提交 hash> 0000000000000000000000000000000000000000
git log --oneline -9
```

恢复后应为 `… → d548c0c → 6451596 → edf5a6e → <Task 5 提交>`。

## 21. 最终提交 hash 和父提交

- 最终提交对象 hash：**见交付回复**（本文件不写自身 hash）
- 父提交：**`edf5a6e48b21243edaf1151d7d9faa90f64bb9e2`**
- 内容：仅 Task 5 相关文件（provider-registry、model-gateway、tests、docs、scripts、README）

### 不得声称的事项（本报告均未声称）

未验证真实供应商；未完成真实模型调用；未完成健康检查；未完成模型列表；未完成持久化；
未完成 Agent Loop；未完成工具执行；未完成审批；未完成 Desktop / CLI。
报告结论只覆盖离线场景：**488 个测试通过不代表不存在其他缺陷**。
