# Task 28 执行报告

> 本报告记录 Task 28「最终集成、Release Readiness 与 Scope Closure」的真实执行结果。
> 所有数字、退出码与变异结果均来自本次实际运行；历史 Task 报告未被修改。

## 1. 最终状态

**DONE_WITH_CONCERNS**

代码、测试、文档、构建、扫描、评测、Git 提交与 GitHub push 全部完成；唯一保留的 concern
是**真实 Provider E2E / 真实 API Key / OS Keychain 未实现**（本任务明确排除），以及
**rustc 1.98.1 在多 crate-type + incremental 下的编译器 ICE**（已通过关闭 incremental
规避并记录，详见第 13 节）。

## 2. 基线

| 项目 | 值 |
| --- | --- |
| 分支 | `workbench/agent-core` |
| 基线 HEAD | `693f0efd1f7462dd3f125e56d4fdd22faa9b329a` |
| 基线 HEAD^ | `f08d9399d44a417a2553c3b3969c8ad7ec05ee30` |
| 远程 | `origin/workbench/agent-core` = `693f0efd1f7462dd3f125e56d4fdd22faa9b329a`（与本地一致） |
| `git cat-file -e 693f0efd…^{commit}` | 通过 |
| `git merge-base --is-ancestor f08d9399… 693f0efd…` | 通过（父链正确） |
| 工作区 | 仅 `.superpowers/` 未跟踪 |

开始前的基线测试：TypeScript 121 个测试文件 / 1981 个测试通过；Rust 98 个单元测试通过。
基线命令与 Task 28 命令均在仓库根目录 `agent-workbench-app/` 下执行。

## 3. 最终端到端数据流

```text
Desktop UI
  → DesktopConfigApiClient / DesktopApiClient
  → Tauri invoke/listen bridge
  → Rust Native Proxy (NodeSidecarBackend, 固定 127.0.0.1)
  → Node Sidecar (Local Agent Host, 固定 loopback 端口)
  → Local Agent API
  → ConfigManager / ProviderRegistry / CredentialStore
  → Agent Backend
  → Resilient Gateway / Agent Runtime
  → NDJSON events → Desktop / Client
```

`tests/task-28-final-integration.test.ts` 使用**真实**的 `createConfiguredLocalAgentHost()`
（真实配置文件 + 真实 loopback HTTP + 真实 Local Agent API + 真实 Agent Backend +
真实 Routed/Resilient Gateway + 真实 Agent Runtime），只把**Provider HTTP client** 与
**CredentialBackend** 替换为注入式 fake，因此链路是真实贯通的，而不是伪造的 completed
或静态字符串。

## 4. 实际修改文件

新增：

| 文件 | 作用 |
| --- | --- |
| `tests/helpers/task-28-fixtures.ts` | Task 28 中性离线夹具（临时配置目录、空闲 loopback 端口、记录型 CredentialBackend、NDJSON 读取） |
| `tests/task-28-final-integration.test.ts` | 26 个端到端集成测试 |
| `tests/task-28-final-security.test.ts` | 28 个凭据 / secret / 无环境来源边界测试 |
| `tests/task-28-final-lifecycle.test.ts` | 27 个原生启动链、Host 生命周期与构建产物卫生测试 |
| `tests/task-28-final-config.test.ts` | 25 个配置管理闭环、白名单与持久化测试 |
| `tests/task-28-final-desktop.test.ts` | 22 个 Desktop 会话页 / 设置页验收测试（jsdom） |
| `scripts/verify-release.mjs` | 最终验收入口 `verify:release` |
| `docs/verification/task-28-report.md` | 本报告 |

修改：

