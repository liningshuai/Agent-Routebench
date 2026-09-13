# Task 24 收尾修复验证报告

## 基线

- 分支：`workbench/agent-core`
- 基线提交：`5cfd240d58ee171619d377e378000fcdbae7d11b`
- 基线工作区：仅 `.superpowers/` 未跟踪；该目录未读取、未修改、未暂存、未提交

## 发现的问题

Task 24 首轮实现虽然声明了 NDJSON 流式代理，但 `http_post()` 会先把完整响应 body 读入 `Vec<u8>`，而 `read_chunked_body()` 只返回首个 chunk。结果是：

- `agent_start_turn` 会等待整个 turn 完成后才返回 `turnId`
- 后续 chunk 不会被增量解析
- 非 2xx 响应会等待或读取 body，而不是看到 status 后立即返回
- `tool_call.input` 为数组等非对象值可以穿过 native event 边界

## 修复内容

### 1. Header/body 分离与增量读取

`HttpResponse` 现在只包含 status、headers 和拥有 socket 的 `BodyReader`。`BodyReader` 支持 `Content-Length`、chunked 和 EOF framing，并按片段读取；成功非流式响应才显式调用 `read_to_end()`。

`agent_start_turn` 读取并校验首个 NDJSON event 后，启动独立 worker，返回封闭的 `{ turnId }` 响应，不再等待 stream EOF。worker 按顺序发布后续事件，遇到 terminal event 停止，EOF 或协议错误发布固定 `gateway_error`。

### 2. IPC 返回与事件顺序

`StartTurnResponse` 增加 serde 跳过的内部一次性 release guard。Tauri command 序列化 typed response 后 guard 才释放首事件，因此 Renderer 不会在获得 `turnId` 前收到首个事件。序列化格式仍严格只有 `{ "turnId": "…" }`。

### 3. 非 2xx 和事件安全边界

- 非 2xx 在 body 被主动读取前返回 `sidecar_proxy_http_error`
- 非 2xx 的 `Content-Length` 不参与成功 body 的大小校验，避免恶意声明阻塞错误返回
- `tool_call.input` 必须为 JSON object
- error event 的 code/message 被折叠为固定白名单消息；未知错误统一为 `gateway_error`
- NDJSON 行、总量、UTF-8、JSON、requestId、字段白名单继续 fail-closed

## TDD 证据

修复前新增的 Rust 回归先运行并真实失败：

- 首 event 后挂起的 chunked stream 无法及时返回 `turnId`
- headers-only 的 503 响应因等待 body 超时
- 非 object `tool_call.input` 被错误接受

修复后新增回归与原有 proxy 测试全部通过。

## 受控变异抽查

本次针对新增边界执行并恢复了 3 项受控变异：

| 变异 | 结果 |
| --- | --- |
| 放宽 `tool_call.input` 为任意 JSON 值 | 被 Rust 回归检出（1 failed） |
| 删除首事件 release handshake | 被 Rust 流式回归检出（1 failed） |
| chunked body 只返回首段 | 被 Rust 流式回归检出（事件数量不符） |

每项变异均在测试后用原位补丁还原，恢复后测试重新通过；没有留下 mutation 标记或临时备份。

## 验证结果

- Rust proxy 聚焦：14 passed
- Rust native host 全量：96 passed
- TypeScript 全量：1795 passed（103 test files）
- Task 24 TypeScript 聚焦：19 passed（5 test files）
- `security:scan`：422 files scanned，passed
- `evals:deterministic`：stage 1 与 Task 3–24 场景全部 passed
- `cargo fmt --check`、`cargo check`、`git diff --check`：passed
- 未访问真实 Provider、未读取真实凭据、未访问外部网络
- `.superpowers/` 未触碰；未使用 reset、checkout、clean、force push 或 `git add .`

## 修改范围

- `apps/desktop/src-tauri/src/backend.rs`
- `apps/desktop/src-tauri/src/proxy.rs`
- `docs/native-proxy.md`
- `scripts/evals-deterministic.mjs`
- 本报告

Task 24 首轮报告保持为历史记录；本报告只记录本次修复与验证。
