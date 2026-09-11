# Session Persistence

`@agent-workbench/session-persistence` 提供加密的本地 Agent Session 持久化。

## 架构位置

```text
Local Agent API (LocalAgentSessionStore)
        ↓
FileLocalAgentSessionStore
        ↓
AES-256-GCM Envelope 文件
```

本包只持久化 `LocalAgentSession` 元数据与 `AgentEvent[]` 历史。

## 公开接口

```ts
createFileLocalAgentSessionStore(options: FileSessionStoreOptions): LocalAgentSessionStore

class FileLocalAgentSessionStore implements LocalAgentSessionStore {
  create(): LocalAgentSession;
  get(id): LocalAgentSession | undefined;
  listEvents(id): readonly AgentEvent[];
  appendEvent(id, event): void;
  setStatus(id, status, activeTurnId?): void;
}
```

方法为**同步**接口，与 `LocalAgentSessionStore` 兼容。

## 文件 Envelope 格式

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "iv": "<base64 12 bytes>",
  "authTag": "<base64 16 bytes>",
  "ciphertext": "<base64>"
}
```

- 算法固定 `AES-256-GCM`
- key 由调用方注入（`Uint8Array`，32 字节）
- key **不写入文件**、不进日志、不从环境变量读取
- 每次保存生成新随机 IV
- 解密失败 / 篡改 / 空文件 / 非法 JSON 一律 `session_file_invalid`

## 明文内部模型

```json
{
  "version": 1,
  "sessions": [
    { "id", "status", "createdAt", "updatedAt", "activeTurnId?", "events": [] }
  ]
}
```

## 恢复语义

- 文件不存在 → 空 Store，不自动写文件
- `status = "running"` → 恢复为 `failed`，移除 `activeTurnId`，事件保留
- 不恢复 AbortController / Runner / Promise / 工具执行器
- 恢复后原子保存新状态；保存失败则工厂抛错

## 原子写入

```text
validate → encrypt → write sibling temp (0o600) → renameSync
```

- 写入失败旧文件保持不变
- rename 失败清理 temp
- 成功后无残留 temp

## 限制

| 常量 | 默认 | 上限 |
|------|------|------|
| `DEFAULT_MAX_SESSION_FILE_BYTES` | 16 MiB | 64 MiB |
| `DEFAULT_MAX_SESSIONS` | 256 | 4096 |
| `DEFAULT_MAX_EVENTS_PER_SESSION` | 10000 | 100000 |
| `DEFAULT_MAX_EVENT_BYTES` | 256 KiB | 1 MiB |

## 安全边界

- 源码无 `process.env`、`fetch(`、`node:http`、`console.log`
- 文件中无明文 Event、无 key
- 错误消息固定，不回显路径 / 密文 / key
- 不读取 CredentialStore、不访问网络

## 未实现

- Memory / 上下文压缩 / 消息自动重建
- CLI / Desktop / Tauri / Web UI
- SQLite / 数据库 / OS Keychain
- CredentialStore 持久化
- 真实 Provider 调用