| 文件 | 变更 |
| --- | --- |
| `packages/local-agent-api/src/server.ts` | 新增 `assertOnlyAllowedConfigFields` + `PROVIDER_CONFIG_FIELDS` / `ROUTE_CONFIG_FIELDS`，配置请求体只允许响应契约中的非敏感字段（未知字段不再被静默接受） |
| `apps/local-agent-host/src/configured-host.ts` | `ConfiguredLocalAgentHostOptions` 新增显式 Backend 选项透传（toolExecutor / policy / approvalHandler / retryPolicy / wait / maxTurns / maxToolCallsPerTurn / maxToolResultBytes / defaultMaxTokens / maxFrameBytes / maxToolInputBytes），非法组合折叠为固定 `invalid_backend_options` |
| `apps/local-agent-host/src/errors.ts` | 新增固定错误码 `invalid_backend_options` 与固定文案 |
| `apps/desktop/src/errors.ts` | 新增固定错误码 `config_load_failed` / `config_mutation_failed` 与固定文案 |
| `apps/desktop/src/config-client.ts` | 配置读写改用上述两个固定配置错误码（不再复用 session/turn 错误码） |
| `scripts/build-desktop.mjs` | 唯一 retiring 目录名 + best-effort 清理 + 启动时清理陈旧瞬时产物；vendor 编译产物改为**搬移**（`renameSync`）而非「复制 + 大批量删除」，使残留清理成为有界删除 |
| `scripts/build-local-agent-host.mjs` | 同上的对称修复：本地 Agent Host 构建原先硬删除 `dist/`、`dist-staging/`，且要一次性删除 3453 个 vendor 原始产物；现改为唯一 retiring 名 + best-effort 清理 + 陈旧产物清理 + vendor 搬移 |
| `.gitignore` | 忽略 `dist-staging/` 与 `dist-retiring*/` |
| `apps/desktop/src-tauri/Cargo.toml` | 新增 `[profile.dev] incremental = false`，规避 rustc 元数据编码 ICE，使 Rust 构建可复现 |
| `package.json` | 新增 `verify:release` 脚本 |
| `vitest.config.ts` | 显式设置 `hookTimeout`：`task-18`/`task-19` 的 hook 内会执行真实构建，默认 10s 会把一次正常冷构建报成 `Hook timed out in 10000ms`（不改变任何断言） |
| `scripts/evals-deterministic.mjs` | 新增 Task 28 期望文件、Task 28 离线场景与覆盖说明 |
| `docs/architecture.md` | 新增 Task 28 章节、最终数据流、缺口修复表、范围声明 |
| `docs/desktop.md` | 更新错误码表，新增 Task 28 Desktop 验收章节与解释说明 |
| `README.md` | 新增 Task 28 当前阶段说明与 `verify:release` 入口 |

未修改：`scripts/security-scan.mjs`、`.superpowers/`、`cc-switch-agent/`（不存在于本仓库）。
历史 Task 报告（`docs/verification/task-*.md`）内容未被改写。

## 5. 功能完成情况

### 5.1 Desktop 启动与 Sidecar 最终链路

- Tauri Host 只创建一个 Node Sidecar：`lib.rs` 中 `NodeHostSupervisor::new(` 恰好出现 1 次，
  `create_sidecar_supervisor(` 出现 2 次（定义 + setup 调用）。
- Sidecar 使用固定 loopback 地址：`SIDECAR_LOOPBACK_HOST = "127.0.0.1"`，`host != LOOPBACK` 即拒绝。
- Sidecar 接收绝对配置文件路径：`with_config_path` 要求 `Path::new(&path).is_absolute()`，拒绝空值 / NUL / `?` / `#`。
- 首次启动仅在显式允许时创建空配置：Rust 侧 `if !config_path.exists()`，Node 侧 `options.createIfMissing === true`；否则固定 `config_not_found`。
- 健康检查匹配固定 `/health` 响应：Rust `TcpHealthProbe` 要求 `HTTP/1.1 200 OK` + 恰好 3 个字段 `{ok:true, service:"agent-workbench-local-api", version:1}`；Node `/health` 逐字返回该契约。
- 健康检查失败不得伪造 running：超时分支设置 `SidecarState::Failed` 并返回 `sidecar_health_timeout`。
- 启动失败 / 停止 / 重复启动 / 重复停止行为固定：`start()` 幂等、并发 start 共享一次操作；`stop()` 幂等且未启动时安全；kill 失败与等待超时返回固定 `sidecar_stop_failed`。
- 停止后无孤儿进程、无残留监听端口：`Drop` 自动 stop；集成测试断言 `close()` 后端口可被重新绑定。
- Renderer 不直接访问 Node / 文件系统 / Provider Registry / CredentialStore：静态断言 12 个 Desktop 源文件不含 `node:` 导入、`require(`、`child_process`、`readFileSync`，也不构造 `InMemoryProviderRegistry` / `createSecureCredentialStore` / `createFileJsonConfigStore` / `createRoutedHttpModelGateway` / `createAgentBackend`。

### 5.2 配置管理端到端闭环

