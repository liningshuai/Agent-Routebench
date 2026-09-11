# 架构说明

## 目标架构

```text
Desktop (Task 14: @agent-workbench/desktop)
   |
CLI (Task 13: @agent-workbench/cli)
   |
Local Agent API
   |
Agent Runtime
   |
Agent Core
   |
Model Gateway
   |----------------------|
Anthropic Messages   OpenAI-compatible
```

## 已完成层级

截至 Task 14，以下层级已实现并通过测试：

- **Desktop**（`@agent-workbench/desktop`）：Tauri-ready 基础层，状态管理、API 边界、安全 ViewModel
- **CLI**（`@agent-workbench/cli`）：Node.js 命令行客户端，类型安全的 API 封装、NDJSON 流式解析、严格安全边界
- **Local Agent API**（`packages/local-agent-api`）：HTTP API 服务器，会话管理、流式轮次、健康检查
- **Agent Runtime**（`@agent-workbench/agent-runtime`）：多轮 Agent Loop、注入式工具执行、取消支持
- **Agent Core**（`@agent-workbench/agent-core`）：单次请求校验、事件映射、错误清洗
- **Model Gateway**（`packages/model-gateway`）：协议适配器（Anthropic Messages、OpenAI-compatible）、HTTP 传输、重试与故障转移
- **Provider Registry**（`@agent-workbench/provider-registry`）：Provider / Route 配置核心、凭据引用
- **Session Persistence**（`packages/session-persistence`）：加密会话存储、AgentEvent 持久化
- **Memory Store**（`@agent-workbench/agent-memory`）：进程内 Memory、确定性上下文压缩

未完成层级：

- **Tauri UI Renderer**：桌面 UI 组件与用户交互层（未开始）

## 契约层与依赖方向

共享契约被抽取到中立包 `@agent-workbench/agent-contracts`，两个实现包都以它为唯一
契约来源：

```text
@agent-workbench/agent-contracts
          ↑                  ↑
          │                  │
@agent-workbench/agent-core  @agent-workbench/model-gateway
```

- `@agent-workbench/agent-contracts` 是**中立契约层**：只包含类型定义与运行时校验，
  不感知 Agent Core 与 Model Gateway 的任何实现细节，也不含任何运行时依赖。
- `@agent-workbench/agent-core` 与 `@agent-workbench/model-gateway` **都依赖**
  `@agent-workbench/agent-contracts`。
- 两个实现包**不得互相依赖**，也不得通过相对路径穿透对方的 `src` 目录
  （禁止出现 `agent-core -> model-gateway`、`model-gateway -> agent-core`
  以及 `../../<other-package>/src/...` 这类导入）。
- `agent-core/src/contracts.ts` 与 `model-gateway/src/contracts.ts` 仅作为兼容性
  转出层（re-export）保留，真实实现只有 `agent-contracts` 一份。

在实际分层中，`Agent Runtime`（Task 6）位于 Agent Core 之上，并且**只**依赖
agent-core 与 agent-contracts：

```text
@agent-workbench/agent-runtime          (多轮 loop + 注入式工具执行边界)
        ↓
@agent-workbench/agent-core             (单次请求校验 + 事件映射 + 错误清洗)
        ↓
@agent-workbench/agent-contracts        (中立契约)

具体网关 (Fake / Routed / Resilient) 通过 ModelGateway 接口在运行时注入。
```

- `agent-runtime` **不得**依赖 `model-gateway` 或 `provider-registry`。
- `agent-core` 与 `model-gateway` **不得**反向依赖 `agent-runtime`。

## Provider / Route 配置核心

Provider 与 Route 配置被抽取到独立包 `@agent-workbench/provider-registry`，它是本项目
自己的配置核心，不依赖其他 workspace 包，也不依赖任何网络 SDK：

```text
官方 Provider Presets
          ↓
Provider Registry
          ↓
Route Registry
          ↓
Resolved Route
          ↓
后续 Model Gateway Adapter
```

- **Provider Registry 是独立配置核心**：Provider 与 Route 只在本项目内部注册与解析，
  CC Switch 不在调用链中。
- **Route 只引用 Provider 和 model**：`RouteDefinition` 只有 `providerId` 与 `model`，
  不携带协议、地址、凭据或任何传输层字段。
- **credentialRef 不等于 secret**：`credentialRef` 形如 `credential:<id>`，只是一个
  指向秘密值的引用。`ProviderDefinition`、`RouteDefinition`、`ResolvedRoute` 都只允许
  出现引用，不允许出现秘密值本身。
