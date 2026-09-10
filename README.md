# Agent Workbench

独立的本地优先 coding agent 工作台，目标是同时提供 Desktop 与 CLI 两种入口。

## 当前阶段

**Task 1：共享 Agent Core 契约与离线 Model Gateway**（Task 0 工程基线之上）。仓库目前包含：

- pnpm workspace 与 TypeScript 基础配置
- Vitest 测试入口
- 布局验证、类型检查、安全扫描脚本、确定性评测脚本
- Apache-2.0 许可证与架构/许可边界文档
- 协议无关的 Agent Core 消息/工具/请求契约与运行时校验
- `ModelGateway` 接口、`ModelStreamEvent` 流事件
- 完全离线、确定性的 `DeterministicFakeModelGateway`
- 覆盖契约、Fake Gateway 与 Agent Core 行为的离线测试

当前**还没有**：

- 真实模型调用与网络请求
- Anthropic Messages / OpenAI-compatible 真实适配器
- Provider / Route 管理与凭据存储
- 桌面端（Tauri）与 CLI 功能
- 会话数据库、工具执行器、审批机制、记忆系统、上下文压缩

所有测试默认离线运行，不依赖外部网络服务。

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
- [许可证边界](docs/licensing.md)

## 许可证

本项目自有代码的目标许可证为 Apache-2.0，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
