# Agent Workbench

独立的本地优先 coding agent 工作台，目标是同时提供 Desktop 与 CLI 两种入口。

## 当前阶段

**Task 5：有界重试、有序 Provider 故障转移与候选解析**（Task 4 之上）。仓库目前包含：

- pnpm workspace 与 TypeScript 基础配置
- Vitest 测试入口
- 布局验证、类型检查、安全扫描脚本、确定性评测脚本
- Apache-2.0 许可证与架构/许可边界文档
- 中立共享契约包 `@agent-workbench/agent-contracts`
- 协议无关的 Agent Core 消息/工具/请求契约与运行时校验
- `ModelGateway` 接口、`ModelStreamEvent` 流事件
- 完全离线、确定性的 `DeterministicFakeModelGateway`
- 本地内存 Provider / Route 配置核心 `@agent-workbench/provider-registry`
- 双协议离线适配器 `packages/model-gateway/src/adapters`
  - `anthropic_messages`：请求编码 + Messages SSE 流式解码（文本 / 客户端工具 / usage）
  - `openai_compatible`：Chat Completions 请求编码 + SSE 流式解码（仅声明子集）
  - 共享 SSE 分帧器：UTF-8 跨 chunk、LF/CRLF、多行 data、注释、帧与工具参数上限
  - 增量输出、单一终止事件、取消即结束、上游错误清洗
- **`RoutedHttpModelGateway`（`packages/model-gateway/src/routed-http-gateway.ts`）**
  - `routeId` → `ProviderRegistry.resolveRoute()` → `CredentialStore.get(credentialRef)`
  - 协议请求体由既有 adapter 生成；URL 与认证头由 transport 固定拼接
  - 单 Route、单 Provider、单次 HTTP 调用：**没有重试、没有故障转移、没有 Provider 轮换**
  - HTTP 状态与传输异常映射到既有安全错误码，错误消息固定
  - 响应 body 以增量 `AsyncIterable<Uint8Array>` 直接交给既有 decoder
- **可注入 HTTP transport（`packages/model-gateway/src/http-transport.ts`）**
  - `HttpClient` 是可注入的函数边界；生产默认实现基于 Node 24 原生 `fetch`
  - 所有自动化测试注入 fake client，**不访问任何真实供应商**
- **`ResilientRoutedHttpModelGateway`（Task 5）**
  - Route 可配置**有序 fallback Provider 候选**（`fallbackProviderIds`，上限 4）
  - 同一 Provider 内**有界重试**（默认 2 次，总计上限 8 次）
  - Provider 之间**有序故障转移**，从不并行请求
  - 确定性指数退避（`min(initial × 2^n, max)`，无 jitter），`wait` 可注入、可取消
  - 一旦该 attempt 已输出 `text_delta` / `tool_call` / `usage` / `completed`，
    **不再重试也不再切换**，避免重复输出
  - `createRoutedHttpModelGateway()`（Task 4）行为不变：仍是单 Route、单 Provider、单次 HTTP

当前**还没有**：

- 真实供应商端到端验证（没有任何真实模型调用被验证过）
- 探活请求与模型列表请求
- 多轮 Agent Loop、工具执行、审批
- Provider / Route / 凭据的持久化（文件、SQLite、OS Keychain）
- 桌面端（Tauri）与 CLI 功能、Memory、上下文压缩

所有测试默认离线运行，不依赖外部网络服务。OpenAI-compatible 在本阶段**只覆盖
Chat Completions 的文本与 function tool 子集**，不代表支持 Responses API、
Codex 登录或所有 GPT 模型。

凭据边界：secret 只在**单次 HTTP 请求的认证头**里短暂存在，不进入 `ModelRequest`、
Provider / Route 定义、`ResolvedRoute`、请求体、`ModelStreamEvent`、`AgentEvent`、
日志或错误消息。`credentialRef` 只是引用，永远不是秘密本身。

## 目标

- Desktop + CLI 双入口，共享同一个 Agent Core 与本地 Agent API
- 支持 Anthropic Messages 与 OpenAI-compatible 两类模型协议
- Provider、模型与路由由本项目独立配置和管理
- 默认测试离线运行，不依赖外部网络服务

## 与 CC Switch 的关系

CC Switch 仅作为此前的技术研究对象。本项目：

- 不是 CC Switch 的继续修改，也不是其 UI 扩展
- 不把 CC Switch 作为运行时依赖、npm/pnpm 依赖、数据库依赖或配置来源
- 不会自动同步 CC Switch 配置
- 不会复制 Claude Code 源代码

## 开发命令

需要 Node.js 24+ 与 pnpm。

```powershell
pnpm install
pnpm verify:layout
pnpm typecheck
pnpm test
pnpm security:scan
pnpm evals:deterministic
```

## 文档

- [架构说明](docs/architecture.md)
- [协议适配器说明](docs/protocol-adapters.md)
- [HTTP 传输与凭据边界](docs/http-transport.md)
- [重试、故障转移与 Provider 候选](docs/resilience.md)
- [Task 5 执行报告](docs/verification/task-5-report.md)
- [Task 4 执行报告](docs/verification/task-4-report.md)
- [Task 3 执行报告](docs/verification/task-3-report.md)
- [许可证边界](docs/licensing.md)

## 许可证

本项目自有代码的目标许可证为 Apache-2.0，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
