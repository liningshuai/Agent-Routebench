# Task 23 返工验证报告

## 1. 返工结论

Task 23 首轮报告把“有 supervisor 测试”误当成“已经接入 Tauri 运行时”，并把 TCP 可连接当成健康。返工已补齐这两个边界，同时修复了停止失败被吞掉、等待超时被当作成功、子进程输出管道可能阻塞、并发 start/stop 竞态，以及构建产物直接执行时没有真正启动 Host 的入口遗漏。

本报告只记录返工新增的证据；Task 23 原始报告保留为历史记录。

## 2. 基线

- 基线提交：`048aeaa95dcceaf55ab3da7f7480419c78a7a22a`
- 分支：`workbench/agent-core`
- 远程：`https://github.com/liningshuai/Agent-Routebench.git`
- 开工前未跟踪内容：仅 `.superpowers/`；该目录未读取、未修改、未暂存、未提交

## 3. 修复内容

### Tauri 生命周期

`apps/desktop/src-tauri/src/lib.rs` 现在在 Tauri `setup` 中从 resource dir 构造经过校验的 `SidecarLaunchConfig`，创建并启动 `NodeHostSupervisor`，再通过 `app.manage()` 持有实例。Tauri `RunEvent::Exit` 回调调用同一 supervisor 的 `stop()`，并且不创建第二套 command 或事件协议。

`tauri.conf.json` 仅将 `../../local-agent-host/dist/` 映射为 `local-agent-host/dist/` 资源；源代码树和 workspace 符号链接不进入资源。Renderer 继续使用既有 Task 17 typed Tauri IPC bridge，避免在 UI 中新增未校验的 HTTP/IPC 分支。

### Sidecar 健康检查

`TcpHealthProbe` 仍只连接 `127.0.0.1`，但连接后还必须发送 `GET /health`，获得 HTTP 200，并解析为：

```json
{"ok":true,"service":"agent-workbench-local-api","version":1}
```

仅有监听端口、错误路径、错误状态、非法 JSON 或错误服务身份都不会令 supervisor 进入 `Running`。

### 进程回收与并发

- stdout/stderr 改为 `Stdio::null()`，不再创建无人消费的满管道。
- stop 先识别已退出进程；kill 失败、wait 超时和 wait 错误均返回固定 `sidecar_stop_failed`，不会报告 `Stopped`。
- 每个 supervisor 增加 operation lock，start/stop 不再在“Starting 但 child 尚未存入”窗口内交叉执行；并发 start 共享一次实际启动结果。
- 健康超时的清理失败不会被吞掉；状态仍为 `Failed`。

### 自包含 sidecar 构建

新增 `scripts/build-local-agent-host.mjs`。它编译 Local Agent Host 及其 workspace 运行时闭包，重写 workspace bare imports，检查最终 JS 不含未解析的 workspace import，并写入 `type: module` 元数据。`apps/local-agent-host/package.json` 的 build 脚本指向该构建入口。

`apps/local-agent-host/src/main.ts` 保持库导入无副作用，同时在文件被 Node 直接执行时调用 `runLocalAgentHostMain()` 并设置退出码，确保 Tauri supervisor 启动的 `dist/main.js` 会实际监听 Local Agent API。

## 4. TDD 证据

返工前先加入回归测试，当前旧实现真实变红：

- TypeScript：Tauri 接入测试 `4 failed / 5`，缺少 setup/退出生命周期、资源声明和安全输出配置。
- Rust：sidecar 测试 `3 failed / 25`，分别暴露 TCP 假健康、吞掉 kill 失败、吞掉 wait 超时。

实现后：

