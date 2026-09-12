# Task 19 验证报告 — Native Host Runtime Boundary and Reproducible Build Hardening

## 1. 基线

- HEAD：`e9c65eb4b8e5924e29fb762922aff08e230fb2a3`（feat(desktop): add Tauri native shell MVP）
- 父提交：`9e7ce285baba3dc8f6c8530d26f0a8b3c2502668`
- 分支：`workbench/agent-core`；工作区仅 `.superpowers/` 未跟踪
- 基线验证：`install --frozen-lockfile`、`verify:layout`、`typecheck`、`test`（1526 通过）全部通过；
  **`security:scan` 在基线即失败**——真实原因：`apps/desktop/src-tauri/target/`（3.5GB，含
  700MB debug staticlib）在 Task 18 期间被一次未设置 `CARGO_TARGET_DIR` 的 cargo 调用重建。
  这是 Task 18 报告已记录的已知问题（临时环境变量约束不持久），正是本任务第二目标要修复的
  缺陷，与本任务改动无关。

## 2. 实现摘要

### HostBackend / HostRuntime

- `apps/desktop/src-tauri/src/backend.rs`：`pub trait HostBackend: Send + Sync`，三个方法
  （`create_session` / `start_turn` / `cancel_turn`）签名统一返回
  `Result<serde_json::Value, HostError>`——错误类型是固定契约，动态异常文本在类型层面
  无法穿越该边界。生产默认实现 `NotReadyBackend` 对三个操作统一返回固定 `host_not_ready`。
- `apps/desktop/src-tauri/src/runtime.rs`：`HostRuntime { backend: Arc<dyn HostBackend> }`，
  `not_ready()` 每次创建全新 `Arc::new(NotReadyBackend)` 实例；`with_backend(Arc)` 为
  显式注入点（生产代码不调用，仅测试与未来组装使用）。无全局状态、无 `static mut`、
  无单例、无 OnceLock/Mutex 共享。
- `lib.rs`：`.manage(HostRuntime::not_ready())` 注册默认运行时；`mod backend; mod runtime;`。
- `commands.rs`：四个 command 名称、参数名、事件名与 Task 18 完全一致。三个后端命令委托
  顺序固定为：校验（`validate_*`）→ `*_checked` helper → `runtime.backend()`。校验失败
  立即返回固定错误，绝不触碰 Backend。`agent_health` 不接收 State、不读取 Backend。
- Backend 结果直接以 `Result<_, HostError>` 穿越——任何实现都无法把原始消息、stack、
  路径、URL 放进错误（变异 5 已证明：尝试把输入回显进消息被编译器 E0521 拒绝）。

### Cargo 构建输出固化

- `.cargo/config.toml`：`[build] target-dir = "target"`（相对路径由 cargo 解析到仓库根，
  已实测：从仓库根、`apps/desktop`、`cargo metadata` 三种调用方式均解析为
  `<repo>/target`）。
- 根 `target/` 已被 `.gitignore` 的 `target/` 规则忽略。
- 不依赖任何 shell 临时环境变量：Task 19 构建测试在删除 `CARGO_TARGET_DIR` 的环境下
  运行全部 cargo/tauri 命令并验证输出位置。
- 已知约束（如实记录）：`tauri-build` 生成的能力/权限元数据在构建脚本之间通过绝对路径
  传递，因此**不得通过移动 target 目录的方式迁移缓存**——本任务执行中发现 Task 18 遗留
  的 `src-tauri/target` 被 `mv` 到根目录后，tauri crate 构建脚本输出中的旧绝对路径导致
  `tauri_build::build()` 报 "failed to read plugin permissions"。已通过
  `cargo clean` + 全量重建修复。今后如需改变 target 位置，必须 clean 后重建，不得移动
  现有缓存。
- `scripts/build-desktop.mjs` 加固：跨进程构建锁（OS 临时目录、基于仓库路径派生、
  带陈旧锁回收）+ staging 目录原子交换（`dist-staging` → `dist`）+ 输入内容指纹
  （SHA-256，覆盖 desktop src/public、tsconfig、vendor 相关 workspace 包源码、
  @tauri-apps/api 运行时文件、构建脚本自身）；指纹未变时无锁快速返回，保证并行 vitest
  钩子不会超时，也保证并发调用永不观察到缺失或半写的 dist。

## 3. 修改文件清单

