# Task 18 验证报告 — Tauri Native Desktop Shell and Host IPC MVP

## 1. 最终状态

DONE_WITH_CONCERNS

（全部验证命令真实执行并通过；遗留两个已记录的环境性关注点：
(a) `cargo fmt --check` 首次引入时需先对新增 Rust 代码执行 `cargo fmt`；
(b) security:scan 无法扫描 `src-tauri/target/` 下超过 Node 字符串上限的构建产物，
因此 Rust 构建输出必须通过 `CARGO_TARGET_DIR` 指向仓库根 `target/`（已被 git 忽略、
不在扫描根内），该约束已写入测试与文档。详见第 13、14 节。）

## 2. 基线信息

| 项目 | 值 |
| --- | --- |
| 分支 | `workbench/agent-core` |
| 基线 HEAD | `9e7ce285baba3dc8f6c8530d26f0a8b3c2502668`（feat(desktop): add Tauri IPC bridge MVP） |
| 基线父提交 | `e685d8093e58759430a46fc6d90403e65b8295dc` |
| 工作区 | 仅 `.superpowers/` 未跟踪（任务开始时与结束时一致） |
| 远程 | `origin = https://github.com/liningshuai/Agent-Routebench.git` |

执行前检查全部通过：`git rev-parse --verify HEAD`、`git rev-parse --verify HEAD^`、
`git cat-file -e HEAD^{commit}`、`git status --short --branch`、`git log --oneline -8`、
`rustc --version`（1.98.1）、`cargo --version`（1.98.1）、
`corepack pnpm --version`（12.3.4）、`corepack pnpm typecheck`（通过）、
`corepack pnpm test`（基线 1447 个测试全部通过）。

## 3. Task 18 实现摘要

- **Tauri 项目**：`apps/desktop/src-tauri/` 为可编译的 Tauri 2 项目
  （Cargo 依赖仅 `tauri`、`tauri-build`、`serde`、`serde_json`）。
- **Rust host**：`lib.rs` 经 `tauri::generate_handler!` 注册四个固定 command；
  `agent_health` 只报告宿主进程（`{"ok":true,"service":"agent-workbench-tauri-host","version":1}`）；
  其余三个命令在严格输入校验后统一返回固定 `host_not_ready`，不伪造任何 Session/Turn/事件。
- **Frontend entry**：`apps/desktop/src/tauri-entry.ts` 导入官方
  `@tauri-apps/api/core` 的 `invoke` 与 `@tauri-apps/api/event` 的 `listen`，
  经 Task 17 的 `createTauriDesktopApiClient` 接入现有 `mountDesktopUi`；
  浏览器预览入口（`public/index.html` → `browser-entry.js`）保持不变。
- **Command registration**：Rust command 名称与 `TAURI_COMMANDS`、
  `TAURI_EVENTS` 完全一致，由 TypeScript 测试逐字节比对。
- **Capabilities**：仅 `core:event:default`（main 窗口）；无 shell/fs/http/process/sql
  等插件；严格 CSP（`default-src 'self'; script-src 'self'; style-src 'self'`；
  `connect-src ipc: http://ipc.localhost` 为 Tauri IPC 回环所需）；无远程 devUrl；
  `bundle.active: false`。
- **Build chain**：`corepack pnpm build:desktop` → `scripts/build-desktop.mjs`
  确定性原生 ESM 构建：tsc → `dist/`，运行时依赖闭包（`@tauri-apps/api`、
  `@agent-workbench/local-agent-client`、`@agent-workbench/agent-core`、
  `@agent-workbench/agent-contracts`）vendored 至 `dist/vendor`，bare specifier
  重写为相对路径；无打包器、无 CDN。
- **Backend not ready boundary**：错误契约固定为
  `host_not_ready` / `invalid_request` / `invalid_session_id` / `invalid_turn_id` /
  `forbidden_field`，消息为静态字符串，不含异常、栈、路径、URL 或输入回显。

