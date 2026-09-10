# Local Agent API v1

`@agent-workbench/local-agent-api` 是 Desktop / CLI 共享的本机回环 HTTP 控制面。

## 架构位置

```text
Desktop / CLI
      ↓
Local Agent API (this package, loopback only)
      ↓
LocalAgentRunner (injected)
      ↓
Agent Core / Runtime (future)
```

本包**不**调用真实 Provider、不读取 CredentialStore、不持久化 Session。

## 公开接口

```ts
createLocalAgentApiServer(options): LocalAgentApiServer
InMemoryLocalAgentSessionStore
```

`options.runner` 支持 class 实例（只要求存在 `run` 方法）。
`options.store` 可选，默认内存实现。

默认 `maxBodyBytes = 1 MiB`。
`host` 仅允许 `127.0.0.1` 或 `localhost`。

## Endpoints

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | `{ ok, service, version }` |
| POST | `/v1/sessions` | 创建 Session，不调用 Runner |
| GET | `/v1/sessions/:id` | 查询元数据 |
| POST | `/v1/sessions/:id/turns` | 执行一轮，`Accept: application/x-ndjson` |
| POST | `/v1/sessions/:id/cancel` | 取消当前 turn |
| GET | `/v1/sessions/:id/events` | 查询事件（defensive copy） |

## Session 状态机

```text
idle → running → completed
               → cancelled
               → failed
```

- 同一 Session 单并发：已有运行中 turn 时返回 `409 session_busy`
- 不同 Session 完全隔离
- 多个 Server 实例不共享状态

## NDJSON 流

每个 `AgentEvent` 立即写出一行：

```text
{"type":"text_delta","text":"hello"}\n
{"type":"completed","requestId":"..."}\n
```

- 不拼成 JSON 数组
- `completed` / `error` 为终止事件，只出现一次
- Runner 异常 → 固定 `runner_error`，不回显原文
- 客户端断开 → AbortController 触发
- 流结束后释放 AsyncIterator

## 安全边界

拒绝字段（递归、大小写不敏感）：

`apiKey` / `token` / `authorization` / `headers` / `secret` / `password` /
`credential` / `endpoint` / `baseUrl` / `accessToken` / `refreshToken` / `clientSecret`

敏感字段扫描为 **fail-closed**：对象嵌套深度超过 32 层时直接拒绝，
不会静默跳过，深层 secret 无法绕过检查。

工具定义使用 `@agent-workbench/agent-core` 的 `validateAgentToolDefinitions()`
完整校验（含 `inputSchema`、重复名、空名、非对象等）。

`createLocalAgentApiServer(options)` 在任何字段访问前拒绝 `null` / `undefined` /
数组 / 原始类型，抛出固定 `invalid_request`。

固定错误文案，不回显请求体、路径、URL 或异常堆栈。
无 CORS、不读环境变量、不写文件、不访问外部网络。

## 未实现

- CLI / Desktop / Tauri / Web UI
- SQLite / 文件 Session 持久化 / OS Keychain
- 真实 Provider 调用 / CredentialStore 读取
- 远程监听 / CORS / API Key 鉴权
- 审批 UI / Memory / 上下文压缩
