# Config Management

Provider / Route 非敏感配置管理闭环。

## 架构

```text
Desktop Settings UI
    ↓
DesktopConfigApiClient
    ↓
Tauri commands (agent_get_config, agent_create_provider, ...)
    ↓
Rust Native Proxy (loopback only)
    ↓
Node Local Agent Host
    ↓
ConfigManager
    ↓
ProviderRegistry + local-persistence
```

## ConfigManager

`createConfigManager({ registry, jsonStore })` 提供 Provider/Route CRUD：

- 所有输入严格运行时校验
- 每次变更经过 ProviderRegistry 现有校验
- 原子持久化；失败时回滚内存状态
- 并发变更串行化
- 删除被引用的 Provider 被拒绝

## 数据边界

Provider 只含非敏感字段：`id`, `name`, `protocol`, `baseUrl`, `credentialRef`, `models`, `enabled`。

`credentialRef` 只是引用，不是 secret。不出现 apiKey/token/authorization/headers/secret/password。

## API

```text
GET    /v1/config
POST   /v1/providers
PUT    /v1/providers/:id
DELETE /v1/providers/:id
POST   /v1/routes
PUT    /v1/routes/:id
DELETE /v1/routes/:id
```

## Desktop 设置

通过 `DesktopConfigApiClient` 访问配置。Renderer 不直接 import Provider Registry 或 Local Persistence。

设置页面可展示 name/id/protocol/baseUrl/models/enabled/route 字段，不展示任何 secret。

## 未实现

- 真实 OS Keychain
- 真实 Provider E2E
- 安装包 / 自动更新（Task 28）