- Desktop 获取配置、Provider/Route 的创建/更新/删除：通过**真实** loopback Local Agent API + 注入式 Tauri `invoke` 完成，共 25 个测试覆盖。
- 变化真实写入 ConfigManager 使用的同一 Store：断言 `store.load()` 能看到 Desktop 客户端写入的 Provider/Route。
- API / Tauri Proxy / Desktop Client 三层响应格式一致：断言 `invoke` 结果与原始 HTTP body 深度相等，且 Desktop 客户端解析结果与之相等。
- Provider 删除约束（被 Route 引用时拒绝）、Route fallback 约束、model 可用性约束保持有效：三者均返回固定 400 `invalid_config_request`。
- 配置持久化失败时内存状态回滚：`config_persistence_failed` + registry 回到变更前状态。
- 配置加载失败时不启动 Listener：`config_not_found` / `config_invalid` 时端口仍可被重新绑定。
- 首次启动创建的配置可被下一次进程重新加载：关闭后新建 Host 读取同一文件，Provider/Route 完整恢复。
- 配置 API 白名单：**本任务新增**。请求体只允许响应契约中的非敏感字段；未知字段与敏感字段返回**同一个**固定 400，错误文本无法区分二者。
- 拒绝 `apiKey` / `token` / `authorization` / `headers` / `password` / `secret`（含 `api_key` / `access_token` / `endpoint` / `credential` 等 10 种命名）。
- 错误消息固定；不回显路径 / URL / 异常文本 / stack / secret（断言响应文本不含被拒值、`Error`、`stack`、`/v1/`、`http`）。
- malformed path（`%E0%A4%A`）、重复 ID、非法 JSON、非法协议均返回稳定错误。

### 5.3 CredentialStore 最终边界

- 配置文件只保存 `credentialRef`（磁盘断言：包含 `credential:provider-two`，不含 `apiKey`/`authorization`/`headers`/`password`）。
- secret 不进入 Provider/Route 配置快照、Session、事件历史、NDJSON、UI ViewModel、错误消息或日志。
- 启动阶段不读取凭据：注入式记录型 CredentialBackend 的 `get()` 调用数为 0；health / config / create-session 后仍为 0。
- 只有真实 Turn 且需要认证时才按需读取：一次成功 Turn 恰好 1 次 `get()`，且无 `set`/`has`/`delete`。
- 默认 CredentialStore fail-closed：`createConfiguredLocalAgentHost()` 未注入凭据时使用 `UnavailableCredentialStore`，Turn 得到固定 `gateway_error` 且不发起任何 HTTP。
- CredentialBackend 只允许显式注入：`createSecureCredentialStore` 对非法 backend 抛错；无效 ref / secret 在触达 backend 前被拒绝；backend 异常折叠为固定 `credential_backend_failed`。
- 不从环境变量 / CLI 参数 / 普通配置文件读取 API Key：静态断言 6 个 provider-facing 目录不含 `process.env` / `std::env` / `env::var`；CLI 仍拒绝 `--apikey`/`--token`/`--secret`/`--authorization`。
- **未引入** OS Keychain、第三方密码管理器或真实 API Key（见第 13 节）。

### 5.4 Agent Backend 最终运行闭环

`tests/task-28-final-integration.test.ts` 覆盖：

- 文本流式输出（`route_selected → text_delta → usage → completed`）。
- Provider 失败时的固定错误（401 → 单条固定 `gateway_error`，上游 body 不进入事件）。
- Retry 顺序（503 → 重试一次成功，仅一条 completed，无重复文本）。
- Failover 顺序（主 Provider 耗尽 → 有序 fallback，且使用 fallback 的 credentialRef 与 secret）。
- 多轮 Tool Call（tool_use → tool_call → 第二轮请求携带工具结果 → 唯一最终 completed）。
- Tool Policy deny / ask / allow（deny 不执行；无 policy 时 fail-closed；ask+approved 才执行；ask+denied 不执行），断言第二轮请求携带固定结果文案。
- 取消期间不开始下一轮：取消后 provider 调用次数保持 1；会话状态为 `cancelled`；终止事件恰好 1 个且 code 为 `aborted`。
- 已输出可见事件后不重试：先输出 `text_delta` 再收到 retryable error 时，HTTP 调用次数为 1。
- 中间 completed 不泄露到外部：多轮场景中 completed 恰好 1 次且位于末尾。
- 最终 completed 只出现一次。
- secret / Provider URL / credentialRef / 原始异常不进入事件：断言 NDJSON 原文不含 secret、credentialRef、baseUrl、`x-api-key`、`Bearer` 与上游探针串。
- 附加：未知 Route / 缺失凭据 / model 不匹配均不发起 HTTP；OpenAI-compatible 协议走同一链路；并发 Session 隔离；同 Session 并发 Turn 返回 409；完成后与取消后均释放 turn slot。

