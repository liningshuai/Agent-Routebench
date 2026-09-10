# Task 4 执行报告：Routed HTTP Model Gateway 与凭据注入边界

## 1. 最终状态

**DONE_WITH_CONCERNS**

代码与测试全部完成，全部验证命令退出码为 0（`install --frozen-lockfile` /
`verify:layout` / `typecheck` / `test` / `security:scan` / `evals:deterministic` /
`git diff --check` / `git diff --cached --check`）。

唯一 concern 是 **Git 分支引用无法写入**：本次提交对象已正确生成（父提交为基线
`d548c0c32ceee21c1e614ef8984cf990fd92a202`，14 files changed，
3358 insertions / 52 deletions；完整 hash 见交付回复），但本环境的 git 无法创建嵌套引用
`refs/heads/workbench/agent-core`：`git commit` 与 `git update-ref` 都返回退出码 0，
引用却没有落盘，分支因此回到 unborn 状态。
按提示词要求**未做任何绕过**，改动完整保留在索引与工作区（二者都与该提交对象一致）。
详见 §18。

## 2. 基线提交

- 工作目录：`C:\Users\liningshuai\Desktop\科研PART\学习\agent-workbench\agent-workbench-app`
- 分支：`workbench/agent-core`
- 基线 HEAD：`d548c0c32ceee21c1e614ef8984cf990fd92a202`（`fix(gateway): enforce cancellation and SSE chunk boundaries`）
- 历史：`ebe7925 → d223a76 → e98d345 → fa10eab → e931482 → d548c0c`
- 工作区除未跟踪 `.superpowers/` 外无其他改动；`.superpowers/` 未修改、未暂存、未提交
- 基线验证（改动前）：`verify:layout` / `typecheck` / `test`（12 files, 314 tests）/
  `security:scan` / `evals:deterministic` 全部 **exit 0**

## 3. 实际修改文件

**新增（7）**

| 文件 | 用途 |
|---|---|
| `packages/model-gateway/src/http-transport.ts` | `HttpRequest` / `HttpResponse` / `HttpClient` 契约；URL 拼接；认证头构造；状态码映射；body 释放；基于 Node 24 原生 `fetch` 的默认客户端 |
| `packages/model-gateway/src/routed-http-gateway.ts` | `RoutedHttpModelGateway` / `createRoutedHttpModelGateway`：路由解析、凭据读取、编码、单次 HTTP 调用、增量解码、取消传播 |
| `tests/helpers/http-fixtures.ts` | 离线 fixture：fake `HttpClient`、Provider/Route/Credential 构造、SSE 载荷、header 大小写无关读取 |
| `tests/task-4-http-gateway.test.ts` | 路由与凭据边界、请求构造、HTTP 状态与传输错误映射、默认客户端（45 tests） |
| `tests/task-4-http-security.test.ts` | 运行时秘密泄露边界 + 源码级包/依赖/网络边界（17 tests） |
| `tests/task-4-http-integration.test.ts` | 增量流式、取消与资源释放、并发隔离、Agent Core 集成（19 tests） |
| `docs/http-transport.md` | HTTP 传输公开接口、请求规则、错误映射、凭据边界文档 |

**修改（6）**

| 文件 | 用途 |
|---|---|
| `packages/model-gateway/src/index.ts` | 导出 `HttpClient` / `HttpRequest` / `HttpResponse` / `FetchLike` / `FetchResponseLike` / `RoutedHttpModelGatewayOptions` / `RoutedHttpModelGateway` / `createRoutedHttpModelGateway` / `createFetchHttpClient` 及若干纯辅助函数 |
| `packages/model-gateway/package.json` | 新增 `@agent-workbench/provider-registry: workspace:*` |
| `pnpm-lock.yaml` | 记录 `packages/model-gateway` importer 的新依赖 |
| `README.md` | 当前阶段更新为 Task 4；明确「无重试、无故障转移、无真实端到端验证」 |
| `docs/architecture.md` | 新增 Task 4 章节与链路图；修正「协议层」章节（codec 仍纯，传输在其之上） |
| `scripts/evals-deterministic.mjs` | 新增 Task 4 文件检查；Stage 2 实际运行 Task 3 + Task 4 两组离线场景；输出不再声称「没有 live adapter」 |

