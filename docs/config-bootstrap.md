# Config Bootstrap

`createConfiguredLocalAgentHost` 提供从非敏感配置文件启动 Node Local Agent Host 的安全引导路径。

## 启动流程

```text
校验 Host/Port/配置路径
→ 检查配置文件存在
→ 读取并验证配置（loadProviderRegistry）
→ 创建全新 ProviderRegistry
→ 创建 Backend Runner（懒惰，不读凭据）
→ 创建 Local Agent Host
→ 启动 Listener
```

配置错误时**不启动 Listener**，不绑定端口。

## 配置文件格式

使用 `PersistedConfigV1`：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "my-provider",
      "name": "My Provider",
      "protocol": "openai_compatible",
      "baseUrl": "https://api.example.com/v1",
      "credentialRef": "credential:my-provider",
      "models": ["model-a"],
      "enabled": true
    }
  ],
  "routes": [
    {
      "id": "default",
      "name": "Default",
      "providerId": "my-provider",
      "model": "model-a",
      "enabled": true
    }
  ]
}
```

`credentialRef` 只是引用，不是 secret。

## 凭据边界

- 凭据只能通过 `credentials` 选项显式注入
- 默认 `UnavailableCredentialStore` fail-closed（`get()` 永远返回 `undefined`）
- 启动阶段 `CredentialStore.get()` 调用数 = 0
- 不从配置文件、环境变量或 CLI 参数读取 secret
- 不是 OS Keychain 实现

## 错误码

| 错误码 | 含义 |
|--------|------|
| `invalid_config_path` | 配置路径无效（非绝对路径、空、含特殊字符） |
| `config_not_found` | 配置文件不存在 |
| `config_invalid` | 配置文件内容无效 |
| `invalid_credentials` | CredentialStore 无效 |

错误消息固定，不回显路径、URL 或内部异常。

## 未实现

- OS Keychain / 真实凭据存储
- 配置 UI / Provider 管理 UI
- 真实 Provider E2E
- Tauri sidecar 配置路径传递