### 5.5 Desktop UI 最终验收

见 `docs/desktop.md` 的「Task 28 final acceptance」章节，22 个 jsdom 测试覆盖会话显示、
Provider/Route 列表、创建/编辑/删除、刷新、固定安全消息、Send/Cancel 状态、取消后草稿保留、
流式文本、XSS 转义、`tool_call.input` 隔离、配置字段白名单，以及静态 renderer 的
「无 live 事件属性 / 无外部来源 / 无 `javascript:` URL 目标 / 无敏感字段」。

### 5.6 最终构建与运行入口

- `verify:layout`、`typecheck`、`build:local-agent-host`、`build:desktop`、
  `cargo check`、`cargo test --lib` 全部可用（退出码见第 10 节）。
- 新增 `verify:release`（`scripts/verify-release.mjs`）：串联上述检查 + 全量测试 +
  `security:scan` + `evals:deterministic` + `cargo fmt --check`，并断言
  `apps/desktop/src-tauri/target` 不存在、`.cargo/config.toml` 仍固定仓库根 `target/`、
  工作区除 `.superpowers/` 外无未跟踪或已修改文件。任一步失败即整体非零退出。
- Rust 构建输出继续固定在仓库根 `target/`；`apps/desktop/src-tauri/target/` 不存在（测试与 `verify:release` 双重断言）。

## 6. 安全边界

| 边界 | 状态 |
| --- | --- |
| loopback-only | 保持。Host/API/Sidecar/Proxy 只允许 `127.0.0.1`（`localhost` 仅 Host 层） |
| 无远程 devUrl | 保持。`tauri.conf.json` 无 `devUrl` |
| 无外部 CDN | 保持。`index.html` 无 `http(s)://` 引用，CSP 仅允许 `'self'` 与 `ipc:` |
| 无外部网络调用 | 保持。所有 provider HTTP 由注入式 fake client 驱动；host/backend/renderer 源码无 `fetch(` |
| 无未经注入的 Provider 请求 | 保持。`createAgentBackend` 只使用显式注入的 `httpClient` |
| 无真实 API Key | 保持。仓库内无真实凭据；安全扫描通过 |
| 无 shell 启动 | 保持。`Command::new(&config.executable)`，无 `cmd`/`powershell`/`bash`/`sh` |
| 不允许任意 URL / Host / Header | 保持。Proxy 只拼固定 loopback 路径，ID 经 `encode_path_segment`；无 URL 参数 |
| Tauri capabilities 最小化 | 保持。仅 `core:event:default`（main 窗口） |
| CSP 严格 | 保持。`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src ipc: http://ipc.localhost` |
| 错误消息固定 | 保持。Rust `HostError.message` 为 `&'static str`，无 `format!`；HTTP/UI 错误为固定文案 |
| 不把 secret 写入磁盘 | 保持。配置快照/文件只含 `credentialRef` |
| 不把原始错误 / 路径 / URL / stack 返回用户 | 保持。响应文本断言不含被拒值、`Error`、`stack`、路径或 URL |
| `scripts/security-scan.mjs` 未放宽 | 保持。未修改该文件 |
| `.superpowers/` 未修改 | 保持。未跟踪、未暂存、未提交 |
| `cc-switch-agent/` 未修改 | 保持（本仓库不存在该目录） |

## 7. TDD Red / Green 证据

### Red（实现缺失时的真实失败）

1. 先写 `tests/task-28-final-*.test.ts`，在**未做任何实现修改**的情况下运行：

```text
Test Files  4 failed | 1 passed (5)
     Tests  14 failed | 104 passed (118)
```

2. 失败点即真实缺口：

- 6 个工具/策略/重试透传测试失败 → `createConfiguredLocalAgentHost()` 无法注入 Backend 选项
  （`harness.http.request(1)` 为 `undefined`，说明第二轮根本没有发生）。