- **Task 2 使用内存 Registry**：Provider、Route 与凭据都只存在于进程内存中。
- **Task 2 不提供持久化**：没有文件配置、没有 SQLite、没有 OS Keychain、没有环境变量。
- **Task 2 不发起网络请求**：Registry 只做数据校验与解析，不解析 DNS、不建立连接。
- **Task 2 尚未实现任何真实协议 adapter**：`anthropic_messages` 与 `openai_compatible`
  目前只是被校验与记录的协议枚举，没有任何出站实现。

## 核心原则

### 单一 Agent Core

Desktop 与 CLI 共享同一个 Agent Core，以及同一个 Agent Runtime。两者不得各自实现
独立的 Agent Loop。所有会话推进、工具调用编排与模型请求都经由同一运行时路径
（`@agent-workbench/agent-runtime` → `@agent-workbench/agent-core` → 注入的 `ModelGateway`）。

CLI（Task 13）与 Desktop（Task 14）通过 Local Agent API 访问共享的 Agent Runtime，
而非直接编排 Agent Loop。

### 共享 Local Agent API

Desktop 与 CLI 共享同一个本地 Agent API。两者作为 HTTP 客户端调用 Local Agent API 服务器，
服务器负责 Agent Runtime 编排。UI 层只负责呈现与输入，不直接触碰模型协议细节，
也不绕过 Agent Core 自行拼装请求。

CLI 安全边界：
- 仅接受 loopback URL（`http://127.0.0.1` 或 `http://localhost`）
- 拒绝 14 种敏感命令行参数（`--apiKey`、`--token`、`--secret` 等）
- 固定错误消息，不泄露 URL、响应 body、路径或异常详情

Desktop 安全边界：
- 只通过注入的 `DesktopApiClient` 访问 Local Agent API
- 不直接访问：model-gateway、provider-registry、credential-store、session-persistence、agent-runtime
- XSS 防护：所有用户/模型文本经 HTML 转义后渲染
- 凭据隔离：`tool_call.input`、`route_selected.model`、Provider 信息不进入 ViewModel
- 固定错误消息，不泄露异常详情

### 凭据边界

Provider 凭据（API Key、Token、Authorization header 等）不得进入：

- Agent 事件流
- 应用日志
- Memory / 长期记忆
- Desktop Renderer
- ProviderDefinition / RouteDefinition / ResolvedRoute

凭据只允许存在于本地受控的 Provider 配置层，并在 Model Gateway 出站时注入。

配置与凭据的分离方式是引用：`ProviderDefinition.credentialRef` 只保存
`credential:<id>` 形式的引用，秘密值由独立的凭据库保存，两者永不合并。
`InMemoryProviderRegistry` 不读取、不输出、不记录秘密值，也不接触凭据库；
`ResolvedRoute` 只把引用继续传给后续的 Model Gateway adapter。

Agent Core 不原样转发 Model Gateway 的错误文本。Gateway 错误码必须命中受控白名单
（`aborted`、`rate_limited`、`upstream_unavailable`、`provider_protocol_error`、
`gateway_error`），其他错误码统一折叠为 `gateway_error`；错误消息一律使用固定文案
（`aborted` 为 `Request aborted.`，其余为 `Model gateway request failed.`）。
因此网关侧的 URL、Authorization、API Key、Token、请求头、Provider 原始响应与异常
堆栈都不会出现在 Agent 事件流中。

Provider Registry 的错误信息同样只使用固定文案：不回显输入值、URL、字段名或任何
疑似秘密的内容，调用方必须依据稳定错误码（如 `forbidden_provider_field`、
`invalid_provider_url`、`invalid_credential_ref`）而不是错误文本做判断。

### 与 CC Switch 无关

CC Switch 不在本项目运行时调用链中。本项目不调用 CC Switch、不读取其配置、
不依赖其 Provider 管理服务。后续的 Provider、Route、Session、Approval、Memory
均属于本项目自身的数据与服务。

### 协议层

Model Gateway 之下规划两类协议适配：

- Anthropic Messages
- OpenAI-compatible（本阶段限定为 **Chat Completions**）

适配器由本项目自行实现，目标是对接用户自配置的 Provider 端点，
而不是复制任何第三方 Agent 产品的私有协议实现。

Task 3 已实现两类协议的**离线 codec**（请求转换 + SSE 流式解析）。codec 本身始终是纯转换层：

