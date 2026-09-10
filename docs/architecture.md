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

Task 0 只建立工程基线（workspace、类型检查、测试、许可证与文档）。
上述运行时组件尚未实现，也尚未发生任何真实模型调用。