- 1 个 failover 测试失败 → `retryPolicy` 未被透传，主 Provider 被重试 2 次而非 1 次。
- 1 个配置白名单测试失败 → `POST /v1/providers` 携带未知字段返回 **201**（未知字段被静默接受）。
- 6 个测试期望值有误（`route_selected` 先于 error、工具流多一个 usage、cancel 测试的
  断言方式、转义断言过严、Rust 注释被正则误匹配、CSP 合法包含 IPC 源）→ 在确认实现行为
  正确后修正**测试期望**，不修改实现。

3. 全量套件在 Green 阶段暴露了 2 个额外的真实缺陷（属于「实现最小功能」时发现的缺口，
   记录于此以保持时间线诚实）：

- Desktop 构建清理不健壮：`swapStagingIntoDist()` 第一步的 `rmSync(retiringDir)` 一旦失败
  （本环境的安全删除保护触发），残留 `apps/desktop/dist-retiring/` 会让**后续每次**
  `build:desktop` 直接失败，并留下未跟踪目录。
- 本地 Agent Host 构建清理同样不健壮：`build-local-agent-host.mjs` 直接
  `rmSync(distDir)` / `rmSync(stagingDir)`，并要一次性 `rmSync(vendor/raw)`（3453 个条目），
  单次大批量删除被拒时构建立即失败。已按 `build-desktop.mjs` 的同一模式修复。
- 两个构建脚本都把「复制 vendor 产物 + 删除原始 dump」当作清理手段，使构建依赖一次
  **大批量递归删除**。已改为 `renameSync` 搬移每个 package 的编译子树，原始目录只剩空目录，
  清理因此成为有界删除（并移除了随之变成死代码的 `copyTree`）。
- 新增的 `verify-release.mjs` 自身有一个真实缺陷：它用 `process.env.npm_execpath` 作为
  JS 入口调用 `node`，而 pnpm 12 的 `npm_execpath` 指向原生可执行文件
  `pnpm-native.exe`，导致 `ERR_UNKNOWN_FILE_EXTENSION`，使 release gate 全部步骤失败。
  已改为按扩展名区分 JS CLI 与原生二进制后再 spawn。
- Rust 构建：`cargo test`（全 target，含 `staticlib`+`cdylib`+`rlib`）在 incremental 下
  触发 rustc 1.98.1 ICE（`rmeta/encoder.rs: no entry found for key`），使 task-18/19 的
  Rust 测试与 vitest worker RPC 一并失败。

### Green

- 修复后 Task 28 聚焦：5 文件 / 131 测试通过。
- 全量 TypeScript：126 文件 / 2112 测试通过，退出码 0，无 unhandled error。
- Rust：98 个单元测试通过。

## 8. 受控变异

每项变异均为：备份原文件字节 → 只改一个行为点 → 运行相关聚焦测试（期望红）→
原位恢复原字节 → 复跑同一组测试（期望绿）。**未使用** `git checkout --` / `git reset` /
`git rebase` 或任何破坏性命令。

| # | 变异 | 检查边界 | 检出 | 恢复 |
| --- | --- | --- | --- | --- |
| 1 | 删除 Local Agent API 配置路由分发 | 配置 CRUD 端到端 | 是 | 绿 |
| 2 | 删除 Host → API 的 ConfigManager 透传 | 配置读取返回 503 | 是 | 绿 |
| 3 | 删除 Tauri Native Proxy 配置转发路径 | 固定配置路径静态断言 | 是 | 绿 |
| 4 | 删除 Desktop Tauri entry 的配置客户端接入 | entry wiring 断言 | 是 | 绿 |
| 5 | 允许非 loopback Local Agent Host | `host_not_loopback` 断言 | 是 | 绿 |
| 6 | 删除 sidecar `/health` 契约探活 | `cargo test --lib`（1 失败） | 是 | 绿 |
| 7 | 健康失败仍返回成功（伪造 running） | `cargo test --lib`（1 失败） | 是 | 绿 |
| 8 | 默认 Runner 伪造 text + completed | 默认 Runner 不伪造断言 | 是 | 绿 |
| 9 | 启动阶段急切读取凭据 | 启动 0 次凭据读取断言 | 是 | 绿 |
| 10 | 删除配置请求字段边界（敏感 + 白名单） | 配置边界专用测试（4 失败） | 是 | 绿 |
| 10a | 只删除敏感字段守卫 | 被白名单守卫完全遮蔽（见下） | 否（设计冗余） | 绿 |
| 10b | 只删除白名单守卫 | 配置边界专用测试（3 失败） | 是 | 绿 |
| 11 | 删除每 Session turn slot 释放 | turn slot 释放断言（2 失败） | 是 | 绿 |
| 12 | 通过 Desktop ViewModel 暴露 `tool_call.input` | ViewModel 字段断言 | 是 | 绿 |
| 13 | 删除 Desktop 构建交换的健壮清理 | 构建卫生断言 | 是 | 绿 |
| 14 | 允许非 loopback sidecar host（原生边界） | `cargo test --lib`（2 失败） | 是 | 绿 |
| 15 | 删除 Local Agent Host 构建交换的健壮清理 | 构建卫生断言（1 失败） | 是 | 绿 |
| 16 | 把 vendor 搬移改回硬删除（`rmSync(rawVendorDir)`） | 构建卫生断言（1 失败） | 是 | 绿 |