- 不建立任何连接，不拼接 URL，不注入认证头；
- 不读取 `CredentialStore`；
- 不做路由调度、重试或故障转移。

Task 4 在 codec **之上**新增了 Routed HTTP Gateway 与可注入 HTTP transport。传输关注点
（URL、认证头、状态码映射、取消传播）全部集中在 transport 层，codec 依旧保持纯粹：
它不知道自己的字节从哪来、也不知道凭据长什么样。详见
[协议适配器说明](protocol-adapters.md) 与 [HTTP 传输与凭据边界](http-transport.md)。

工具事件（`tool_call`）目前仍是内部数据，**不得**直接当作未来 Renderer 的安全展示
事件使用。

## 当前实现状态

### Task 0（已完成）

工程基线：workspace、类型检查、测试、许可证与文档。

### Task 1（已完成）

已建立协议无关的内部契约与完全离线的 Model Gateway 测试实现：

| 组件 | 位置 | 职责 |
|------|------|------|
| 中立共享契约 | `packages/agent-contracts/src/contracts.ts` | 统一消息、工具调用/结果、工具定义、ModelRequest、运行时校验（含 `role` 白名单校验） |
| Gateway 契约 | `packages/agent-contracts/src/gateway-contracts.ts` | `ModelGateway` 接口与 `ModelStreamEvent` 流事件 |
| Agent Core | `packages/agent-core/src/agent-core.ts` | 校验请求后按顺序产出 `AgentEvent`；清洗 Gateway 错误消息；不执行工具、不发第二轮请求 |
| Agent Core 兼容层 | `packages/agent-core/src/contracts.ts` | 仅 re-export `agent-contracts`，不复制实现 |
| Model Gateway 兼容层 | `packages/model-gateway/src/contracts.ts` | 仅 re-export `agent-contracts`，不复制实现 |
| Deterministic Fake Gateway | `packages/model-gateway/src/fake-gateway.ts` | 离线、可重复的事件回放；无网络调用 |

边界：

- Desktop / CLI 尚未接入；当前只有共享契约与 Fake Gateway。
- `ModelRequest` 不含 apiKey、token、authorization、headers、baseUrl、endpoint 等凭据字段。
- Provider 凭据仍不得进入事件流；未来由 Provider 配置层在真实 Gateway 出站时注入。
- Gateway 的原始错误文本不进入 Agent 事件流，只保留受控白名单错误码与固定安全消息。
- `@agent-workbench/agent-core` 与 `@agent-workbench/model-gateway` 之间不存在依赖，
  二者只依赖 `@agent-workbench/agent-contracts`。
- **当前仍没有真实模型调用**，也没有 Anthropic / OpenAI-compatible 适配器。

### Task 2（已完成）

已建立完全离线的本地 Provider / Route 配置核心：

| 组件 | 位置 | 职责 |
|------|------|------|
| 类型与校验 | `packages/provider-registry/src/types.ts` | `ProviderDefinition`、`RouteDefinition`、`ResolvedRoute`、协议枚举与全部运行时校验 |
| 错误契约 | `packages/provider-registry/src/errors.ts` | `ProviderRegistryError` 与稳定错误码表；固定文案，不回显输入 |
| 凭据库 | `packages/provider-registry/src/credential-store.ts` | 仅测试用的内存 `InMemoryCredentialStore`，按 `credentialRef` 精确存取 |
| 官方预设 | `packages/provider-registry/src/presets.ts` | Anthropic 与 OpenAI 两个预设；无密钥、无 headers、不自动注册 |
| 内存注册表 | `packages/provider-registry/src/registry.ts` | Provider/Route 增删改查与 `ResolvedRoute` 解析 |

边界：

- Provider 与 Route 只保存在内存中，进程结束即丢失，**没有任何持久化**。
- 官方预设只是只读模板，不自动注册、不自动启用、不发起网络请求。
- 无效配置会被拒绝：非法 ID、重复 ID、非法协议、非法 URL（含 query/hash/userinfo）、
  非法 `credentialRef`、非法 model，以及任何 `apiKey` / `token` / `authorization` /
  `headers` / `secret` 等禁止字段。
- `resolveRoute()` 遇到不存在的 Route、disabled Route、不存在的 Provider、disabled
  Provider 时分别抛出稳定错误码。注册表本身仍是**纯数据边界**，不做网络 I/O，也不
  自己重试或切换；有序候选（`fallbackProviderIds`）与 `resolveRouteCandidates()` 只
  提供数据，真正的重试与故障转移在 Task 5 的网关层完成。
