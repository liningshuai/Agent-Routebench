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

- NDJSON 增量解析
- 事件通过 `NativeEventSink` 抽象发布（生产用 Tauri `emit`，测试用 recording fake）
- 每个事件恰好三个字段：`sessionId`、`turnId`、`event`
- terminal event（completed/error）后停止
- EOF 无 terminal → 固定安全 error

## 安全边界

- 仅连接 `127.0.0.1`
- 无 shell、无外部网络
- 错误消息固定，不回显路径/端口/URL/异常
- 请求体只包含允许字段，不添加凭据