## 4. 修改文件清单

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/package.json` | 新增官方 `@tauri-apps/api@^2.9.5`（解析 2.11.1）与 `@tauri-apps/cli@^2.9.6`（解析 2.11.4） |
| `apps/desktop/src/tauri-entry.ts` | Tauri 前端真实入口（官方 invoke/listen → Task 17 bridge → mountDesktopUi） |
| `apps/desktop/src-tauri/Cargo.toml` | Tauri 2 Rust 清单，依赖白名单 |
| `apps/desktop/src-tauri/Cargo.lock` | Rust 依赖锁定（cargo 生成） |
| `apps/desktop/src-tauri/build.rs` | `tauri_build::build()` |
| `apps/desktop/src-tauri/tauri.conf.json` | Tauri 2 配置（窗口/CSP/frontendDist/bundle.active:false） |
| `apps/desktop/src-tauri/capabilities/default.json` | 最小 capabilities（仅 main 窗口 + core:event:default） |
| `apps/desktop/src-tauri/icons/icon.ico` | tauri-build 在 Windows 生成资源文件所需图标（确定性生成的最小 32×32 图标） |
| `apps/desktop/src-tauri/gen/schemas/*.json` | tauri CLI 构建时从 tauri.conf.json / capabilities 生成的确定性 ACL schema 快照（随提交便于审计权限变化） |
| `apps/desktop/src-tauri/src/main.rs` | 入口（release 隐藏控制台窗口） |
| `apps/desktop/src-tauri/src/lib.rs` | Builder + `generate_handler!` 命令注册 |
| `apps/desktop/src-tauri/src/commands.rs` | 四个固定 command + `TURN_EVENT` 常量 + Rust 单元测试 |
| `apps/desktop/src-tauri/src/errors.rs` | 固定 `HostError{code,message}` 契约 + 单元测试 |
| `apps/desktop/src-tauri/src/validation.rs` | 纯函数请求校验（标识符/messages/tools/maxTokens/敏感字段） + 单元测试 |
| `scripts/build-desktop.mjs` | 确定性 Desktop 构建（tsc + vendor + bare-import 重写 + dist/index.html） |
| `package.json` | `build:desktop` 指向 `scripts/build-desktop.mjs` |
| `pnpm-lock.yaml` | 新增 Tauri 官方依赖的锁定条目 |
| `tests/helpers/tauri-native-fixtures.ts` | Task 18 共享测试夹具（配置/源码扫描、命令名提取） |
| `tests/task-18-tauri-native-shell.test.ts` | 配置、capabilities、command contract、前端入口、布局（36 测试） |
| `tests/task-18-tauri-native-security.test.ts` | 依赖边界、环境隔离、校验、无伪造后端、错误卫生（29 测试） |
| `tests/task-18-tauri-native-build.test.ts` | 构建产物、cargo check/test、tauri build（14 测试） |
| `README.md`、`docs/architecture.md`、`docs/desktop.md`、`docs/tauri.md` | Task 18 文档 |
| `scripts/evals-deterministic.mjs` | Stage 1 新增 Task 18 期望文件；Stage 2 新增 task 18 场景与总结 |

允许清单之外的唯一新增：`apps/desktop/src-tauri/icons/icon.ico`。
原因：tauri-build 在 Windows（MSVC）目标上生成资源文件时强制要求 `icons/icon.ico`，
缺失时 `cargo check` 直接失败（真实报错：`` `icons/icon.ico` not found; required for
generating a Windows Resource file during tauri-build ``）。该图标属于 Tauri 原生
项目的必要组成部分，且为确定性生成的最小 32×32 图标。

## 5. 公开接口和 command contract

| 名称 | 方向 | Payload | 成功响应 | 错误 |
| --- | --- | --- | --- | --- |
| `agent_health` | invoke | 无参数 | `{"ok":true,"service":"agent-workbench-tauri-host","version":1}` | —（不失败） |
| `agent_create_session` | invoke | 无参数 | —（MVP 永不成功） | `host_not_ready` |
| `agent_start_turn` | invoke | `{ sessionId: string, request: { messages, tools?, routeId?, model?, maxTokens? } }` | —（MVP 永不成功） | 校验失败：`invalid_session_id` / `forbidden_field` / `invalid_request`；其后：`host_not_ready` |
| `agent_cancel_turn` | invoke | `{ sessionId: string, turnId: string }` | —（MVP 永不成功） | `invalid_session_id` / `invalid_turn_id`；其后：`host_not_ready` |
| `agent_turn_event` | listen（保留） | `{ sessionId, turnId, event }` | — | MVP 宿主**从不发布**该事件；名称作为固定契约保留 |

敏感字段拒绝名单（Rust 侧）：`apiKey`、`api_key`、`token`、`authorization`、
`Authorization`、`headers`、`secret`、`password`、`credential`、`baseUrl`、`endpoint`。
未知字段拒绝；`messages`（角色/内容结构）、`tools`（name/description/inputSchema）、
`maxTokens`（1..4,000,000）结构校验全部在返回 `host_not_ready` 之前完成。

## 6. TDD Red / Green 证据

**Red（实现不存在时，2026-09-12 18:50:46）**：

```text
Test Files  3 failed (3)
     Tests  62 failed | 3 passed | 14 skipped (79)
```

失败原因均为 Task 18 目标文件不存在（`tauri.conf.json`、`src-tauri/*`、
`tauri-entry.ts`、`scripts/build-desktop.mjs`、`dist` 产物）——来自 Task 18 缺失，
非基线失败（基线 1447 测试全部通过）。

**Green（实现后，聚焦测试）**：

```text
tests/task-18-tauri-native-shell.test.ts + security: 65 passed (36 + 29)
tests/task-18-tauri-native-build.test.ts: 14 passed (13.4s)
```

## 7. 测试数量

| 类别 | 数量 |
| --- | --- |
| Task 18 TypeScript 测试文件 | 3 |
| Task 18 TypeScript 测试 | 79（shell 36 + security 29 + build 14） |
| Rust 单元测试（`cargo test`） | 32（commands 12、validation 14、errors 5、另 1 个辅助） |
| 全量测试文件 | 76（基线 73 + Task 18 新增 3） |
| 全量测试 | 1526（基线 1447 + Task 18 新增 79） |

## 8. 受控变异结果

共 8 项，逐项真实执行（变异 → 运行相关测试 → 记录退出码与失败测试 → 恢复 → 复验）。

| # | 变异 | 执行 | 检出 | 失败测试（证据） | 恢复后 |
| --- | --- | --- | --- | --- | --- |
| 1 | `agent_start_turn` 改名为 `agent_start_turn_renamed`（commands.rs + lib.rs） | ✓ | ✓ exit 1 | `Rust host defines exactly the four fixed commands`、`Rust command names match the TypeScript contract without spelling drift` | exit 0，36/36 通过 |
| 2 | `frontendDist` 改为 `../src` | ✓ | ✓ exit 1 | `frontendDist points at the built Desktop static assets` | exit 0 |
| 3 | `build.devUrl` 添加 `https://evil.example.com` | ✓ | ✓ exit 1 | `no remote devUrl is configured`、`tauri.conf.json references no remote origin` | exit 0 |
| 4 | capabilities 加入 `shell:allow-execute` | ✓ | ✓ exit 1 | `capabilities enable no filesystem, shell, http, process or sql access`、`capabilities only enable allowlisted core permissions`、`capabilities contain no dangerous permission markers` | exit 0 |
| 5 | `agent_create_session` 返回伪造成功 Session | ✓ | ✓ exit 1 | `agent_create_session returns the fixed host_not_ready error` | exit 0 |
| 6 | 禁用敏感字段拒绝（`if false && FORBIDDEN_FIELDS…`） | ✓ | ✓ exit 101 | **由 Rust 单元测试检出**（`cargo test`）：`validation::tests::rejects_every_forbidden_field`、`commands::tests::start_turn_rejects_forbidden_fields_before_the_backend_check` FAILED。如实记录：仅运行 shell/security 两个 TypeScript 文件时未检出（exit 0）；检出来自 build 文件内的 `cargo test` | exit 0，32/32 通过 |
| 7 | 删除 tauri-entry 对官方 `listen` 的导入与使用 | ✓ | ✓ exit 1 | `tauri-entry imports listen from the official @tauri-apps/api/event` | exit 0 |
| 8 | 删除 CSP | ✓ | ✓ exit 1 | `CSP is present and locks default/script/style to 'self'`、`CSP does not allow external resources or unsafe script execution` | exit 0 |

恢复方式：全部通过变异前保存的文件副本原位还原（未使用 `git checkout --`）；
恢复后逐项复验通过，并以 `grep` 复核无变异残留。

## 9. 安全证明

- **无真实 Provider**：Rust host 无 HTTP 客户端 crate（Cargo 无 reqwest/ureq/hyper/tokio）；
  源码无 `TcpStream`；测试全部离线。
- **无外部网络**：tauri.conf.json 无远程 devUrl、无 CDN；CSP 禁止外部资源；
  `frontendDist` 指向本地 `../dist`。
- **无凭据**：Rust 宿主与 tauri-entry 无 CredentialStore / keyring / keychain 引用；
  无 `Bearer` / `Authorization` 构造；secret 模式扫描通过。
- **无 shell/fs/http/process/sql**：capabilities 仅 `core:event:default`；
  Cargo 无插件 crate；`lib.rs` 无 `.plugin(` 注册；Rust 源码无 `std::process`、
  `std::env`、`std::fs`。
- **无远程资源**：`dist/` 内所有 JS 导入均为相对路径（构建脚本断言 + 测试双重验证）；
  dist 只含同源产物，不含 src/tests/node_modules/.superpowers。
- **无伪造 Session/Turn/Event**：变异 5 证明伪造成功 Session 会被检出；
  `agent_start_turn` / `agent_cancel_turn` 函数体内无 `text_delta` / `completed` /
  `tool_call` / `usage` 字样；`TURN_EVENT` 仅作为保留常量，宿主从不发布。
- **无错误信息泄露**：`HostError` 仅含静态 `code` + `message`；`errors.rs` 无
  `format!`；命令不回显输入（无 `to_string()`）。
- **不读取环境变量**：Rust 源码无 `std::env` / `env!`；tauri-entry 无 `process.env`。

## 10. 构建验证

所有命令真实执行（2026-09-12，Windows 11 / rustc 1.98.1 / Node 24.14 / pnpm 12.3.4）：

| # | 命令 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `corepack pnpm install --frozen-lockfile` | 0 | Lockfile is up to date |
| 2 | `corepack pnpm verify:layout` | 0 | — |
| 3 | `corepack pnpm typecheck` | 0 | — |
| 4 | `corepack pnpm build:desktop` | 0 | `build:desktop wrote apps/desktop/dist (native ESM + vendor)`；dist 含 index.html / tauri-entry.js / styles.css / vendor/ |
| 5 | `corepack pnpm test tests/task-18-*.test.ts`（3 个文件） | 0 | 79 passed |
| 6 | `corepack pnpm test`（全量） | 0 | 76 files / 1526 tests passed |
| 7 | `corepack pnpm security:scan` | 0 | `security:scan passed (299 files scanned…)` |
| 8 | `corepack pnpm evals:deterministic` | 0 | stage 1 通过（含 Task 18 期望文件）；全部 stage 2 场景通过，含 `task 18 Tauri native shell and host IPC` |
| 9 | `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` | 0 | （先执行 `cargo fmt` 格式化新增代码，随后 --check 通过） |
| 10 | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | 0 | `Finished dev profile` |
| 11 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 0 | `32 passed; 0 failed` |
| 12 | `corepack pnpm exec tauri build --no-bundle`（cwd apps/desktop） | 0 | `Built application at: …\src-tauri\target\release\agent-routebench.exe`（release 1m10s） |
| 13 | `git diff --check` / `git diff --cached --check` | 0 | 无空白错误 |

注：`tauri build --debug --no-bundle`（vitest build 测试内）亦通过；测试内 cargo
调用固定 `CARGO_TARGET_DIR=<repo>/target`。dist 产物验证：`dist/index.html` 以
`<script type="module" src="./tauri-entry.js">` 加载；dist 内无 bare specifier；
不含 node_modules/src/tests/.superpowers。

## 11. Git commit

- 提交信息：`feat(desktop): add Tauri native shell MVP`
- 基线父提交（本提交的 parent）：`9e7ce285baba3dc8f6c8530d26f0a8b3c2502668`
- 提交文件：仅第 4 节清单（显式 `git add --` 逐个暂存，未使用 `git add .` / `-A`）
- `.superpowers/` 未修改、未暂存、未提交；`cc-switch-agent/` 未触碰；
  dist / target / node_modules 未提交（.gitignore 已覆盖）
- 完整 hash 与 `git show --stat` 见提交后输出（最终回复中记录）

## 12. GitHub push

- 命令：`git push -u origin workbench/agent-core`（无 force）
- 结果与远程 HEAD 校验见最终回复（`git ls-remote --heads` 核对）

## 13. 未实现范围

- 完整 Agent Backend 组装（Task 21）
- 真实 Provider 调用与端到端模型验证
- CredentialStore、OS Keychain、secret 持久化
- 工具（shell/file/network）与审批 UI、审批持久化
- 系统托盘、原生文件对话框、菜单
- Windows/macOS/Linux 安装包（`bundle.active: false`）与自动更新
- Node 子进程启动、Local Agent API 后端迁移
- `agent_turn_event` 的真实发布（仅保留契约）

## 14. 环境问题与已知事项

1. **icons/icon.ico**：tauri-build 在 Windows 强制要求（见第 4 节说明），
   属于允许清单外的必要新增。
2. **security:scan 与 Rust 构建产物**：`scripts/security-scan.mjs`（禁止修改）
   递归扫描 `apps/` 下所有文件且 `readFileSync` 不设上限；`src-tauri/target/`
   中的 debug staticlib（agent_routebench_lib.lib，约 700MB）超过 Node 字符串
   上限使扫描崩溃。处理：所有自动化 cargo/tauri 调用固定
   `CARGO_TARGET_DIR=<repo>/target`（git 忽略、不在扫描根）；手工执行裸
   `cargo` 命令前需设置同名环境变量或先 `cargo clean`。已记录于 docs/tauri.md。
3. **变异 6 的检出层级**：敏感字段拒绝由 Rust 单元测试守护（cargo test），
   TypeScript 源码级测试单独运行时不能检出该变异（见第 8 节，如实记录）。
4. **fs.cpSync 崩溃**：本机 Node 24.14 / Windows 组合中 `fs.cpSync` 触发
   0xC0000409 原生崩溃，构建脚本改用纯 `readFileSync/writeFileSync` 复制
   （已注释说明）。
5. 首次 Rust 构建需下载 crates.io 依赖（构建期依赖下载，非运行时网络调用）；
   运行时无任何外部网络访问。
