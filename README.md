# Agent Workbench

独立的本地优先 coding agent 工作台，目标是同时提供 Desktop 与 CLI 两种入口。

## 当前阶段

**Task 17：Tauri Desktop IPC Bridge MVP**。在 Task 16 的共享 loopback 客户端基础上，增加一个不绑定具体 Tauri 版本的宿主通信适配层：

- `TauriDesktopApiClient`：将宿主注入的 `invoke` / `listen` 映射为现有 `DesktopApiClient`
- 固定的 health、create session、start turn、cancel turn 命令，以及固定的 turn event 通道
- 事件按 `sessionId` / `turnId` 隔离，终止事件后停止继续消费
- AbortSignal 贯穿监听注册、宿主命令和事件等待；取消不等待悬挂 Promise，迟到清理错误被消费
- IPC 响应、Session、Turn request 与事件进行边界校验；宿主异常折叠为固定 Desktop 错误
- 不加入 `@tauri-apps/api` 或 Rust 运行时依赖，真实 Tauri host 只需注入官方 `invoke` / `listen`
- 不读取凭据、不访问 Provider、不连接远程网络；Task 17 只交付可测试的 IPC contract adapter

**Task 16：共享 Local Agent API Client 与 Desktop 回环集成**。在 Task 15 的交互式 Desktop UI 和 Task 13 CLI 基础上，抽取统一的 loopback HTTP 客户端：

- `@agent-workbench/local-agent-client`：CLI 与 Desktop 共用的 Local Agent API 客户端
- 严格 loopback URL 校验：只允许 `http://127.0.0.1` 与 `http://localhost`
- 统一 Session / events envelope 校验、固定错误码与错误消息
- 有界 NDJSON 增量解析：fatal UTF-8、精确事件校验、终止事件与行/总字节限制
- AbortSignal 贯穿 fetch、响应体读取和流解析；取消不等待悬挂 Promise，迟到响应会被释放
- Desktop `createLoopbackDesktopApiClient()`：将共享客户端接入现有 `DesktopApiClient`，不接触模型/Provider/凭据层
- CLI 的 API client 与 NDJSON parser 改为共享实现，保留原有调用兼容性
- 使用真实的本机 `127.0.0.1` Local Agent API 做 Desktop 回环集成验证；不访问外部网络
- Task 16 聚焦测试与全量测试、构建、类型检查、安全扫描和确定性评测均在交付前通过

**Task 15：Desktop Interactive UI**。在 Task 14 基础上新增交互式用户界面，并完成首轮交付修复：

- 完整交互式 UI：`mountDesktopUi()` 挂载函数，DOM 事件监听，响应式渲染
- 取消按钮流程：提交期间显示取消按钮，中止 AbortController，恢复草稿文本
- 草稿保留机制：取消时原子性恢复草稿（draft + isSubmitting 单次 setState）
- 发送按钮逻辑：草稿为空时禁用，有内容时启用
- 流式事件展示：实时渲染 `state.events` 数组
- 订阅机制：`controller.subscribe()` 触发 UI 重新渲染，支持多订阅者
- 会话切换与生命周期：点击会话可切换 active session，卸载时解除订阅、终止进行中的请求并阻止迟到渲染
- 浏览器入口：`browser-entry.ts` 仅使用宿主注入的 `DesktopApiClient`，`public/index.html` 加载编译入口
- 原生 ESM 构建策略：TypeScript 编译到 `dist/`，无需打包器（Tauri 负责打包）
- 57 个测试（9 个测试文件）：另含会话切换、卸载生命周期和浏览器入口回归
- TDD Red-Green-Refactor 方法论：先写失败测试，再修复真实 UI 生命周期缺陷
- 历史 Task 15 变异报告中的检测率以报告为准；本次修复新增边界测试，未把未重跑的变异结果宣称为新证据

**Task 14：Desktop Renderer Shell / Tauri-ready Desktop 基础层**（已完成）：

- `@agent-workbench/desktop`：Tauri-ready Desktop 基础层，为 UI 框架提供状态管理与 API 边界
- `DesktopController`：管理连接、会话、轮次提交、事件流与取消，完整状态机（idle → loading → ready/failed）
- `DesktopApiClient` 接口：依赖注入边界，Desktop 只通过此接口访问 Local Agent API，不直接访问底层包
- 安全 ViewModel 层：XSS 防护（HTML 转义）、凭据隔离（tool_call.input 不进入 UI）、固定错误消息
- 纯函数 Renderer：`renderDesktopPage(state): string`，确定性 HTML 生成，静态 Desktop 页面基础
- 120 个测试（6 个测试文件）：状态管理、控制器行为、安全边界、XSS 攻击、边界情况、渲染结构
- TDD Red-Green-Refactor 方法论：先写失败测试，再实现最小功能，最后重构
- 10 个受控突变测试：80.0% 检测率（8/10 检出），安全边界 100% 覆盖（4/4），状态管理 100% 覆盖

此前在 Task 13 完成：