新增 `docs/verification/task-4-report.md`（本文件）。

未修改 `agent-contracts`、`agent-core`、`provider-registry` 的任何实现，也未修改任何 Task 1–3 的测试期望。

## 4. 新增公开接口

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

export class RoutedHttpModelGateway implements ModelGateway { /* ... */ }
export function createRoutedHttpModelGateway(options): RoutedHttpModelGateway;
export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient;

// 纯辅助函数
buildProviderUrl, buildAnthropicHeaders, buildOpenAIChatHeaders,
mapHttpStatusToErrorCode, releaseResponseBody,
ANTHROPIC_MESSAGES_ENDPOINT, OPENAI_CHAT_COMPLETIONS_ENDPOINT

// 类型
FetchLike, FetchResponseLike
```

包依赖：`model-gateway` → `agent-contracts` + `provider-registry`（后者仅通过公开 workspace
接口，且只用于类型）。`provider-registry` 依赖未变（零依赖）。无新增第三方依赖。

## 5. HTTP 请求与响应行为

- `HttpRequest.method` 固定 `POST`；`body` 是协议 JSON；`headers` 只在 transport 边界使用。
- `HttpResponse.body` 是增量 `AsyncIterable<Uint8Array>`，直接交给既有 decoder，**不先收集完整响应**。
- `body === null` 视为协议错误（`provider_protocol_error`）。
- 非 2xx 响应：**不读取 body**，只调用 `return()` 释放，然后输出固定安全错误。
- 请求对象不被写入日志、事件或错误消息。
- 调用方传入的 `AbortSignal` 会原样传给 `HttpClient`。

## 6. Route 解析行为

顺序（每次 `stream()`）：

1. `signal.aborted` → 一个 `aborted`，结束。
2. `registry.resolveRoute(routeId)`。
3. `request.model === resolvedRoute.model`，否则固定失败。
4. `credentialRef === null` → 固定失败。
5. `credentials.get(credentialRef)`；缺失/空 → 固定失败。
6. 选 adapter → `encode()` → 拼 URL / headers。
7. 调用 `HttpClient` 一次。
8. 2xx 且 body 非 null → 增量解码。

**没有**重试、故障转移或 Provider 轮换：即使注册表里还有另一个 enabled 的 Route，也不会被使用（有专门测试锁定）。

## 7. CredentialStore 使用边界

- 只在 `resolveRoute()` 成功且 `credentialRef !== null` 之后查询。
- 只用**精确的** `credentialRef` 查询一次（测试用 spy 断言请求的 ref 数组恰为 `["credential:t4"]`）。
- Route 解析失败时**根本不查凭据**（测试断言 spy 收到空数组）。
- 预取消时**不查凭据**（变异检查 A3 证明该断言 load-bearing）。
- 凭据缺失或空字符串时不发请求。

## 8. Anthropic 请求验证

```text
POST <baseUrl>/v1/messages
content-type: application/json
accept: text/event-stream
anthropic-version: 2023-06-01
x-api-key: <secret>
```

测试逐字段断言：URL、method、四个 header 的**精确集合**
（`["accept","anthropic-version","content-type","x-api-key"]`）、
无 `authorization`、body 与 `encodeAnthropicMessagesRequest(request).body` 深度相等。

## 9. OpenAI 请求验证

```text
POST <baseUrl>/chat/completions
content-type: application/json
accept: text/event-stream
authorization: Bearer <secret>
```

测试逐字段断言：URL、method、三个 header 的精确集合
（`["accept","authorization","content-type"]`）、无 `x-api-key`、无 `anthropic-version`、
body 与 `encodeOpenAIChatRequest(request, "max_tokens").body` 深度相等。
只覆盖 Chat Completions 子集，未扩展 Responses API。

URL 拼接测试覆盖 `https://api.anthropic.test/`、`https://api.anthropic.test///`、
`https://api.openai.test/v1/`，断言无重复 `//`。