| 文件 | 职责 |
| --- | --- |
| `.cargo/config.toml` | 仓库级 Cargo 配置，固定 target 输出到根 `target/` |
| `apps/desktop/src-tauri/src/backend.rs` | HostBackend trait + NotReadyBackend + Rust 单元测试 |
| `apps/desktop/src-tauri/src/runtime.rs` | HostRuntime 容器 + Rust 单元测试（含测试专用 TestBackend） |
| `apps/desktop/src-tauri/src/commands.rs` | command 委托重构 + 校验顺序 + Rust 单元测试 |
| `apps/desktop/src-tauri/src/lib.rs` | 注册 HostRuntime state |
| `tests/task-19-native-runtime.test.ts` | 边界结构、注入、隔离、contract（19 测试） |
| `tests/task-19-native-runtime-security.test.ts` | 校验顺序、无伪造、无泄露、安全态势（16 测试） |
| `tests/task-19-native-build.test.ts` | Cargo 配置、构建输出位置、扫描可复现性（8 测试） |
| `scripts/build-desktop.mjs` | 构建锁 + staging 原子交换 + 指纹跳过 |
| `scripts/evals-deterministic.mjs` | Stage 1 增加 Task 19 文件与 target 检查；Stage 2 增加 task 19 场景 |
| `README.md`、`docs/architecture.md`、`docs/desktop.md`、`docs/tauri.md` | Task 19 文档 |
| `docs/verification/task-19-report.md` | 本报告 |