- `tests/task-23-tauri-integration.test.ts`：**7 passed**
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib sidecar::tests`：**27 passed**
- Task 23 TypeScript 聚焦测试：**47 passed**（原 40 + 返工接入测试 7）
- 全量 TypeScript：**1776 passed**；Rust：**82 passed**
- Task 17/18 Tauri 回归测试：全部通过
- self-contained sidecar 构建：成功，最终 dist 无 `@agent-workbench/*` bare import
- 直接执行构建后的 `dist/main.js`：真实启动并返回 `/health` 200，退出时已清理测试子进程

## 5. 受控缺陷验证

新增证据至少覆盖以下变体：

| 变体 | 预期结果 |
| --- | --- |
| TCP 监听但 `/health` 返回 `{}` | 不进入 Running |
| `/health` 带额外字段 | 不进入 Running |
| kill 返回错误 | stop 返回 `sidecar_stop_failed`，状态为 Failed |
| wait 超时 | stop 返回 `sidecar_stop_failed`，状态为 Failed |
| kill 失败后再次 stop | 保留子进程句柄并允许安全重试 |
| stdout/stderr 使用 piped | TypeScript 源码边界测试失败 |
| 移除 Tauri setup / Exit cleanup | Tauri 集成边界测试失败 |
| sidecar 保留 workspace bare import | 构建脚本的 import closure 断言失败 |
| 直接执行 `dist/main.js` 不调用入口 | 入口回归测试与真实 loopback `/health` 检查失败 |

原 Task 23 的“错误消息拼接源文件路径”变异此前没有被有效检出；本次错误边界测试额外拒绝 `sidecar.rs` / `errors.rs` 等源文件标记，避免仅检查 `node` 或 `/app` 造成漏检。

## 6. 验证命令

返工过程中已实际执行并通过：

```text
corepack pnpm build:local-agent-host       → 0
corepack pnpm exec vitest run ...          → 0（Task 17/18 + 返工测试）
cargo fmt --manifest-path ... -- --check   → 0
cargo check --manifest-path ...            → 0
cargo test --manifest-path ... sidecar::tests → 0（27）
```

最终交付前的完整验证结果：

```text
corepack pnpm install --frozen-lockfile     → 0
corepack pnpm verify:layout                 → 0
corepack pnpm typecheck                     → 0
corepack pnpm build:local-agent-host        → 0
corepack pnpm build:desktop                 → 0
corepack pnpm test                          → 0（1776）
corepack pnpm security:scan                 → 0（413 files）
corepack pnpm evals:deterministic           → 0（Task 3–23）
cargo fmt --manifest-path ... -- --check    → 0
cargo check --manifest-path ...             → 0
cargo test --manifest-path ... --lib        → 0（82）
tauri build --no-bundle                     → 0（target/release/agent-routebench.exe）
post-build security:scan                    → 0（413 files）
git diff --check / --cached --check         → 0 / 0
```

交付前还必须重新执行并记录：

```text
corepack pnpm install --frozen-lockfile
corepack pnpm verify:layout
corepack pnpm typecheck
corepack pnpm build:local-agent-host
corepack pnpm build:desktop
corepack pnpm test
corepack pnpm security:scan
corepack pnpm evals:deterministic
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
git diff --check
git diff --cached --check
```

## 7. 未完成边界

本返工没有声称已经完成 Tauri command 到 Node Backend 的真实代理。Rust command 仍使用既有 typed `HostRuntime`，生产默认仍是 `host_not_ready`；Node sidecar 当前作为独立、受监督的 Local Agent Host 运行。真实 Provider、CredentialStore/OS Keychain、配置加载、安装包、托盘和自动更新仍未实现。

无真实 Provider、无真实凭据、无外部网络访问；构建期下载 Rust crates 不属于运行时 Provider 调用。

## 8. Git 交付

返工实现与测试提交：

```text
commit 6389020193602e2b4c4be368ba5e32d4b2b4c93a
parent 048aeaa95dcceaf55ab3da7f7480419c78a7a22a
message fix(desktop): harden Task 23 sidecar integration
```

该提交包含返工实现、回归测试、构建脚本和对应文档对齐；提交时使用显式文件名暂存，未包含 `.superpowers/`。报告文件随后作为独立的验证文档提交，父链保持上述实现提交。推送目标为 `origin/workbench/agent-core`；未使用 force push、amend、reset、checkout 或 `git add .`。