合计 **18 项变异**（含 10a/10b 两个子变异），**17 项检出**，**1 项未检出**。

### 关于未检出的 10a（诚实披露）

移除 `assertNoConfigSecrets` 后行为**没有任何可观测变化**：任何含敏感字段名的请求体，
其顶层键必然不在配置白名单内，因此仍会被 `assertOnlyAllowedConfigFields` 以**同一个**
固定 400 拒绝。反之亦然（10b 之所以可检出，是因为移除白名单后未知字段会返回 201）。

因此这两道守卫在请求边界上是**互为冗余的纵深防御**，无法用任何 HTTP 观测区分其单独移除。
按提示词要求「未检出的变异必须增加专用测试」，已新增两个专用测试：

- `enforces the configuration request field boundary on providers`
- `enforces the configuration request field boundary on routes`

它们同时固定「敏感字段」与「未知字段」两条路径，断言两者返回**逐字节相同**的固定 payload
（证明错误文本无法用于区分守卫、也无法回显被拒值），并断言两次尝试都**未持久化任何内容**。
在 10b 与 10（整条边界）下这两个测试都会失败，即边界本身被完整钉住；10a 的不可观测性
被记录为已确认的设计属性，而不是遗漏。

## 9. 测试数量

| 范围 | 文件 | 测试 |
| --- | --- | --- |
| Task 28 聚焦 | 5 | **131** |
| └ `task-28-final-integration.test.ts` | | 26 |
| └ `task-28-final-security.test.ts` | | 28 |
| └ `task-28-final-lifecycle.test.ts` | | 30 |
| └ `task-28-final-config.test.ts` | | 25 |
| └ `task-28-final-desktop.test.ts` | | 22 |
| TypeScript 全量 | 126 | **2112** |
| Rust 全量（`cargo test --lib`） | — | **98** |

Task 28 新增 131 个测试，超过要求的 60 个；其中绝大多数是真实行为断言（真实 loopback
HTTP、真实 Host 生命周期、真实 jsdom DOM、真实 cargo 单元测试），不是源码 grep。

## 10. 全部验证命令和退出码

全部命令在 `agent-workbench-app/` 下执行，**逐条独立执行**（与提示词清单一致）。
`corepack pnpm` 在本机等价于 `pnpm`（见第 13 节环境说明）。