- **当前仍没有真实模型调用**，Task 5 之前 `anthropic_messages` 与 `openai_compatible`
  尚无出站 adapter（Task 4 起由 Routed HTTP Gateway 提供）。

### Task 3（已完成）

已在既有 `@agent-workbench/model-gateway` 内实现两类协议的完全离线 codec：

| 组件 | 位置 | 职责 |
|------|------|------|
| 适配器类型 | `packages/model-gateway/src/adapters/types.ts` | `ProtocolAdapter`、`EncodedModelRequest`、`StreamDecodeOptions`、`OpenAIChatAdapterOptions` |
| 错误契约 | `packages/model-gateway/src/adapters/errors.ts` | `AdapterError`（encode 抛出）与 `AdapterStreamError`（decode 内部）+ 稳定 code |
| 请求子集校验 | `packages/model-gateway/src/adapters/request-validation.ts` | 先跑共享校验器，再执行协议可表达性与工具关联规则 |
| 共享 SSE 分帧 | `packages/model-gateway/src/adapters/sse.ts` | 字节 → SSE 帧；UTF-8 跨 chunk、LF/CRLF、多行 data、注释、帧上限 |
| Anthropic 请求 | `packages/model-gateway/src/adapters/anthropic-request.ts` | `ModelRequest` → Messages body |
| Anthropic 流 | `packages/model-gateway/src/adapters/anthropic-stream.ts` | Messages SSE → `ModelStreamEvent` |
| OpenAI 请求 | `packages/model-gateway/src/adapters/openai-chat-request.ts` | `ModelRequest` → Chat Completions body |
| OpenAI 流 | `packages/model-gateway/src/adapters/openai-chat-stream.ts` | Chat Completions SSE → `ModelStreamEvent` |
| 流式运行时 | `packages/model-gateway/src/adapters/stream-runtime.ts` | 增量驱动、取消、单一终止事件、上游释放 |
| 解码原语 | `packages/model-gateway/src/adapters/decode-utils.ts` | 帧内 JSON、token 计数、缓存令牌与错误类型映射 |

边界：

- **没有真实传输**：不建连、不拼 URL、不注入认证、不读取凭据库、无网络调用。
- 两段都是纯函数链：`ModelRequest` → body，测试字节流 → `ModelStreamEvent`。
- 未知业务事件严格拒绝；截断（`max_tokens` / `length`）与不支持内容绝不视为成功。
- 上游错误只按结构化类型映射，原始 message / JSON / URL / 认证字段 / 堆栈不进入事件。
- `decode` 增量输出并支持取消；每次调用最多一个终止事件，终止后停止消费并释放上游。
- 包依赖未变：`model-gateway` 仍只依赖 `agent-contracts`。
- **当前仍没有真实模型调用**，也没有对任何供应商端点做过验证。

### Task 4（已完成）

已在 `@agent-workbench/model-gateway` 内实现 **Routed HTTP Model Gateway**：把
`ProviderRegistry`、`CredentialStore`、协议 codec 与一个**可注入的 HTTP 客户端**
串成真实传输路径。链路：

```text
ModelRequest
  → routeId
  → ProviderRegistry.resolveRoute()
  → CredentialStore.get(credentialRef)
  → 协议 Adapter.encode()
  → 固定协议 URL + 认证头
  → 注入式 HttpClient
  → 增量字节流
  → 既有 Adapter.decode()
  → ModelStreamEvent
  → Agent Core
```

| 组件 | 位置 | 职责 |
|------|------|------|
| HTTP 契约与默认实现 | `packages/model-gateway/src/http-transport.ts` | `HttpRequest` / `HttpResponse` / `HttpClient`；URL 拼接；状态码映射；body 释放；基于 Node 24 原生 `fetch` 的默认 client |
| Routed Gateway | `packages/model-gateway/src/routed-http-gateway.ts` | `RoutedHttpModelGateway` / `createRoutedHttpModelGateway`：路由解析、凭据读取、编码、单次 HTTP 调用、增量解码 |

边界：

- **单 Route、单 Provider、单次 HTTP 调用**：没有重试、没有故障转移、没有 Provider 轮换。
- `request.model` 必须与 `ResolvedRoute.model` 完全一致；不一致时固定失败，不静默改写。
- `credentialRef` 为 `null`、凭据缺失或为空时**不发起任何 HTTP 请求**。
- URL 由「校验过的 baseUrl（去掉尾部 `/`）+ 固定 endpoint」拼成，endpoint 不可被
  `ModelRequest`、Route 或额外字段覆盖，且不会产生重复 `//`。
