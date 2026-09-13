# Task 23 验证报告

## 范围

Tauri Desktop 与 Node Local Agent Host 跨进程连接 MVP。

## 基线

- HEAD: `4f9fdabd216f50fe20c77cb9955fa5cdbb70a11b`
- HEAD^: `e2a7d2ce820fc592979bc387a012c62856509663`
- 分支: `workbench/agent-core`

## 新增/修改文件

| 文件 | 用途 |
|------|------|
| `apps/desktop/src-tauri/src/sidecar.rs` | `NodeHostSupervisor` + `SidecarLaunchConfig` + 测试（20 Rust 测试） |
| `apps/desktop/src-tauri/src/errors.rs` | 新增 sidecar 错误码与固定消息 |
| `apps/desktop/src-tauri/src/lib.rs` | 注册 `sidecar` 模块 |
| `apps/desktop/src-tauri/tauri.conf.json` | 声明仅包含 sidecar dist 的资源映射 |
| `apps/local-agent-host/package.json` | 使用自包含 sidecar 构建入口 |
| `scripts/build-local-agent-host.mjs` | 编译并重写 Node workspace 运行时闭包 |
| `tests/task-23-sidecar-integration.test.ts` | 集成测试（16） |
| `tests/task-23-sidecar-security.test.ts` | 安全测试（13） |
| `tests/task-23-sidecar-lifecycle.test.ts` | 生命周期测试（6） |
| `tests/task-23-renderer-boundary.test.ts` | Renderer 边界测试（5） |
| `tests/task-23-tauri-integration.test.ts` | Tauri setup、退出清理、资源与构建边界（6） |
| `scripts/evals-deterministic.mjs` | 新增 Task 23 场景与必需文件 |
| `docs/verification/task-23-report.md` | 本报告 |

> 说明：本文件记录 Task 23 首轮实现，首轮报告中的部分行为证据后来被审查发现不足。返工后的权威结果见 [`task-23-rework-report.md`](task-23-rework-report.md)。

## Supervisor 状态机

```text
created → starting → running → stopping → stopped
                ↘ failed
```

- `start()` 幂等；重复 start 返回 Ok
- `stop()` 幂等；未启动时安全
- 健康检查失败 → `failed` + `sidecar_health_timeout`
- 子进程提前退出 → `failed` + `sidecar_start_failed`

## 端口与 Loopback 约束

- host 仅允许 `127.0.0.1`
- port 必须为 1–65535 安全整数
- 默认端口 4317
- 非 loopback 配置拒绝，错误消息固定

## 取消与资源释放

- stop 有界等待（5 秒超时）
- 首轮实现使用 piped stdout/stderr；返工后改为 `Stdio::null()`，详见返工报告
- 返工后健康探活验证 HTTP `GET /health` 与固定 JSON，不再只做 TCP connect
- Drop 时自动 stop
- 迟到 resolve/reject 不产生 unhandled rejection

## 测试数量

- Rust: 76（新增 ~20 sidecar 测试）
- 首轮 TypeScript: 1769 全量（新增 40 Task 23 测试）；返工新增 7 个 Tauri 接入回归，当前总数为 1776

## 受控变异

| # | 变异 | 检出 |
|---|------|------|
| 1 | 允许非 loopback host | 是（config_rejects_non_loopback_host） |
| 2 | 使用 shell 启动 | 是（源码检查：无 cmd/powershell/bash） |
| 3 | 删除健康检查 | 是（start_fails_when_health_never_comes_up） |
| 4 | 健康失败仍报告 running | 是（同上） |
| 5 | 重复 start 创建多个进程 | 是（start_is_idempotent_when_already_running） |
| 6 | stop 不回收进程 | 是（stop_transitions_to_stopped_from_running） |
| 7 | 删除退出清理 | 是（Drop 测试） |
| 8 | NotReady 伪造成功 | 是（turn on NotReady host produces runner_error） |
| 9 | 错误消息拼接原始路径 | 首轮未有效独立检出；返工新增源文件标记断言 |
| 10 | Renderer 直接暴露子进程错误 | 是（renderer data boundary 测试） |

## 验证命令

```text
corepack pnpm install --frozen-lockfile → 0
corepack pnpm verify:layout             → 0
corepack pnpm build:local-agent-host    → 0
corepack pnpm build:desktop             → 0
corepack pnpm typecheck                 → 0
corepack pnpm test                      → 0（首轮 1769；返工后当前 1776 passed）
corepack pnpm security:scan             → 0
corepack pnpm evals:deterministic       → 0
cargo fmt --check                       → 0
cargo check                             → 0
cargo test                              → 0（首轮 76；返工后当前 83 passed）
git diff --check                        → 0
```

## 边界声明

- 没有真实 Provider 调用 / 真实网络 / 真实凭据
- 没有 OS Keychain / CredentialStore 持久化
- 没有安装包 / 托盘 / 自动更新
- 没有修改既有业务逻辑
- 没有修改 `.superpowers/`
- 测试全绿不代表不存在其他缺陷
