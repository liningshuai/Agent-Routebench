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
| Agent Core 契约 | `packages/agent-core/src/contracts.ts` | 统一消息、工具调用/结果、工具定义、ModelRequest 与运行时校验 |
| Agent Core | `packages/agent-core/src/agent-core.ts` | 校验请求后按顺序产出 `AgentEvent`；不执行工具、不发第二轮请求 |
| Model Gateway 契约 | `packages/model-gateway/src/contracts.ts` | `ModelGateway` 接口与 `ModelStreamEvent` 流事件 |
| Deterministic Fake Gateway | `packages/model-gateway/src/fake-gateway.ts` | 离线、可重复的事件回放；无网络调用 |

边界：

- Desktop / CLI 尚未接入；当前只有共享契约与 Fake Gateway。
- `ModelRequest` 不含 apiKey、token、authorization、headers、baseUrl、endpoint 等凭据字段。
- Provider 凭据仍不得进入事件流；未来由 Provider 配置层在真实 Gateway 出站时注入。
- **当前仍没有真实模型调用**，也没有 Anthropic / OpenAI-compatible 适配器。

### 后续任务（未实现）

真实 Model Gateway 适配器、Agent Loop 重试、工具执行、审批、会话存储、Desktop/CLI 入口等。
