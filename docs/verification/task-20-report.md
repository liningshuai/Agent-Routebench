# Task 20 验证报告 — Loopback Local Agent API Host Entry and Lifecycle

## 1. 基线

- HEAD：`7b12e3c0fe87c2c4b7017df0ae5dbb3de1c05678`（fix(desktop): type native IPC success responses）
- 父提交：`bec8cd5db051c2e476ad9a9778bfd6a54dacbe9f`
- 分支：`workbench/agent-core`；工作区仅 `.superpowers/` 未跟踪
- 基线检查：分支、HEAD、HEAD^、两个提交对象存在性、父链（`merge-base --is-ancestor`）、
  远程 `origin/workbench/agent-core` 可读性全部通过

## 2. Task 19 文档问题及修复

`docs/tauri.md` Task 19 章节旧文本称三个方法 "returning
`Result<serde_json::Value, HostError>`"，与同文件 typed response 章节冲突。已改写为：
三个方法返回 command-specific typed response
（`Result<CreateSessionResponse|StartTurnResponse|CancelTurnResponse, HostError>`），
并明确 `serde_json::Value` 仅作为 `agent_start_turn` 的已校验输入。README 中同类旧
描述一并修正。`docs/tauri.md` 中 Task 18 历史章节保持原样（未被误读为当前实现——
Task 18 描述的是 TypeScript bridge，与 Backend 成功类型无关）。未修改任何
`apps/desktop/src-tauri` 生产代码。

## 3. Task 20 交付内容

新增独立 workspace app `apps/local-agent-host/`（包名
`@agent-workbench/local-agent-host`），复用 `@agent-workbench/local-agent-api` 的
`createLocalAgentApiServer()`，不复制、不改写服务器核心。

### 公开接口

- `createLocalAgentHost(options): LocalAgentHost`
  - `LocalAgentHostOptions { host?: "127.0.0.1" | "localhost"; port: number; runner?: LocalAgentRunner }`
  - `LocalAgentHost { start(); close(); address(); state() }`
- `NotReadyLocalAgentRunner`：默认 Runner
- `isLocalAgentRunner` / `LOOPBACK_HOSTS`
- `LocalAgentHostError`（七个固定错误码 + 固定消息）
- `runLocalAgentHostMain(options)`：Node 入口（`--host/--port` 参数解析、SIGINT/SIGTERM
  可注入注册、返回退出码而非 `process.exit()`）

### 参数校验

- host 仅 `127.0.0.1` / `localhost`；`0.0.0.0`、`192.168.*`、`10.*`、`172.16.*`、`::1`、
  `[::1]`、`example.com`、`https://example.com` 以固定 `host_not_loopback` 拒绝
- port 必须 1–65535 安全整数；0、负数、小数、NaN、Infinity、字符串、65536+
  以固定 `invalid_port` 拒绝
- runner：object literal / null-prototype / class 实例均可；null、数组、primitive、
  缺失 `run()`、非函数 `run()` 以固定 `invalid_options` 拒绝
- 错误消息固定，不回显 host/port/底层异常

### 生命周期

created → starting → running → closing → closed；`start()` 仅一次成功（并发 start
只建一个服务器，其余返回固定 `already_started`）；启动失败不伪造 running（state 回到
created）；`close()` 幂等（对未启动宿主安全，closed 后重复 close 为 no-op）；
`address()` 启动前为 `undefined`、运行中为 loopback URL、关闭后为 `undefined`；
两个实例完全隔离（闭包状态，无全局/静态共享）。

### 默认 Runner

`NotReadyLocalAgentRunner.run()` 抛出固定 `Local agent runner is not ready.`，由既有
Task 9 服务器折叠为固定 `runner_error` 事件（消息 `"Agent runner failed."`）——不产生
模型文本、`tool_call`、`usage` 或 `completed`，不泄露内部消息。

## 4. 修改/新增文件清单

新增：

- `apps/local-agent-host/package.json`、`tsconfig.json`
- `apps/local-agent-host/src/types.ts`、`errors.ts`、`validation.ts`、`host.ts`、`main.ts`、`index.ts`
- `tests/helpers/local-agent-host-fixtures.ts`
- `tests/task-20-local-agent-host.test.ts`（13）
- `tests/task-20-local-agent-host-security.test.ts`（10）
- `tests/task-20-local-agent-host-lifecycle.test.ts`（14）
- `tests/task-20-local-agent-host-integration.test.ts`（10）
- `docs/local-agent-host.md`、`docs/verification/task-20-report.md`（本文件）

修改：`package.json`（新增 `build:local-agent-host` / `local-agent-host` 脚本，均使用
`corepack pnpm --filter`）、`pnpm-lock.yaml`（workspace 注册，无第三方依赖）、
`README.md`、`docs/architecture.md`、`docs/tauri.md`（仅修复旧描述）、
`scripts/evals-deterministic.mjs`（stage 1 文件 + task 20 场景）。

## 5. TDD 证据

- **Red**（实现前）：`corepack pnpm test tests/task-20-*.test.ts` 退出码 1，
  `4 failed (4)` 套件全部收集失败：`Cannot find module
  '../apps/local-agent-host/src/index.js'` —— 失败由能力缺失直接导致。
