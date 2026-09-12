# Task 19 收尾验证报告 — 固定 Native IPC 成功响应边界

## 1. 基线 HEAD 与父提交

- HEAD：`bec8cd5db051c2e476ad9a9778bfd6a54dacbe9f`（feat(desktop): add native host runtime boundary）
- 父提交：`e9c65eb4b8e5924e29fb762922aff08e230fb2a3`
- 分支：`workbench/agent-core`；工作区仅 `.superpowers/` 未跟踪
- 基线检查：`git cat-file -e <HEAD>^{commit}`、`git merge-base --is-ancestor` 全部通过

## 2. 原问题与根因

`HostBackend` 三个方法的成功返回值与 Tauri command 的成功返回值均为
`Result<serde_json::Value, HostError>`。错误侧已是固定 `HostError`，但成功侧是开放
结构：未来接入真实 Backend 后，任意字段都可能经 IPC 进入前端。根因是 Task 19 首轮
实现时只固定了错误边界，未固定成功响应类型。

## 3. 修复方案

- `backend.rs`：新增命令专用封闭成功类型（私有字段 + 校验构造函数 + camelCase 序列化）：
  `HostSessionStatus`（五值封闭枚举）、`HostSession`（五字段，`activeTurnId` 未设置时
  `skip_serializing_if` 省略）、`CreateSessionResponse { session }`、
  `StartTurnResponse { turnId }`、`CancelTurnResponse { ok: true }`；trait 签名改为
  `Result<CreateSessionResponse | StartTurnResponse | CancelTurnResponse, HostError>`。
  `serde_json::Value` 仅保留为 `start_turn` 的已校验输入类型。
- `errors.rs`：新增固定错误 `invalid_response` / `"Agent host response is invalid."`。
- `commands.rs`：三个 command 与 `*_checked` helper 的成功类型同步收窄；校验顺序、
  委托顺序、command 名称/参数名、`agent_health` 无状态读取全部不变。
- `runtime.rs`：测试专用 fake 适配 typed trait；参数透传测试改为记录参数 + 断言成功
  值严格为 `{ "turnId": "turn-echo" }`。

## 4. 修改文件清单

`apps/desktop/src-tauri/src/backend.rs`、`errors.rs`、`commands.rs`、`runtime.rs`；
`tests/task-19-response-boundary.test.ts`（新增 17 测试）；
`tests/task-19-native-runtime.test.ts`、`tests/task-19-native-runtime-security.test.ts`
（契约断言从接受 `Value` 收紧为要求 typed 签名）；
`scripts/evals-deterministic.mjs`（task 19 场景加入新测试文件）；
`docs/tauri.md`、`docs/architecture.md`、本报告。

## 5. TDD 证据

- **Red**（实现前，`corepack pnpm test tests/task-19-response-boundary.test.ts`）：
  退出码 1，`9 failed | 8 passed (17)`。代表性失败：
  - `expected '//! The injectable backend boundary o…' not to contain 'Result<serde_json::Value'`
  - `expected '' to match /pub struct CreateSessionResponse…/`（类型不存在）
- **Green**：该文件 17 passed；Task 19 全部四个文件 60 passed；Rust 55 passed；
  全量 80 文件 / 1586 测试全部通过。

## 6. 受控变异（6 项，全部执行并恢复）

| # | 变异 | 检出 | 证据 |
| --- | --- | --- | --- |
| 1 | typed response 改回 `serde_json::Value` 透传 | ✓ exit 1 | `no longer returns open serde_json::Value` + typed 签名断言（2 失败） |
| 2 | Session 增加 `apiKey` 字段 | ✓ exit 1（TS）+ 101（cargo 编译拒绝：构造器未提供字段） | 禁词扫描命中 `api_key` |
| 3 | Session 增加未知字段 `extra` | ✓ exit 1（TS）+ 101（cargo 编译拒绝） | 精确结构断言 |
| 4 | `{ turnId }` 增加额外字段 | ✓ exit 1 | `StartTurnResponse carries only turn_id` 等（2 失败） |
| 5 | 空 `turnId` 构造成功 | ✓ exit 1（TS）+ 101（cargo：`start_turn_response_rejects_empty_turn_id` FAILED） | |
| 6 | 错误消息含 serde 文本 / 动态内容 | ✓ 101（cargo：`invalid_response_has_the_fixed_contract` FAILED）；动态嵌入被编译器拒绝（E0425） | |

恢复方式：变异前文件副本原位还原（未使用 `git checkout --`）；恢复后 55 Rust +
60 TS 全部复验绿色；`grep -R "MUTATION|api_key|turn_id.as_str|serde rejected" apps/desktop/src-tauri/src .cargo`
无残留（validation.rs 中的 `"api_key"` 为 Task 18 敏感字段拒绝字面量，非残留）。

## 7. 验证命令与退出码

| # | 命令 | 退出码 |
| --- | --- | --- |
| 1 | `corepack pnpm install --frozen-lockfile` | 0 |
| 2 | `corepack pnpm verify:layout` | 0 |
| 3 | `corepack pnpm typecheck` | 0 |
| 4 | `corepack pnpm build:desktop` | 0 |
| 5 | `corepack pnpm test tests/task-19-*.test.ts` | 0（60 passed） |
| 6 | `corepack pnpm test` | 0（80 文件 / 1586 测试） |
| 7 | `corepack pnpm security:scan` | 0（308 files） |
| 8 | `corepack pnpm evals:deterministic` | 0（17 场景 + cargo target 检查） |
| 9 | `cargo fmt -- --check` | 0（先 fmt 后 --check 通过） |
| 10 | `cargo check` | 0 |
| 11 | `cargo test` | 0（55 passed） |

Rust cargo 调用均不带 `CARGO_TARGET_DIR`（依赖已提交的 `.cargo/config.toml`）。

## 8. 全量测试数量

TypeScript 1586（80 文件）；Rust 55。Task 19 收尾新增：TS 17（response-boundary）+
Rust 8（序列化精确性 / 构造器拒绝 / wrapper 结构）。

## 9. 安全边界

无真实 Provider / 模型调用 / CredentialStore / API key / Token / Authorization /
URL 拼接 / 网络客户端 / `fetch` / `std::net` / `std::process` / `std::env`；
无新增 Tauri capability；无 shell/fs/http/sql 权限；无远程 devUrl；
无动态错误消息；成功响应不含 Provider、Route、model、credentialRef；
`serde_json::Value` 仅作为已校验输入；`NotReadyBackend` 行为不变；仍无真实
`agent_turn_event` 发布；`.superpowers/` 未读取、未暂存、未提交。

## 10. 未实现范围

真实 Agent Backend、真实 Provider、真实模型调用、CredentialStore、Local Agent API
Server、Node 子进程、安装包、托盘、自动更新、真实事件流发布——Task 20 / 21 未开始。
测试全绿不代表不存在其他缺陷。

## 11. 已知问题

1. 变异 2/3 同时被 cargo 在编译期拒绝（新增序列化字段未同步构造器）——记录为
   "检测发生在编译期 + TS 源码级双重检出"。
2. `cargo fmt --check` 首次运行报告格式差异，已执行 `cargo fmt` 后通过（未改变语义，
   全部测试复验通过）。