- `@agent-workbench/cli`：Local Agent API 的官方 Node.js 命令行客户端
- 类型安全的 `LocalAgentApiClient`，完整覆盖所有 API 端点
- 流式 NDJSON 解析器，UTF-8 fatal 验证、尺寸限制、终止事件校验
- 严格安全边界：仅 loopback URL、拒绝 14 种敏感参数、固定错误消息
- 8 种命令：`health`、`create-session`、`get-session`、`list-events`、`cancel`、`run-turn`、`stream-turn`、`version`
- 依赖注入设计（CliIo、CliRuntime、fetch），131 个测试（128 个离线测试 + 3 个集成测试）
- 完整的取消支持：AbortSignal 贯穿全程、信号处理器（SIGINT/SIGTERM）

此前已有：

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
- **`@agent-workbench/agent-runtime`（Task 6）**
  - 有界多轮 Agent Loop：`turn_started` → Agent Core 事件 → 工具执行 → 下一轮
  - 通过 `@agent-workbench/agent-core` 的 `createAgentCore()` 编排，只依赖抽象 `ModelGateway`
  - 工具执行完全由调用方注入（`ToolExecutor`）；runtime **不自带任何工具**
  - 默认上限：`maxTurns = 8`、`maxToolCallsPerTurn = 16`、`maxToolResultBytes = 65536`
  - 工具调用批量校验后才执行，串行、保序、不并行、不改写 id
  - 已输出正常事件后不会重复请求；取消覆盖 gateway / 工具执行 / 退避全程
  - 事件中**不含工具结果内容**：`tool_execution_completed` 只报告 id 与 `isError`
- **工具策略与审批闸门 `createGovernedToolExecutor()`（Task 7，同上包）**
  - 注入式 `ToolPolicy`：返回 `allow` / `deny` / `ask`
  - 注入式 `ToolApprovalHandler`：仅在 `ask` 时被询问，只有精确 `”approved”` 才放行
  - **默认 fail-closed**：没有 policy 就是 `deny`，没有审批处理器就是”审批不可用”
  - 不提供任何工具，也不提供审批 UI；没有持久化、没有”记住此选择”、没有自动批准
  - policy / handler / executor 都接受对象字面量、`null` 原型对象与 class 实例
  - 所有失败与异常都折叠为固定安全结果，不回显异常、URL、路径、token 或 secret
  - `createAgentLoop()` 语义完全不变，闸门是调用方显式包装的可选层
- **Provider / Route 非敏感配置持久化（Task 8）**
- **Local Agent API（Task 9）**
- **Provider 健康检查与模型目录发现（Task 10）**
- **Session 元数据与 AgentEvent 加密持久化（Task 11）**
- **Memory Store 与上下文压缩（Task 12）**

当前**还没有**：

- 真实供应商端到端验证（没有任何真实模型调用被验证过）
- shell / 文件 / 网络工具（runtime 不提供任何默认工具，也不具备这些能力）
- 审批 UI 与自动批准策略
- 审批决策持久化与 “remember this decision”
- 完整 Tauri 原生应用打包、Rust host command 实现与生产 IPC 部署（Task 17 仅完成 TypeScript bridge contract）
- CredentialStore secret 持久化与 OS Keychain
- 持久化 Memory、向量搜索、真实模型摘要调用

已在早期任务完成、不再列为缺失的能力：

- Provider / Route 非敏感配置持久化（Task 8）
- Local Agent API（Task 9）
- Provider 健康检查与模型目录发现（Task 10）
- Session 元数据与 AgentEvent 加密文件持久化（Task 11）
- Memory Store 与上下文压缩（Task 12）
- Node CLI for Local Agent API（Task 13）
- Desktop Renderer Shell / Tauri-ready Desktop 基础层（Task 14）
- Tauri IPC Bridge contract MVP（Task 17）

所有测试默认离线运行，不依赖外部网络服务；Task 9/16 的集成测试只连接临时的
本机 loopback 服务。OpenAI-compatible 在本阶段**只覆盖
Chat Completions 的文本与 function tool 子集**，不代表支持 Responses API、
Codex 登录或所有 GPT 模型。

凭据边界：secret 只在**单次 HTTP 请求的认证头**里短暂存在，不进入 `ModelRequest`、
Provider / Route 定义、`ResolvedRoute`、请求体、`ModelStreamEvent`、`AgentEvent`、
`AgentLoopEvent`、日志或错误消息。`credentialRef` 只是引用，永远不是秘密本身。

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
- [Agent Runtime 与工具执行边界](docs/agent-runtime.md)
- [协议适配器说明](docs/protocol-adapters.md)
- [HTTP 传输与凭据边界](docs/http-transport.md)
- [重试、故障转移与 Provider 候选](docs/resilience.md)
- [Tool Policy、审批闸门与安全执行边界](docs/tool-policy.md)
- [Tauri Desktop IPC Bridge](docs/tauri.md)
- [本地配置持久化](docs/local-persistence.md)
- [Local Agent API](docs/local-agent-api.md)
- [Provider Discovery](docs/provider-discovery.md)
- [Session 加密持久化](docs/session-persistence.md)
- [Node CLI for Local Agent API](docs/cli.md)
- [共享 Local Agent API Client](docs/local-agent-client.md)
- [Desktop Renderer Shell](docs/desktop.md)
- [许可证边界](docs/licensing.md)

## 许可证

本项目自有代码的目标许可证为 Apache-2.0，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
