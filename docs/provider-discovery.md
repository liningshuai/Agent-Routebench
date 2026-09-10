# Provider Discovery

`@agent-workbench/provider-discovery` 对已注册 Provider 执行受控健康检查与模型目录发现。

## 架构位置

```text
ProviderRegistry + CredentialStore
        ↓
createProviderDiscovery({ registry, credentialStore, httpClient })
        ↓
注入式 DiscoveryHttpClient（GET）
        ↓
Anthropic /v1/models  或  OpenAI-compatible /models
```

本包**只读**配置与凭据，不修改 Provider / Route / CredentialStore / 持久化文件。

## 公开接口

```ts
createProviderDiscovery(options): ProviderDiscovery

interface ProviderDiscovery {
  checkProvider(providerId, signal?): Promise<ProviderHealth>;
  listModels(providerId, signal?): Promise<ProviderModelCatalog>;
}
```

`registry` / `credentialStore` 支持 class 实例；`httpClient` 为注入函数。

## Endpoint

| Protocol | URL |
|----------|-----|
| `anthropic_messages` | `{baseUrl}/v1/models` |
| `openai_compatible` | `{baseUrl}/models` |

默认完整 URL：

- Anthropic preset `https://api.anthropic.com` → `https://api.anthropic.com/v1/models`
- OpenAI preset `https://api.openai.com/v1` → `https://api.openai.com/v1/models`

认证头沿用 model-gateway 的 `buildAnthropicHeaders` / `buildOpenAIChatHeaders`。
GET 无 body；secret 不进入 URL。

## 健康检查语义

```text
2xx + 合法目录   → healthy
401 / 403        → unauthorized
429              → rate_limited
其他非 2xx       → unavailable
2xx + 非法协议   → protocol_error
取消             → aborted
```

本地配置错误（provider 不存在 / 禁用 / 无凭据）**拒绝**，不伪装成健康状态。

## 模型目录

只返回标准化字段：`id`、`created`、`createdAt`、`ownedBy`、`displayName`。
未知字段忽略；重复 id 拒绝；`data: []` 合法；顺序保持；不缓存；不写回 Registry。

默认响应体上限 1 MiB（可配置，有安全上限）。

## 安全边界

- `CredentialStore.get()` 每次调用最多一次；从不 `set`/`delete`
- secret 只临时用于出站请求头，不进入返回值 / 错误 / 日志
- 不返回 baseUrl、headers、credentialRef
- 错误消息固定，不回显 URL / providerId / secret / body / stack
- 源码无 `fetch(`、`node:http`、`process.env`、`console.log`、`node:fs`
- 无重试、无故障转移、无缓存

## 未实现

- CLI / Desktop / Tauri / Web UI
- Health cache / Model list cache
- 自动更新 `provider.models` 或 Route
- 真实 Provider 端到端调用
- CredentialStore 写入 / OS Keychain
- 数据库 / 文件持久化