## 10. 错误映射表

| 情况 | code | retryable | 测试数 |
|---|---|---:|---:|
| 预取消 / 取消导致的失败 | `aborted` | false | 4 |
| HTTP 429 | `rate_limited` | true | 1 |
| HTTP 408 / 425 / 500 / 502 / 503 / 504 | `upstream_unavailable` | true | 6 |
| `HttpClient` 抛异常 / rejected promise | `upstream_unavailable` | true | 2 |
| 2xx 且 `body === null` | `provider_protocol_error` | false | 1 |
| Adapter 解码失败（非法 UTF-8 等） | `provider_protocol_error` | false | 1 |
| HTTP 400/401/403/404/409/422/301/505 | `gateway_error` | false | 8 |
| Route/Provider/Credential 配置错误、编码失败 | `gateway_error` | false | 8 |
| 未知内部异常 | `gateway_error` | false | 1 |

错误消息来自 `adapters/errors.ts` 的固定文案表（唯一来源），不使用 `statusText`、
不使用响应 body、不使用原始异常 `message`、不透传 Provider 错误码。
另有测试断言：所有错误消息不含 `http://`/`https://`、不含三位数字、且在允许的固定集合内。

## 11. 流式增量证明

- 用 `createGatedSource()` 作为响应 body：推入 `message_start` + `content_block_start` +
  一个 `text_delta` 后，**在 gate 未关闭、终止帧未推入之前**即可取到
  `{type:"text_delta", text:"first"}`；再推第二个 delta 又立即取到；最后才推终止帧。
- 两种协议各一条；并有一条专测断言「第一个事件到达时不等待完整响应」。
- 全程未使用「先 collect 完整响应再断言」的伪流式验证。

## 12. 取消与资源释放证明

| 场景 | 断言 |
|---|---|
| 预取消 | 恰一个 `aborted`；`http.calls() === 0`；凭据查询数组为空 |
| 中途取消 | 已取得的 `text_delta` 保留；之后恰一个 `aborted`；无后续正常事件、无 `completed`；body `return()` 被调用 |
| HTTP 客户端 Promise 悬挂 | `abort()` 后立即得到 `aborted`，随后 `done`（`abort()` 前的等待被解除，不依赖响应到达） |
| HTTP 客户端在 abort 后 reject | 挂载 `process.on("unhandledRejection")`，断言为空 |
| body 清理悬挂 | `return()` 永不 settle，取消仍结束并 `done`，且 `returnCalled === true` |
| body 在 abort 后 fail | 无 unhandled rejection |
| 调用方提前退出 | 上游 `return()` 被调用 |
| 并发 | 同一实例两个并发请求各用各的 route / secret / body / signal，互不污染 |

实现要点：等待响应时用 `AbortSignal` 与客户端 Promise **竞速**；竞速期间 Promise 的
rejection 始终有 handler；迟到的响应会被 `releaseResponseBody()` 释放（不读取）。

## 13. Agent Core 集成证明

用真实 `createAgentCore(routedGateway)` + fake HTTP client：

- Anthropic / OpenAI 两条链路都产出 `route_selected → text_delta → usage → completed`，
  且 `completed` 恰好一个、`http.calls() === 1`。
- Agent Event 序列化后不含 provider URL、`credential:`、`x-api-key`、`authorization`、
  `content-type`、secret；每个事件都带 `requestId`。