- **Green**：实现后聚焦测试 47 passed；Task 9（65）/ Task 13（131）/ Task 16（60）
  回归全部通过；全量 84 文件 / 1633 测试通过。

## 6. 受控变异（8 项，全部执行并恢复）

| # | 变异 | 检出 | 失败测试（文件） |
| --- | --- | --- | --- |
| 1 | 允许 `0.0.0.0` | ✓ exit 1 | `0.0.0.0 is rejected as non-loopback`（host.test） |
| 2 | 允许远程 hostname | ✓ exit 1 | `remote hostnames and URLs`、`private and IPv6` 等 4 失败（host.test） |
| 3 | 删除重复 `start()` 守卫 | ✓ exit 1 | `repeated start`、`concurrent start`（lifecycle）2 失败 |
| 4 | 删除 `close()` 幂等 | ✓ exit 1 | `close() is idempotent` 等 3 失败（lifecycle） |
| 5 | 默认 Runner 伪造 text_delta + completed | ✓ exit 1 | `only the fixed runner_error event`、`never leaks` 2 失败（host.test） |
| 6 | Runner 原始消息以事件形式内嵌 | ✓ exit 1 | `never leaks internal details` 等 3 失败（host.test） |
| 7 | 删除 loopback-only 限制（跳过整个 validateHostOptions） | ✓ exit 1 | host.test + security.test 共 6 失败 |
| 8 | 信号处理跳过 `close()` | ✓ exit 1 | `registers SIGINT and SIGTERM exactly once and closes idempotently`（lifecycle，端口释放断言失败） |

恢复：全部使用变异前文件副本原位还原（未使用 `git checkout --`）；恢复后 Task 20
聚焦测试 47 passed 复验绿色；`grep -R "mutation|MUTATION|fake text|req-internal|0.0.0.0"
apps/local-agent-host/src` 无残留。

## 7. 验证命令与退出码

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `corepack pnpm install --frozen-lockfile` | 0 | lockfile 与新 workspace 一致 |
| 2 | `corepack pnpm verify:layout` | 0 | |
| 3 | `corepack pnpm typecheck` | 0 | |
| 4 | `corepack pnpm build:local-agent-host` | 0 | 输出 `apps/local-agent-host/dist/`（git 忽略） |
| 5 | `corepack pnpm test tests/task-20-*.test.ts` | 0 | 47 passed |
| 6 | `corepack pnpm test tests/task-9-*.test.ts` | 0 | 65 passed |
| 7 | `corepack pnpm test tests/task-13-*.test.ts` | 0 | 131 passed |
| 8 | `corepack pnpm test tests/task-16-*.test.ts` | 0 | 60 passed |
| 9 | `corepack pnpm test` | 0 | 84 文件 / 1633 测试 |
| 10 | `corepack pnpm security:scan` | 0 | 328 files scanned |
| 11 | `corepack pnpm evals:deterministic` | 0 | 18 场景 + cargo target 检查 |
| 12 | `cargo fmt -- --check` / `cargo check` / `cargo test` | 0 | 55 Rust 测试通过 |
| 13 | `git diff --check` / `git diff --cached --check` | 0 | |

Tauri release 构建未在本任务重跑（未触碰 `apps/desktop/src-tauri/**`）；Rust 侧仅
确认 `cargo check` / `cargo test` 仍通过。

## 8. 边界确认

- 网络：仅 loopback 监听；无 outbound HTTP/`fetch`/`axios`/`undici`/WebSocket；
  无 CORS 头；无远程 devUrl。
- 凭据与环境：无 CredentialStore、无 API key/token/Authorization、不读取
  `process.env`（CLI 端口来自 `--port` 参数）。
- 进程：无子进程、无 shell、无 `process.exit()`（入口返回退出码）。
- 依赖：host 包仅依赖 `@agent-workbench/local-agent-api`、
  `@agent-workbench/agent-core`（workspace）与 typescript（dev）；无第三方运行时依赖。
- 持久化：无文件写入、无数据库；`dist/` 构建输出被 git 忽略。
- `.superpowers/`：未读取、未修改、未暂存、未提交。

## 9. 未实现范围

真实 Agent Backend、真实模型调用、Provider Registry 接入、CredentialStore 接入、
Tauri 到真实 Backend 的组装、真实 `agent_turn_event` 流——**Task 20 只提供 loopback
Local Agent API Host 入口和生命周期管理；Task 21 才负责完整 Agent Backend 组装**。
测试全绿不代表不存在其他缺陷。

## 10. 环境问题

1. 根脚本使用 `corepack pnpm --filter ...`（而非既有脚本的裸 `pnpm`），因为当前
   shell 的 PATH 中 `pnpm` 仅可通过 corepack 调用；`corepack` 随 Node 分发，对用户
   环境等效。
2. 公开 host 选项拒绝 port 0，因此集成测试通过随机有效端口 + 冲突重试获得监听端口
   （`randomTestPort()` + `createStartedTestHost` 重试 25 次），未削弱公开校验。
