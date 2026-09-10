# 架构说明

## 目标架构

```text
Desktop
   |
CLI
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

Desktop 与 CLI 共享同一个 Agent Core。两者不得各自实现独立的 Agent Loop。
所有会话推进、工具调用编排与模型请求都经由同一运行时路径。

### 共享 Local Agent API

Desktop 与 CLI 共享同一个本地 Agent API。UI 层只负责呈现与输入，
不直接触碰模型协议细节，也不绕过 Agent Core 自行拼装请求。

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

Task 3 已实现两类协议的**离线 codec**（请求转换 + SSE 流式解析），但它们仍然：

- 不建立任何连接，不拼接 URL，不注入认证头；
- 不读取 `CredentialStore`；
- 不做路由调度、重试或故障转移。

也就是说，当前是「统一 `ModelRequest` → 协议 body」与「测试字节流 → `ModelStreamEvent`」
这两段纯函数链，中间的真实传输尚未实现。详见
[协议适配器说明](protocol-adapters.md)。

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
  Provider 时分别抛出稳定错误码，**不做自动重试，也不做故障转移**。
- **当前仍没有真实模型调用**，`anthropic_messages` 与 `openai_compatible` 尚无出站 adapter。

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


### 后续任务（未实现）

真实 HTTP 传输与认证注入、Provider 路由调度、重试与故障转移、Provider / Route /
凭据持久化、Agent Loop、工具执行、审批、会话存储、Desktop/CLI 入口等。