- HTTP 429 → Agent Event 恰一个
  `{code:"rate_limited", message:"Model gateway request failed.", retryable:true}`；
  HTTP 503 与传输异常 → `upstream_unavailable`，同样只有固定消息；无 `completed`。
- Agent Core 校验失败时 `http.calls() === 0`。
- 一个 Agent Core run 只触发一次 HTTP 请求（无重试、无第二轮）。

## 14. 安全证明

- **secret 不进入 body**：断言请求体不含 secret / `credential:` / URL / `authorization` /
  `x-api-key` / `headers`。
- **secret 不进入事件**：成功路径与错误路径都断言事件 JSON 不含 secret、`credential:`、
  provider URL、`x-api-key`、`authorization`、`content-type`。
- **敌对响应体不外泄**：401/403/429/500 四种状态各返回一个含伪造 secret、URL 与
  `Bearer` 的 body，断言事件里均不出现；且断言该 body **从未被读取**（`next()` 调用数为 0）。
- **错误消息固定**：断言 code 与 message 都在允许集合内。
- **离线**：整组 Task 4 场景把 `globalThis.fetch` 换成 spy，断言调用数为 0。
- **源码级**：
  - `packages/model-gateway/src` 不含 axios / undici / node-fetch / `@anthropic-ai/sdk` / `openai` SDK；
  - 不含 `cc-switch` / `claude code`；
  - 不含跨包 `src` 穿透导入（`../../<pkg>/src/`、`provider-registry/src/`、`agent-contracts/src/`）；
  - 不写文件 / SQLite / 环境变量 / Keychain / indexedDB；
  - **全局 `fetch` 只出现在 `http-transport.ts`**（断言唯一归属文件）；
  - `adapters/**` 仍不含 `provider-registry`、`CredentialStore`、`credentialRef`、全局 `fetch`；
  - `model-gateway/package.json` 的依赖恰为
    `{"@agent-workbench/agent-contracts":"workspace:*","@agent-workbench/provider-registry":"workspace:*"}`，
    且不含 `agent-core`；
  - `provider-registry` 仍无 dependencies、源码不含 `model-gateway`；
  - `agent-core/package.json` 不含 `model-gateway` / `provider-registry`。

## 15. TDD Red 证据

命令：

```powershell
corepack pnpm test -- tests/task-4-http-gateway.test.ts tests/task-4-http-security.test.ts tests/task-4-http-integration.test.ts
```

退出码：**1**

```text
Test Files  3 failed | 12 passed (15)
     Tests  73 failed | 321 passed (394)
```

关键失败原因（全部真实运行，非人工构造）：

- 73 项行为测试以
  `TypeError: (0 , createRoutedHttpModelGateway) is not a function` 失败
  ——整个能力尚不存在，覆盖路由解析、凭据边界、请求构造、状态映射、流式、取消与
  Agent Core 集成每一类。
- 其余 7 项（源码扫描类）在实现缺失时空洞通过。

首次失败确实是「模块/导出不存在」，因此按提示词要求补做了**受控变异检查**，
用真实断言差异证明各项断言是 load-bearing 的（见 §16）。

## 16. TDD Green 证据

实现后聚焦运行：

```text
Test Files  15 passed (15)
     Tests  395 passed (395)
```

第一次 Green 尝试暴露了 3 类真实问题并已修正：

1. TypeScript 把 `signal.aborted` 在首次检查后窄化为 `false`，后续检查被判定不可达
   （`TS2367`）→ 改为通过 `isAborted(signal)` 帮助函数读取。
2. 测试文件漏导入 `SECOND_SECRET`（`TS2304`）。
3. 三个取消测试错误地重新调用 `iterator.next()`，读到的是**排队的下一个** `next()`
   （返回 `done`），而不是已经在等待的那个 Promise → 改为直接 `await first`。

**受控变异检查**（备份 → 变异 → 运行 → 还原，全部已还原并确认无残留标记）：