- 认证头是固定的：Anthropic 只用 `x-api-key` + `anthropic-version`，OpenAI 只用
  `authorization: Bearer …`；两者都只出现在 `HttpRequest.headers`。
- HTTP 状态与传输异常映射到既有安全白名单错误码，错误消息固定；非 2xx 响应的 body
  **不会被读取**，也不会交给 adapter。
- `HttpClient` 是注入点：生产用默认客户端，**所有自动化测试注入 fake client**，
  因此测试不访问真实网络。
- 包依赖新增 `@agent-workbench/provider-registry`（仅类型/公开接口），
  `provider-registry` 仍然零依赖且不反向依赖 gateway。详见
  [HTTP 传输与凭据边界](http-transport.md)。

- **本阶段仍未连接任何真实供应商**：生产 transport 代码存在，但没有做过真实
  端到端验证，也没有验证过真实 API key 或真实供应商错误。


### Task 5（已完成）

已在同一 `@agent-workbench/model-gateway` 内实现有界重试与有序 Provider 故障转移，
并在 `@agent-workbench/provider-registry` 内实现 Route 的有序候选配置。

| 组件 | 位置 | 职责 |
|------|------|------|
| Route fallback 配置 | `packages/provider-registry/src/types.ts` | `RouteDefinition.fallbackProviderIds?`、`MAX_ROUTE_FALLBACKS`、fallback 校验与深拷贝 |
| 候选解析 | `packages/provider-registry/src/registry.ts` | `resolveRouteCandidates()`：主 Provider + 有序 fallback，跳过 disabled；删除/更新时保护被引用的 Provider |
| 单次尝试运行器 | `packages/model-gateway/src/candidate-attempt.ts` | 单个候选的一次尝试：读凭据、编码、固定 URL/头、单次 HTTP、增量解码、取消（Task 4 与 Task 5 共用） |
| 重试策略 | `packages/model-gateway/src/resilience.ts` | `RetryPolicy`、确定性退避、retryable/visible 判定、可注入 `wait` |
| 弹性网关 | `packages/model-gateway/src/resilient-routed-gateway.ts` | `ResilientRoutedHttpModelGateway`：有界重试 + 有序故障转移 + 已输出守卫 |

边界：

- `createRoutedHttpModelGateway()` 的行为**未改变**：仍是单 Route、单 Provider、单次 HTTP。
  重试与故障转移只由 `ResilientRoutedHttpModelGateway` 提供。
- attempt 顺序固定且串行：`primary → fallback 1 → fallback 2 …`，每 Provider 最多
  `maxAttemptsPerProvider` 次，全部合计最多 `maxTotalAttempts` 次；不并行、不回退到已耗尽的候选。
- 只对受控的 retryable 错误（`rate_limited` / `upstream_unavailable` 且
  `retryable === true`）重试或切换；`aborted`、`provider_protocol_error`、
  `gateway_error` 与任何 `retryable === false` 一律直接输出。
- 一旦该 attempt 已输出 `text_delta` / `tool_call` / `usage` / `completed`，
  **不再重试也不再切换**，因此不会重复文本、工具调用或 usage 计数。
- 退避完全确定性、无 jitter；`wait` 可注入，并在 `AbortSignal` 触发时立即结束。
- 候选只携带 `credentialRef`；secret 只在单次请求的认证头中存在。
- 依赖未变：`provider-registry` 仍零运行时依赖；`model-gateway` 仍只依赖
  `agent-contracts` + `provider-registry`。详见 [重试与故障转移](resilience.md)。

- **仍未连接任何真实供应商**：没有验证过真实限流、真实供应商错误或真实 API key。


### Task 6（已完成）

新增独立包 `@agent-workbench/agent-runtime`：把 Agent Core 的单次模型请求组合成
**有界多轮循环**，并把工具执行交给**调用方注入**的执行器。

