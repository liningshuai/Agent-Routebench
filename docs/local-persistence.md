# 本地配置持久化（Local Persistence）

`@agent-workbench/local-persistence` 负责持久化**非敏感** Provider / Route 配置。

## 持久化链路

```text
ProviderRegistry
        ↓
Versioned Config Snapshot (PersistedConfigV1)
        ↓
JSON Config Store (InMemory / File)
        ↓
Atomic Local File Store
```

## 快照数据模型

```ts
interface PersistedConfigV1 {
  readonly version: 1;
  readonly providers: readonly ProviderDefinition[];
  readonly routes: readonly RouteDefinition[];
}
```

只保存：

| Provider | Route |
|----------|-------|
| id | id |
| name | name |
| protocol | providerId |
| baseUrl | model |
| credentialRef | enabled |
| models | fallbackProviderIds（可选） |
| enabled | |

`credentialRef` 允许保存为 `credential:<id>` 引用。**secret 永远不进入快照。**

## 公开接口

| 导出 | 说明 |
|------|------|
| `createConfigSnapshot(registry)` | 从 Registry 生成稳定排序的深拷贝快照 |
| `validateConfigSnapshot(input)` | 严格校验并返回新的不可变副本 |
| `createRegistryFromSnapshot(snapshot)` | 先完整校验再恢复 Registry，失败不返回半成品 |
| `InMemoryJsonConfigStore` | 离线内存存储，save 前校验，load 深拷贝 |
| `createFileJsonConfigStore({ filePath })` | 文件存储，绝对路径，原子写入 |
| `loadProviderRegistry(store)` | 文件不存在 → 空 Registry；非法 → 稳定错误 |
| `saveProviderRegistry(store, registry)` | 先建快照再保存，不修改 Registry |
| `PersistenceError` / `PERSISTENCE_ERROR_CODES` | 稳定错误契约 |

## 原子写入

```text
validate → serialize → write sibling temp file → rename over target
```

- 验证失败：不写临时文件
- 序列化失败：不覆盖旧文件
- 临时文件与目标同目录
- rename 失败：抛 `config_file_replace_failed`，不伪造成功
- 同一 store 的 save 串行化

## 安全边界

永远不写入文件：

- apiKey / api_key / token / Authorization / headers / secret / password
- CredentialStore 内容
- 环境变量中的密钥

错误 message 固定，不回显路径、JSON、Provider/Route ID、URL 或底层 fs 异常。

## 未实现

- OS Keychain / CredentialStore 持久化
- Session / Memory / 上下文压缩
- 真实 Provider 调用与网络访问
- CLI / Desktop 入口