| 变异 | 结果 | 代表性断言差异 |
|---|---|---|
| A1 `mapHttpStatusToErrorCode` 恒返回 `gateway_error` | exit 1，**8 failed** | 429/408/425/500/502/503/504 与 Agent Core 错误路径用例 |
| A2 非 2xx 被当作成功、body 交给 adapter | exit 1，**17 failed** | `never reads the body of a non-2xx response` → `expected [ 'provider_protocol_error' ] to deeply equal [ 'gateway_error' ]` |
| A3 去掉预取消守卫 | exit 1，**1 failed** | `emits one aborted event without any HTTP call when pre-cancelled` → `expected [ 'credential:t4' ] to deeply equal []` |
| A4 把 secret 回显进协议 body | exit 1，**4 failed** | `keeps the secret out of the encoded request body` → 差异显示 `+ "apiKey": "t4-secret-value"` |

## 17. 完整验证命令与退出码

| # | 命令 | 退出码 | 关键输出 |
|---|---|---:|---|
| 1 | `corepack pnpm install --frozen-lockfile` | **0** | `Lockfile is up to date, resolution step is skipped` / `Done in 302ms using pnpm v12.3.4`（第 1 次即成功） |
| 2 | `corepack pnpm verify:layout` | **0** | 通过 |
| 3 | `corepack pnpm typecheck` | **0** | 无错误 |
| 4 | `corepack pnpm test` | **0** | `Test Files 15 passed (15)` / `Tests 395 passed (395)` |
| 5 | `corepack pnpm security:scan` | **0** | `security:scan passed (64 files scanned…)` |
| 6 | `corepack pnpm evals:deterministic` | **0** | stage 1 `64 expected files present`；stage 2 两组场景（Task 3 codecs、Task 4 routed HTTP transport）均通过 |
| 7 | `git diff --check` | **0** | 无空白错误 |
| 8 | `git diff --cached --check` | **0** | 无空白错误 |

测试数量：基线 314 → 395，**新增 81**（≥25 要求）。

注：第 6 项在报告文件尚未创建时曾**真实失败**（退出码 1，
`AssertionError: docs/verification/task-4-report.md must exist`），
说明该入口不是固定打印 passed；补齐文件后才变为 0。

## 18. Git 状态

- 分支：`workbench/agent-core`
- 基线 HEAD：`d548c0c32ceee21c1e614ef8984cf990fd92a202`
- 父提交：`d548c0c32ceee21c1e614ef8984cf990fd92a202`（正确保留 Task 3 与 Task 2 历史）
- 提交信息：`feat(gateway): add routed HTTP transport`
- 内容：14 files changed, 3315 insertions(+), 52 deletions(-)
- **本次修复提交对象的完整 hash 见交付回复**；本文件随该提交一起保存，因此不写自身 hash。
- **分支引用：未写入。** 提交后 `.git/refs/` 为空，`git rev-parse --verify HEAD` 退出 128，
  `git status --short --branch` 显示 `## No commits yet on workbench/agent-core`，
  分支回到 unborn 状态。

### 18.1 实际发生的过程

1. `git add` 只暂存 Task 4 相关文件（14 个），未包含 `.superpowers/`。
2. `git commit -F -` → **退出码 0**，stdout 打印
   `[workbench/agent-core <hash>] feat(gateway): add routed HTTP transport`，
   并列出 14 个文件与新增/删除行数。提交对象确实写入了对象库。