| 组件 | 位置 | 职责 |
|------|------|------|
| 公开类型 | `packages/agent-runtime/src/types.ts` | `ToolExecutor`、`AgentLoopOptions`、`AgentLoopEvent`、`AgentLoop`、`DEFAULT_AGENT_LOOP_LIMITS` |
| 稳定错误 | `packages/agent-runtime/src/errors.ts` | `AGENT_LOOP_ERROR_CODES`、固定文案、`AgentLoopError`、固定工具失败内容 |
| Agent Loop | `packages/agent-runtime/src/agent-loop.ts` | 轮次编排、工具调用批量校验、串行执行、消息追加、取消竞速、资源释放 |
| 统一导出 | `packages/agent-runtime/src/index.ts` | 公开接口 + 复用 agent-core / agent-contracts 的类型与实现 |

依赖方向：

```text
@agent-workbench/agent-runtime
        ↓ 只依赖
@agent-workbench/agent-core  →  @agent-workbench/agent-contracts
```

- `agent-runtime` **不依赖** `model-gateway`，也**不依赖** `provider-registry`。
  具体网关（Fake / Routed / Resilient）都通过 `ModelGateway` 抽象接口注入。
- `agent-core` 不反向依赖 `agent-runtime`；`model-gateway` 同样不依赖它。
- 没有跨包 `src` 穿透导入；校验与错误清洗继续复用 Agent Core，未复制实现。

边界：

- runtime **不自带任何工具**：没有 shell、没有文件读写、没有网络；源码中不存在
  `fetch(`、`node:http`、`node:https`、`node:fs`、`node:child_process` 等能力。
- 默认上限：`maxTurns = 8`、`maxToolCallsPerTurn = 16`、`maxToolResultBytes = 65536`；
  非法配置同步抛出 `invalid_loop_options`。
- 单轮工具调用**整批校验后才执行**（数量 → 执行器是否存在 → 名称是否声明 → 轮数预算），
  串行、保序、不改写 id；`id` 在整个 loop 内唯一。
- 工具结果只进入下一轮 `ModelRequest`；`tool_execution_completed` 只暴露
  `toolCallId` 与 `isError`，**不含结果内容**，原始异常一律折叠为固定安全结果。
- 取消覆盖 gateway 流、工具执行与每一轮切换；取消后不再开始下一次模型请求，
  也不输出 `completed` / `loop_completed`。
- 仍未连接真实供应商，测试中的网关与工具执行器全部是注入式 fake。
  详见 [Agent Runtime](agent-runtime.md)。


### Task 7（已完成）

在 `@agent-workbench/agent-runtime` 内新增**注入式**工具执行闸门，位于 Task 6 的
`ToolExecutor` 之前：

```text
ToolExecutionRequest → ToolPolicy → allow / deny / ask → ToolApprovalHandler → ToolExecutor
```

| 组件 | 位置 | 职责 |
|------|------|------|
| 策略与审批类型 | `packages/agent-runtime/src/types.ts` | `ToolPolicyDecision`、`ToolPolicy`、`ToolApprovalDecision`、`ToolApprovalRequest`、`ToolApprovalHandler`、`GovernedToolExecutorOptions` |
| 闸门实现 | `packages/agent-runtime/src/tool-policy.ts` | `createGovernedToolExecutor()`、固定结果常量、`invalid_tool_policy_options`、结构化 callable method 校验 |
| 统一导出 | `packages/agent-runtime/src/index.ts` | 公开接口与常量 |

边界：

- **默认 fail-closed**：没有注入 `ToolPolicy` 就是 `deny`；`ask` 而没有
  `ToolApprovalHandler` 就是“审批不可用”；只有精确返回 `"approved"` 才执行。
- 闸门是**显式包装层**：`createAgentLoop()` 完全不知道策略与审批的存在，
  Task 6 的轮次编排、取消、错误清洗、串行执行与消息追加逻辑一行未改。
- 不提供任何工具：没有 shell 工具、文件工具或网络工具；本包不含
  `child_process`、`fs`、`http`、`https`、`fetch`、`WebSocket`、`process.env`。
- 没有审批 UI、没有审批事件、没有决策持久化、没有 “remember this decision”、
  没有自动批准策略。
- 所有策略 / 审批 / 执行异常折叠为固定安全结果，不回显 message、stack、URL、
  路径、`Authorization`、`Bearer`、token 或 secret。
- policy、approval handler、executor 都通过**结构化方法校验**，因此对象字面量、
  `null` 原型对象与 class 实例同样可用。
- 取消覆盖 policy pending、approval pending、批准后执行前与 executor 运行期。
  详见 [Tool Policy 与审批闸门](tool-policy.md)。


### Task 8（已完成）

新增 `@agent-workbench/local-persistence`，用于持久化**非敏感** Provider / Route 配置：

