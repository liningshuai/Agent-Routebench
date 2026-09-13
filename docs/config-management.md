# Configuration Management

Provider 与 Route 配置由 Node 侧的 `ConfigManager` 统一管理，Desktop 只通过已经校验的 IPC/loopback bridge 访问它。

## 数据流

```text
Desktop Settings UI
    ↓ DesktopConfigApiClient
Tauri commands
    ↓ NodeSidecarBackend（固定 loopback 路径）
Node Local Agent Host
    ↓ LocalAgentConfigManager
ConfigManager
    ↓
ProviderRegistry + local-persistence
```

## HTTP API

```text
GET    /v1/config
POST   /v1/providers
PUT    /v1/providers/:id
DELETE /v1/providers/:id
POST   /v1/routes
PUT    /v1/routes/:id
DELETE /v1/routes/:id
```

所有端点都使用固定路径和固定 JSON 错误契约。没有配置管理器时返回
`configuration_unavailable`；输入错误、未知字段、ID 不匹配或 Provider/Route
关系不成立时返回固定的 `invalid_config_request`。

## ConfigManager 语义

`createConfigManager({ registry, jsonStore })` 提供 Provider/Route CRUD：

- 复用 `provider-registry` 的完整校验，包括 fallback Provider 与 model 关系。
- 每次变更都先校验、应用、生成快照，再原子持久化。
- 持久化失败会恢复变更前的内存状态，并返回固定错误。
- 并发变更按单实例队列串行化。
- 返回值始终是防御性副本；删除被 Route 引用的 Provider 会被拒绝。

## 非敏感边界

Provider 只允许 `id`、`name`、`protocol`、`baseUrl`、`credentialRef`、`models`、
`enabled`；Route 只允许 `id`、`name`、`providerId`、`model`、`enabled`、
`fallbackProviderIds`。

`credentialRef` 只是 CredentialStore 的引用。API、快照、HTTP 请求、IPC 响应和
Desktop UI 都不接受或展示 API key、token、Authorization、headers、secret、password
等敏感字段。真实 secret 仍只由 Gateway 在实际请求时按需读取。

## Desktop 设置页

`DesktopConfigApiClient` 对 IPC 返回值再次执行字段白名单、类型和敏感字段检查。
设置页可以查看和编辑 Provider/Route 的非敏感字段，并在每次成功变更后重新加载快照；
它不直接导入 Provider Registry 或 Persistence 包，也不建立第二套网络通道。

## 当前明确不包含

- OS Keychain 或其他真实凭据后端
- Provider 健康探测、模型目录自动同步
- 远程监听、CORS、远程配置服务
- 安装包、托盘和自动更新

详细验证见 [Task 27 verification report](verification/task-27-report.md) 及
[Task 27 rework report](verification/task-27-rework-report.md)。