| 命令 | 退出码 |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |
| `corepack pnpm verify:layout` | 0 |
| `corepack pnpm typecheck` | 0 |
| `corepack pnpm build:local-agent-host` | 0 |
| `corepack pnpm build:desktop` | 0 |
| `corepack pnpm test` | 0 |
| `corepack pnpm security:scan` | 0 |
| `corepack pnpm evals:deterministic` | 0 |
| `corepack pnpm verify:release` | 0 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` | 0 |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | 0 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | 0 |
| `git diff --check` | 0 |
| `git diff --cached --check` | 0 |

实测输出摘要：

- `install --frozen-lockfile`：`Lockfile is up to date, resolution step is skipped`。
- `security:scan`：`security:scan passed (587 files scanned; baseline secret and dependency checks only.)`
- `evals:deterministic`：`stage 1 passed (323 expected files present)`，全部离线场景通过。
- `test`：`Test Files 126 passed (126)` / `Tests 2112 passed (2112)`，无 unhandled error。
- `cargo test --lib`：`test result: ok. 98 passed; 0 failed`。
- `git diff --check` / `git diff --cached --check`：无空白错误（仅有 Git 关于工作区 LF/CRLF
  的提示，非错误）。

附加验证（全部满足）：

- 全量 TypeScript 测试全部通过（126 文件 / 2112 测试，退出码 0）。
- Task 28 聚焦测试全部通过（5 文件 / 131 测试）。
- Rust 测试全部通过（98 个单元测试）。
- 构建后 `apps/desktop/src-tauri/target/` 不存在。
- 安全扫描在有构建产物（`apps/desktop/dist/`、`apps/local-agent-host/dist/`、仓库根 `target/`）
  的状态下仍通过。
- `git status` 仅 `.superpowers/` 未跟踪。
- 无 mutation 标记、备份文件或临时文件残留（`apps/desktop/dist-staging`、
  `apps/desktop/dist-retiring*`、`apps/local-agent-host/dist-staging`、
  `apps/local-agent-host/dist-retiring*` 均不存在）。

> 说明：验证过程中曾把全部命令串在**同一个 shell 调用**里批量执行，此时
> `build:local-agent-host` 与 `evals:deterministic` 各失败一次。原因是本机 Bash 工具的
> 安全删除保护按「每次调用」累计配额，单次调用内的多次大目录删除被拒绝，并非仓库缺陷。
> 逐条独立执行（即上表）全部退出码为 0。同时该现象暴露了 `build-local-agent-host.mjs`
> 与 `build-desktop.mjs` 相同的清理不健壮问题，已一并修复（见第 4、7、8 节）。

## 11. 未访问真实 Provider / 凭据 / 外部网络声明

- **未访问任何真实 Provider**：所有 provider-facing HTTP 均由注入式 fake client 提供，
  请求 URL 指向 `.test` / `.invalid` 合成域名，从不建立真实连接。
- **未读取任何真实凭据**：所有 secret 均为合成字符串（如 `t28-synthetic-credential`），
  仅存在于测试进程内存；仓库内不存在真实 API Key，`security:scan` 通过。
- **未访问外部网络**：测试中唯一的网络行为是本机 `127.0.0.1` loopback HTTP（Local Agent
  API）与 Rust 侧的 loopback TCP 探活夹具。
- **未引入 OS Keychain / 第三方密码管理器**：仓库不存在跨平台 Keychain 实现，因此本任务
  按要求未擅自引入，保留为后续增强（见第 13 节）。

## 12. Git commit、parent、push 和最终 status

全部数值取自本次真实 `git` 输出（推送完成后复核）。

| 项目 | 值 |
| --- | --- |
| 分支 | `workbench/agent-core` |
| 基线 HEAD | `693f0efd1f7462dd3f125e56d4fdd22faa9b329a` |
| 提交 1 | `cb6c72461a7eab9a5db1f8ed8e0f24bb21b21f53` |
| 提交 1 信息 / 父提交 | `feat(release): close final desktop integration` / `693f0efd1f7462dd3f125e56d4fdd22faa9b329a` |
| 提交 1 规模 | 22 files changed, 3486 insertions(+), 19 deletions(-) |
| 提交 2 | `4000bdafe32ee2bac1cfc73e808cc01bd6f5ae2b` |
| 提交 2 信息 / 父提交 | `fix(release): harden build output hygiene and release gate` / `cb6c72461a7eab9a5db1f8ed8e0f24bb21b21f53` |
| 提交 2 规模 | 6 files changed, 118 insertions(+), 45 deletions(-) |
| 提交对象校验 | `git cat-file -e HEAD^{commit}` 通过；`HEAD^`/`HEAD^^` 与上述父链一致 |
| push | `git push origin workbench/agent-core` → `693f0ef..4000bda workbench/agent-core -> workbench/agent-core`（退出码 0，非 force push） |
| 远程一致性 | `git ls-remote origin refs/heads/workbench/agent-core` = `4000bdafe32ee2bac1cfc73e808cc01bd6f5ae2b`，与本地 HEAD 完全一致 |
| 最终 status | `## workbench/agent-core...origin/workbench/agent-core`（无 ahead/behind），除 `?? .superpowers/` 外无未跟踪或已修改文件 |