```text
ProviderRegistry
        ↓
Versioned Config Snapshot (PersistedConfigV1, version: 1)
        ↓
JSON Config Store (InMemoryJsonConfigStore / FileJsonConfigStore)
        ↓
Atomic Local File Store (temp + rename)
```

边界：

- 只保存 Provider 的 `id / name / protocol / baseUrl / credentialRef / models / enabled`
  与 Route 的 `id / name / providerId / model / enabled / fallbackProviderIds`。
- `credentialRef` 仅为 `credential:<id>` 引用；secret、CredentialStore 内容、
  环境变量密钥、headers 永不进入快照或文件。
- 校验拒绝未知字段、敏感字段、循环对象、`undefined`、非有限数字与不一致的
  enabled / model / provider 关系；错误 message 固定，不回显路径或 JSON。
- 文件保存采用 validate → serialize → sibling temp → rename；同一 store 的 save
  串行化；rename 失败不伪造成功。
- 依赖方向：`local-persistence → provider-registry`；provider-registry 不依赖
  local-persistence，也不引入 `node:fs`。
- 仍未连接真实供应商，不持久化 secret，不实现 OS Keychain、Session、Memory、
  Local Agent API、CLI 或 Desktop。详见 [Local Persistence](local-persistence.md)。


### Task 9（已完成）

新增 `@agent-workbench/local-agent-api`：Desktop / CLI 共享的本机回环 HTTP 控制面。

```text
Desktop / CLI
      ↓
Local Agent API (loopback 127.0.0.1 / localhost)
      ↓
LocalAgentRunner (injected)
      ↓
Agent Core / Runtime (future)
```

边界：

- 仅绑定回环地址；拒绝 `0.0.0.0`、`::` 与远程 host。
- Session 创建 / 查询 / 运行 / 取消；内存存储，不落盘。
- `POST /v1/sessions/:id/turns` 以 NDJSON 增量输出 `AgentEvent`。
- Session 内单并发（`409 session_busy`）；不同 Session 与不同 Server 实例完全隔离。
- 注入式 `LocalAgentRunner`；本包不调用 Provider、不读 CredentialStore。
- 固定安全错误；递归拒绝敏感字段；无 CORS、不读环境变量、不写文件。
- 依赖方向：`local-agent-api → agent-contracts / agent-core`；不依赖
  model-gateway、provider-registry、local-persistence。
- 详见 [Local Agent API](local-agent-api.md)。


### Task 10（已完成）

新增 `@agent-workbench/provider-discovery`：Provider 健康检查与模型目录发现。

```text
ProviderRegistry + CredentialStore
        ↓
createProviderDiscovery({ registry, credentialStore, httpClient })
        ↓
注入式 DiscoveryHttpClient（GET）
        ↓
Anthropic /v1/models  或  OpenAI-compatible /models
```

边界：

- 只读配置与凭据；不修改 Provider / Route / CredentialStore / 持久化文件。
- `CredentialStore.get()` 每次调用最多一次；从不 `set`/`delete`。
- secret 仅临时用于出站请求头，不进入返回值、错误消息或 URL。
- 注入式 HttpClient；源码无 `fetch(`、`node:http`、`process.env`。
- 无重试、无故障转移、无缓存；非 2xx 不读取响应体。
- 依赖方向：`provider-discovery → provider-registry + model-gateway`。
- 详见 [Provider Discovery](provider-discovery.md)。


### Task 11（已完成）

新增 `@agent-workbench/session-persistence`：加密本地 Session 持久化。

```text
Local Agent API (LocalAgentSessionStore)
        ↓
FileLocalAgentSessionStore
        ↓
AES-256-GCM Envelope 文件
```

边界：

- 只持久化 Session 元数据与 AgentEvent 历史；不持久化 TurnRequest / ModelRequest / secret。
- key 由调用方注入（32 字节 Uint8Array），不写入文件、不进日志、不从环境变量读取。
- 原子写入（sibling temp + rename）+ 失败回滚。
- 加载时 `running` → `failed`，移除 `activeTurnId`；不恢复执行器 / Promise。
- 依赖方向：`session-persistence → local-agent-api → agent-core`。
- 详见 [Session Persistence](session-persistence.md)。


### Task 12（已完成）

新增 `@agent-workbench/agent-memory`：进程内 Memory 与确定性上下文压缩。

