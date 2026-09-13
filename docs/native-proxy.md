# Native Proxy

`NodeSidecarBackend` 实现 Tauri Rust Host → Node sidecar → Local Agent API 的原生代理链路。

## 架构

```text
Desktop Renderer
  ↓ Tauri invoke/listen
Rust Tauri Host (NodeSidecarBackend)
  ↓ fixed loopback HTTP/1.1
Node Local Agent Host
  ↓ Local Agent API
Agent Backend / NotReady boundary
```

## 请求映射

| Tauri Command | HTTP Request |
|---------------|-------------|
| `agent_create_session` | `POST /v1/sessions` body `{}` |
| `agent_start_turn` | `POST /v1/sessions/:id/turns` body `{messages, tools?, routeId?, model?, maxTokens?}` |
| `agent_cancel_turn` | `POST /v1/sessions/:id/cancel` body `{}` |

## turnId Header

Node API 在 turn 流式响应中返回 `x-agent-turn-id` header。Rust proxy 校验该 header 并将 turnId 返回给 Renderer。

## 事件流

- HTTP 响应先读取并校验 headers；成功 turn 的 body 交给独立 worker，`agent_start_turn` 不等待 EOF
- worker 按 chunked / `Content-Length` / EOF framing 增量读取 NDJSON，不会把整个 turn 收集到内存
- 首个事件先完成协议校验；typed `{ turnId }` 响应序列化完成后才释放首事件，避免 Renderer 先收到事件却尚未拿到 turn id
- 事件通过 `NativeEventSink` 抽象发布（生产用 Tauri `emit`，测试用 recording fake）
- 每个事件恰好三个字段：`sessionId`、`turnId`、`event`
- terminal event（completed/error）后停止
- EOF 无 terminal → 固定安全 error
- 非 2xx 只根据 status 返回固定 HTTP 错误，不读取响应 body
- NDJSON 单行上限 256 KiB、总量上限 16 MiB；非法 UTF-8、JSON 或事件结构均折叠为固定协议错误

## 安全边界

- 仅连接 `127.0.0.1`
- 无 shell、无外部网络
- 错误消息固定，不回显路径/端口/URL/异常
- 请求体只包含允许字段，不添加凭据