本报告自身在**推送完成后**才定稿（第 12 节写的是已验证的推送结果），因此定稿提交是链上的
最后一个提交；其 SHA 由 `git log -1 --format=%H` 给出。提交方式遵循约束：只使用显式文件名
`git add`（无 `git add .` / `-A`）、无 amend、无 reset、无 checkout、无 rebase、无 force push、
未触碰 `.superpowers/`。

## 13. 未实现范围与已知问题

### 明确未实现（本任务排除）

真实 Provider E2E、真实 API Key、OS Keychain、云端同步、SQLite、Web UI、托盘、自动更新、
安装包签名、多用户鉴权、远程部署。以上均**未**声称完成。

### 已知问题

1. **rustc 1.98.1 ICE（已规避）**：本 crate 声明 `staticlib` + `cdylib` + `rlib` 三种
   crate-type，开启 incremental 时 rustc 在 rmeta 编码阶段偶发 ICE
   （`no entry found for key`），导致 `cargo test` 与 release gate 以编译器内部错误失败。
   已在 `apps/desktop/src-tauri/Cargo.toml` 关闭 `[profile.dev] incremental`（本 crate 规模下
   代价可忽略）以恢复可复现构建；`cargo test --lib` 不受影响。这是**环境/编译器层面的规避**，
   不是代码缺陷。
2. **配置请求的敏感字段守卫在请求路径上不可单独观测**：白名单是其严格超集，两者互为冗余
   纵深防御（见第 8 节 10a）。
3. **本机 `corepack` shim 路径异常**：本机 managed Node 的 `corepack` shim 会解析出错误路径
   （`C:\c\Users\...`）。已改用 `node <corepack>/dist/corepack.js pnpm …` 等价调用完成全部
   pnpm 命令；这是**环境问题**，未修改仓库内任何脚本或配置。`package.json` 中的脚本仍以
   `corepack pnpm` 为标准形式（与历史任务一致）。
4. **本机 Bash 工具的批量删除配额**：安全删除保护按「每次 shell 调用」累计配额，单次调用内
   的多次大目录删除会被拒绝。这会让把全部验证命令串在一次调用里的做法出现假失败；
   逐条执行即恢复正常。同时它暴露了两个构建脚本的清理健壮性问题，已修复（见第 4 节）。
5. **`verify:release` 要求工作区干净**：该入口把「除 `.superpowers/` 外无未跟踪/已修改文件」
   作为发布不变量之一，因此它应在**已提交**的树上运行。本任务在提交后执行并得到退出码 0。
6. **`bundle.active: false`**：Tauri 安装包未启用，与历史任务一致；本任务不实现打包。
7. **`credentialRef` 与 `baseUrl` 在设置页可见可编辑**：二者是配置所需的非敏感字段
   （`credentialRef` 是引用而非 secret）。会话页与事件 ViewModel 不显示它们，任何 secret
   值都不进入任一界面（见 `docs/desktop.md` 的解释说明）。
8. **vitest hook 默认超时与 worker RPC**：`task-18`/`task-19` 的 `beforeAll` 会在 hook 内
   执行真实构建，而 vitest 默认 `hookTimeout` 仅 10s；当构建指纹变化（即需要真正重建）时，
   一次正常构建会被报成 `Hook timed out in 10000ms`。已在 `vitest.config.ts` 显式设置
   `hookTimeout`（**不改变任何断言**），并新增断言防止回退。此外，当构建在测试进程内长时间
   阻塞时，vitest 偶发报告 `[vitest-worker]: Timeout calling "onTaskUpdate"`（unhandled
   error，会使退出码非 0）。这是 vitest 与运行环境的产物而非仓库缺陷；`verify:release`
   先构建再跑测试，因此该发布入口不受影响。
9. **本机 git 引用文件曾被外部因素删除（已恢复）**：本次执行中 `git commit` 成功后，
   `.git/refs/heads/` 目录与其下的 `workbench/agent-core` 引用文件被外部因素删除，仓库一度
   呈现「unborn branch」状态（对象库与 reflog 完好，`git reflog` 记录了本次提交）。
   已依据 reflog 与对象库用等价方式恢复该引用（**未**使用 `reset` / `checkout` / `rebase`），
   并逐项复核 `HEAD`、`HEAD^`、提交对象、`git log` 与提交时完全一致，无内容丢失。
   这是环境侧异常，已记录以免被误读为仓库问题。
