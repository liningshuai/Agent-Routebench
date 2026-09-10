# Agent Workbench

独立的本地优先 coding agent 工作台，目标是同时提供 Desktop 与 CLI 两种入口。

## 当前阶段

**工程基线（Task 0）**。仓库目前只包含：

- pnpm workspace 与 TypeScript 基础配置
- Vitest 测试入口
- 布局验证、类型检查、安全扫描占位脚本、确定性评测占位脚本
- Apache-2.0 许可证与架构/许可边界文档

当前**还没有**：

- 真实模型调用
- Agent Loop、Model Gateway、Adapter
- Provider / Route 管理
- 桌面端（Tauri）与 CLI 功能
- 会话存储、工具执行、审批机制、记忆系统

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
