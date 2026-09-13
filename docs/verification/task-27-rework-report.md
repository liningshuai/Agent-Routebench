# Task 27 返工验证报告

## 目标

补齐 Task 27 首轮交付留下的三处断点：Local Agent API 配置端点、Tauri Native Proxy 配置转发，以及 Desktop 设置页的实际接入。原有 ConfigManager、ProviderRegistry 校验和原子持久化语义保持不变。

## 完整数据流

```text
Desktop Settings UI
  → DesktopConfigApiClient
  → Tauri agent_*_config commands
  → NodeSidecarBackend（固定 127.0.0.1 路径）
  → Local Agent API /v1/config、/v1/providers、/v1/routes
  → ConfigManager
  → ProviderRegistry + local-persistence
```

## 已完成修复

- `LocalAgentApiOptions.configManager` 为可选注入边界；无 manager 时固定返回 `configuration_unavailable`。
- 新增配置 CRUD HTTP 端点，所有输入、响应字段和敏感字段均 fail-closed；ProviderRegistry 校验错误映射为固定 400。
- `createConfiguredLocalAgentHost()` 将同一文件 store 同时提供给 ConfigManager 和 Agent Backend；支持显式 `createIfMissing` 的首启空配置。
- Tauri 配置 commands 通过 `ConfigBackend` 接入 Node sidecar；proxy 只构造固定 loopback 路径，非 2xx 不读取 body，并校验成功响应。
- Tauri sidecar 启动参数包含绝对配置文件路径和首启标志；每个 app 实例使用自己的配置文件。
- Desktop `DesktopConfigApiClient`、Browser/Tauri entry 和 `mountDesktopUi()` 已接入设置面板，页面只展示和编辑非敏感字段。
- 配置 manager 异常、非法路径编码和持久化失败都不会把原始异常、路径或 secret 传到 HTTP/IPC/UI。

## 验证证据

- 新增 `tests/task-27-rework-integration.test.ts`：HTTP 读取、Provider/Route CRUD、固定错误映射、路径编码和 Rust/sidecar wiring 检查。
- 新增 `tests/task-27-rework-desktop.test.ts`：设置面板接入、Provider/Route 表单及凭据字段隔离。
- Task 25 回归新增首启 `createIfMissing` 测试，验证嵌套目录、版本 1 空快照和监听器启动顺序。
- 既有 Task 27 管理器、HTTP、Desktop 和 Tauri 边界测试保持通过；历史静态断言仅更新为反映已接通的配置桥接。

本次返工新增测试共 13 个：`task-27-rework-integration.test.ts` 10 个，`task-27-rework-desktop.test.ts` 3 个；返工相关全套（原 Task 27 64 个 + 返工 13 个）共 77 个测试通过。

## 受控变异证据

交付前执行了 12 项受控变异，均在对应聚焦测试中被检出，并在每项之后原位恢复：

| 变异 | 检查边界 | 结果 |
| --- | --- | --- |
| 1 | 禁用 Local Agent API 配置路由 | 检出：配置 CRUD 回归失败 |
| 2 | 删除 Local Host 到 API 的 `configManager` 透传 | 检出：静态 wiring 断言失败 |
| 3 | 不注入 Desktop 配置面板 | 检出：设置页渲染断言失败 |
| 4 | 删除 Desktop Provider/Route 响应字段白名单 | 检出：secret-bearing 响应未被拒绝 |
| 5 | 删除 sidecar 的配置参数 | 检出：sidecar wiring 断言失败 |
| 6 | Tauri 配置 command 固定返回 unavailable | 检出：Native 配置桥接断言失败 |
| 7 | 禁用 `createIfMissing` 首启创建 | 检出：Task 25 首启回归失败 |
| 8 | 将配置错误状态错误映射为 500 | 检出：固定 400 错误断言失败 |
| 9 | Tauri runtime 不注入 `ConfigBackend` | 检出：Native runtime wiring 断言失败 |
| 10 | 删除 Tauri entry 的配置客户端接入 | 检出：entry wiring 断言失败 |
| 11 | Configured Host 不向 API 传 ConfigManager | 检出：实际 `/v1/config` 返回 503 |
| 12 | 路由 ID 使用不安全的原始 URI 解码 | 检出：畸形路径编码应返回固定 400 |

## 最终验证

- TypeScript 聚焦回归：14 个文件 / 168 个测试通过，其中返工与 Task 27、Task 25、Task 18/19/23 兼容性检查均通过。
- 全量 TypeScript：121 个测试文件 / 1981 个测试通过。
- Rust：`cargo fmt --check`、`cargo check`、`cargo test --lib` 均通过，98 个单元测试通过。
- `install --frozen-lockfile`、`verify:layout`、`build:local-agent-host`、`build:desktop`、`security:scan`、`evals:deterministic`、`git diff --check` 均通过。
- 测试仅使用注入式 fake 或本机 loopback；没有真实 Provider、真实凭据或外部网络访问。

## 安全边界

- 不读取环境变量，不从配置文件读取 secret，不通过配置 API 接收 API key、token、Authorization 或 headers。
- Tauri proxy 不接受任意 URL、host 或 header；Provider/Route ID 只被编码后拼入固定路径。
- 成功响应经过字段白名单和类型校验；Renderer 不直接依赖 Registry 或 Persistence 实现。
- 所有 provider-facing HTTP 仍由显式注入的 fake client 驱动，未连接真实 Provider。

## 范围声明

本返工没有实现 OS Keychain、真实 Provider E2E、安装包、托盘或自动更新。`configuration_unavailable` 仍是未连接 sidecar 时的正确 fail-closed 行为。

工作区不包含 `.superpowers/`；该目录保持未跟踪、未修改、未暂存、未提交。返工提交以 Task 27 首轮提交为父提交，具体 SHA 以交付时 Git 校验结果为准。
