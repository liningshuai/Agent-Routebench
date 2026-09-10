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

凭据只允许存在于本地受控的 Provider 配置层，并在 Model Gateway 出站时注入。

Agent Core 不原样转发 Model Gateway 的错误文本。Gateway 错误码必须命中受控白名单
（`aborted`、`rate_limited`、`upstream_unavailable`、`provider_protocol_error`、
`gateway_error`），其他错误码统一折叠为 `gateway_error`；错误消息一律使用固定文案
（`aborted` 为 `Request aborted.`，其余为 `Model gateway request failed.`）。
因此网关侧的 URL、Authorization、API Key、Token、请求头、Provider 原始响应与异常
堆栈都不会出现在 Agent 事件流中。

### 与 CC Switch 无关

CC Switch 不在本项目运行时调用链中。本项目不调用 CC Switch、不读取其配置、
不依赖其 Provider 管理服务。后续的 Provider、Route、Session、Approval、Memory
均属于本项目自身的数据与服务。

### 协议层

Model Gateway 之下规划两类协议适配：

- Anthropic Messages
- OpenAI-compatible

适配器由本项目自行实现，目标是对接用户自配置的 Provider 端点，
而不是复制任何第三方 Agent 产品的私有协议实现。

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


### 后续任务（未实现）

真实 Model Gateway 适配器、Agent Loop 重试、工具执行、审批、会话存储、Desktop/CLI 入口等。