```text
Agent Runtime / Future API
        ↓
@agent-workbench/agent-memory
        ├─ InMemoryMemoryStore
        └─ deterministic Context Builder
                ↓
        injected ContextSummarizer
```

边界：

- Memory 是调用方显式写入的数据，不从消息/工具结果自动提取。
- 搜索为确定性文本匹配，无向量/Embedding/网络。
- 上下文按 UTF-8 字节预算压缩；保留 system / 最后 user / tool 原子组。
- Summarizer 为注入式边界；无 summarizer 时压缩失败而非静默丢弃。
- 依赖方向：`agent-memory → agent-core`。
- 详见 [Memory](memory.md)。


### Task 13（已完成）

已实现 CLI 包：Node.js 命令行客户端，类型安全 API 封装，流式 NDJSON 解析器。

| 组件 | 位置 | 职责 |
|------|------|------|
| API 客户端 | `packages/cli/src/api-client.ts` | `LocalAgentApiClient`：Session CRUD、流式轮次提交、取消 |
| NDJSON 解析 | `packages/cli/src/ndjson-parser.ts` | UTF-8 fatal 验证、尺寸限制、终止事件校验 |
| 命令实现 | `packages/cli/src/commands/*.ts` | 8 种命令：health、create-session、get-session、list-events、cancel、run-turn、stream-turn、version |
| 安全边界 | `packages/cli/src/security.ts` | 仅 loopback URL、拒绝 14 种敏感参数、固定错误消息 |
| 注入式 IO | `packages/cli/src/io.ts` | CliIo 接口：stdin、stdout、stderr、环境变量 |

边界：

- 只接受 loopback URL（`http://127.0.0.1` 或 `http://localhost`）；非 loopback 直接拒绝。
- 拒绝敏感命令行参数：`--apiKey`、`--token`、`--secret`、`--authorization`、`--bearer`、
  `--credential`、`--password`、`--privateKey`、`--accessToken`、`--refreshToken`、
  `--clientSecret`、`--apiSecret`、`--authToken`、`--sessionToken`。
- 固定错误消息，不泄露 URL、响应 body、路径或异常详情。
- 完整取消支持：AbortSignal 贯穿全程、SIGINT/SIGTERM 信号处理器。
- 131 个测试（128 个离线测试 + 3 个集成测试），依赖注入设计（CliIo、CliRuntime、fetch）。
- 依赖方向：`cli → local-agent-api → agent-core`。
- 详见 [CLI](cli.md)。


### Task 14（已完成）

已实现 Desktop 基础层：Tauri-ready 状态管理、API 边界、安全 ViewModel。

| 组件 | 位置 | 职责 |
|------|------|------|
| 类型定义 | `apps/desktop/src/types.ts` | `DesktopState`、`DesktopApiClient` 接口 |
| 错误契约 | `apps/desktop/src/errors.ts` | `DesktopError`、`DESKTOP_ERROR_CODES` |
| 状态控制器 | `apps/desktop/src/controller.ts` | `DesktopController`：连接管理、会话创建、轮次提交、取消 |
| 安全 ViewModel | `apps/desktop/src/view-model.ts` | `escapeHtml()`、`createEventViewModel()`、`renderEventToHtml()` |

边界：

- Desktop 只通过注入的 `DesktopApiClient` 访问 Local Agent API。
- 不直接访问：model-gateway、provider-registry、credential-store、session-persistence、
  local-persistence、agent-runtime、cc-switch-agent。
- 不自行实现 Agent Loop，不拼装模型协议，不处理 Provider 认证。
- XSS 防护：`escapeHtml()` 转义 `< > & " '`，不使用 `innerHTML`。
- 凭据隔离：`tool_call.input` 不进入 ViewModel；`route_selected.model`、Provider URL、
  credentialRef、Authorization、Bearer、token、secret 不进入 ViewModel。
- 固定错误消息，不回显用户输入或异常详情。
- 纯函数 Renderer：`renderDesktopPage(state): string`，确定性 HTML 生成，静态 Desktop 页面基础。
- 120 个测试（6 个测试文件），TDD Red-Green-Refactor 方法论。
- 10 个受控突变测试，80.0% 检测率（8/10 检出），安全边界 100% 覆盖（4/4）。
- 依赖方向：`desktop → local-agent-api (types only) → agent-core`。
- 详见 [Desktop](desktop.md)。


### 后续任务（未实现）

CredentialStore / OS Keychain 持久化、审批 UI 与自动批准策略、
Tauri UI Renderer、向量搜索、真实模型摘要调用等。