3. 提交后立即验证（**不能只看 commit 的退出码**）：
   - `git rev-parse --verify HEAD` → **128**（`Needed a single revision`）
   - `git rev-parse --verify HEAD^` → **128**
   - `git log --oneline -7` → 128，提示
     `your current branch 'workbench/agent-core' does not have any commits yet`
   - `find .git/refs -type f` → **空**
   - `.git/logs/HEAD` 末行记录：`d548c0c… → <新提交> commit: feat(gateway): add routed HTTP transport`
   - `git fsck --connectivity-only` → `notice: No default references`，以及若干 dangling
     对象：先前尝试留下的中间提交对象与 blob 仍在对象库里但没有引用（最终提交对象本身
     被 reflog 引用，因此不会被列为 dangling）
   - `git show --stat <新提交>` 可正常读出正确的父提交与 14 个文件清单

   也就是说：**提交对象存在且正确，但分支引用没有落盘，分支回到 unborn。**
   被最终对象取代的中间提交对象仍留在对象库中，无害但也未被任何引用指向。

4. 按授权尝试用标准命令恢复引用（`git update-ref refs/heads/workbench/agent-core <hash> 0000…`）：
   - 普通权限 → 退出码 **0**，但 `rev-parse --verify HEAD` 仍 128、`git show-ref` 退出 1、
     `.git/refs` 仍为空 → **未恢复**
   - 受控权限（工具权限提升流程）→ 同上 → **未恢复**

   即：**`git update-ref` 的退出码 0 不能证明引用已恢复。**

### 18.2 遵守的约束

- **没有**手写 `.git/refs`，**没有**手工创建 Git 内部目录；
- **没有**修改 `HEAD` / `packed-refs` / reflog；
- **没有**重新 `git init`，**没有**创建根提交；
- **没有** `git reset --hard` / `git checkout --` / force push；
- **没有**删除用户文件；
- **没有**声称本次修改已经提交成功。

### 18.3 改动没有丢失（完整性证据）

- `git diff --stat <新提交>` → 空（工作区 == 提交内容）
- `git diff --cached --stat <新提交>` → 空（索引 == 提交内容）
- 由于 HEAD 为 unborn，`git status` 把全部文件显示为已暂存新增（`A`），这是预期表现。

### 18.4 未提交文件

`.superpowers/sdd/2026-09-10-independent-agent-workbench-plan/{progress.md,task-0-brief.md,task-0-dispatch.md}`
仍未跟踪（mtime 未变），未修改、未暂存、未提交。

### 18.5 在可正常写引用的环境恢复（一步）

```powershell
git update-ref refs/heads/workbench/agent-core <交付回复中的提交 hash> 0000000000000000000000000000000000000000
git log --oneline -7
```

恢复后应得到
`ebe7925 → d223a76 → e98d345 → fa10eab → e931482 → d548c0c → <修复提交>`。
本次改动已经在提交对象里，无需重新 `git add` / `git commit`。

## 19. 未实现范围

重试、故障转移、多 Provider fallback、Provider 轮换、Provider / Route / Credential
持久化、SQLite、OS Keychain、Agent Loop、多轮模型调用、工具执行、审批、Desktop、
Tauri、CLI、Memory、上下文压缩、探活请求、模型列表请求、供应商 SDK、
CC Switch 集成、Claude Code 集成。

## 20. 已知限制

- **没有任何真实供应商端到端验证**：生产 transport 代码存在，但所有测试都注入 fake
  HTTP client，没有连接过任何真实端点，没有验证过真实 API key，也没有验证过真实供应商
  的错误响应。
- 状态码映射对**未列出**的 5xx 与 3xx 统一回退到 `gateway_error`；这是刻意的保守映射，
  未经真实供应商验证。
- `HttpResponse` 只暴露 `status` 与 `body`：响应头（如 `retry-after`）被刻意丢弃。
- 默认客户端依赖运行时提供全局 `fetch`；若不可用则按传输失败处理。
- 取消竞速依赖协作式的 `HttpClient`；本阶段只保证对外立即结束并释放资源，不对不可协作的
  客户端内部工作做任何保证。
- `CredentialStore` 仍是 Task 2 的内存测试实现，没有生产级安全存储。
- 本次报告的结论只覆盖离线场景；**314 个旧测试通过不代表新功能已被真实验证**，
  **395 个测试通过也不代表不存在其他缺陷**。