未修改任何禁止文件：Task 1–18 测试、`scripts/security-scan.mjs`、`pnpm-lock.yaml`、
`Cargo.lock`、所有 packages/* 均未改动（`git status` 可验证）。

## 4. TDD 证据

**Red**（实现前，`corepack pnpm test tests/task-19-*.test.ts`，退出码 1）：

```text
Tests  26 failed | 9 passed | 8 skipped (43)
```

代表性失败（均与目标缺口直接相关）：

- `ENOENT ... src-tauri\src\backend.rs`（模块不存在）
- `expected 'mod commands;\nmod errors;…' to contain '.manage(HostRuntime::not_ready())'`
- `expected 'fn agent_create_session() -> Result<V…' to contain 'create_session_checked'`
- `expected -1 to be greater than 102`（校验在委托之前的顺序断言）
- build 文件：beforeAll 在读取 `.cargo/config.toml` 时 ENOENT → 8 个测试全部跳过

**Green**（实现后）：

- `tests/task-19-native-runtime.test.ts` + `security`：35 passed
- `tests/task-19-native-build.test.ts`：8 passed（含真实 cargo check/test、tauri release
  build、scan，全部在删除 `CARGO_TARGET_DIR` 的环境下执行）
- 全量：79 文件 / 1569 测试全部通过（基线 1526 + Task 19 新增 43）

## 5. 受控变异（10 项，全部真实执行并恢复）

| # | 变异 | 检出 | 证据 |
| --- | --- | --- | --- |
| 1 | `agent_start_turn` 改名 `agent_start_turn_renamed`（fn + lib 注册） | ✓ exit 1 | `the four command names are completely unchanged`、`command parameter names are unchanged` |
| 2 | 校验移到 Backend 调用之后 | ✓ exit 1（TS）+ 101（cargo） | `agent_start_turn validates the payload before delegating`；cargo：3 个 `*_before_the_backend` 测试 FAILED |
| 3 | NotReadyBackend 伪造成功 Session | ✓ exit 1（TS）+ 101（cargo） | `NotReadyBackend fails all three operations…`；cargo：3 个 not_ready 测试 FAILED |
| 4 | 禁用敏感字段拒绝（`if false && FORBIDDEN_FIELDS`） | ✓ 101（cargo） | `start_turn_rejects_forbidden_fields_before_the_backend`、`rejects_every_forbidden_field` FAILED（45 passed / 2 failed）；如实记录：仅 TS 测试不检出 |
| 5 | 将 turn id 回显进错误消息 | ✓ 编译期拒绝（exit 101，E0521） | `HostError::new` 仅接受 `&'static str`，动态内容在类型层面不可表示——比测试检出更强的保证 |
| 6 | 注入 `static mut GLOBAL_BACKEND` 全局可变后端 | ✓ exit 1 | `no global mutable backend state exists in the Rust host` |
| 7 | 删除 target-dir 配置 | ✓ exit 1 | beforeAll 断言 `.cargo/config.toml must pin target-dir = "target"`，8 测试跳过 |
| 8 | target-dir 改回 `apps/desktop/src-tauri/target` | ✓ exit 1 | 同上断言 |
| 9 | agent_health 注入 State 并读取 backend | ✓ exit 1 | `agent_health stays decoupled from the backend` |
| 10 | capabilities 加入 `shell:allow-execute` | ✓ exit 1 | `capabilities stay minimal for the main window` |

恢复方式全部为变异前文件副本原位还原（未使用 `git checkout --`）；恢复后相关测试复验
绿色；`grep -R "MUTATION|GLOBAL_BACKEND|session-fabricated|agent_start_turn_renamed|
shell:allow-execute|false && FORBIDDEN" apps/desktop/src-tauri .cargo` 无残留。

## 6. 完整验证命令与退出码

| # | 命令 | 退出码 | 备注 |
| --- | --- | --- | --- |
| 1 | `corepack pnpm install --frozen-lockfile` | 0 | |
| 2 | `corepack pnpm verify:layout` | 0 | |
| 3 | `corepack pnpm typecheck` | 0 | |
| 4 | `corepack pnpm build:desktop` | 0 | 冷 3.0s / 热跳过 0.7s |
| 5 | `corepack pnpm test tests/task-19-*.test.ts` | 0 | 43 passed |
| 6 | `corepack pnpm test` | 0 | 79 文件 / 1569 测试 |
| 7 | `corepack pnpm security:scan` | 0 | 306 files scanned |
| 8 | `corepack pnpm evals:deterministic` | 0 | stage 1（含 cargo target 检查）+ 17 个 stage 2 场景 |
| 9 | `cargo fmt -- --check` | 0 | |
| 10 | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | 0 | 无 `CARGO_TARGET_DIR` |
| 11 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 0 | 47 passed |
| 12 | `corepack pnpm exec tauri build --no-bundle`（cwd=apps/desktop，无 env） | 0 | 输出 `<repo>/target/release/agent-routebench.exe` |
| 13 | `corepack pnpm security:scan`（构建产物存在状态下再次执行） | 0 | 未读取任何 `src-tauri/target` 产物 |
| 14 | `git diff --check` / `git diff --cached --check` | 0 | |

构建输出位置验证：`cargo metadata`（从仓库根与 apps/desktop 两种 CWD）均报告
`target_directory = <repo>/target`；`apps/desktop/src-tauri/target` 在全部构建后仍不存在。

## 7. Rust 测试数量

47 个（Task 18 基线 32 + Task 19 新增 15：backend 5、runtime 6、commands 委托/顺序 14
中新增部分）。

## 8. 安全边界确认

- 无真实 Agent Backend、无真实 Provider、无真实模型调用、无 CredentialStore/Keychain 读取
- 无 Local Agent API Server 启动、无 Node 子进程、无 shell/file/network 工具
- Rust 运行时无 `std::net` / `reqwest` / `ureq` / `std::process` / `std::env` / `std::fs`
- 无真实 `agent_turn_event` 发布（常量保留，从不 emit）
- capabilities 仍仅 `core:event:default`（main 窗口）；CSP 未放宽；无远程 devUrl
- 未访问真实网络；未读取真实凭据；`agent_health` 与 Backend 完全解耦
- `.superpowers/` 未读取、未修改、未暂存、未提交

## 9. 未实现范围（Task 20/21 均未开始）

真实 Agent Backend 组装、Provider Registry 接入、CredentialStore、真实模型调用、
Local Agent API 后端迁移、Node 子进程、安装包、系统托盘、文件对话框、自动更新、
真实事件流发布。

## 10. 已知问题

1. **基线 security:scan 失败**（Task 18 遗留构建产物）：`apps/desktop/src-tauri/target`
   在 Task 18 与 Task 19 之间被一次裸 cargo 调用重建。本任务通过 `.cargo/config.toml`
   固化输出位置解决；遗留目录已移除，且全量重建后不再出现（含 evals stage 1 断言守护）。
2. **target 缓存不可迁移**：tauri 构建脚本元数据含绝对路径，移动 target 目录会产生
   "failed to read plugin permissions" 失败；必须 `cargo clean` 后重建。本任务执行中
   实际遇到并已修复（重建后所有命令通过）。
3. **变异 4 的检出层级**：敏感字段拒绝由 Rust 单元测试守护；仅运行 TS 文件不检出
   （与 Task 18 变异 6 同一结论，如实记录）。
4. Task 19 build 测试的 beforeAll 在 `.cargo/config.toml` 缺失时抛出并跳过全部 8 个
   测试——这是对配置缺失的诚实报告方式（Red 阶段即如此表现）。
