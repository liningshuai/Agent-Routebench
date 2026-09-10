# Task 9 验证报告

## 范围

Local Agent API v1：`@agent-workbench/local-agent-api`，loopback-only HTTP 控制面。

## 基线

- HEAD: `d8a66ccc9545b48575f8eb880119bf549735eb16`
- 父提交: `354b4d50d2c2024a1b7efcd449f37e0e186b0a54`
- 工作区：仅 `.superpowers/` 未跟踪

## 新增包

`packages/local-agent-api/`

- `src/types.ts` — Session / Runner / Store / Server 类型
- `src/errors.ts` — 固定错误文案表
- `src/validation.ts` — 选项与 Turn 请求校验、敏感字段递归拒绝
- `src/session-store.ts` — `InMemoryLocalAgentSessionStore`
- `src/ndjson.ts` — NDJSON 行写出
- `src/server.ts` — `createLocalAgentApiServer`
- `src/index.ts` — 包入口

依赖：仅 `@agent-workbench/agent-contracts`、`@agent-workbench/agent-core`
与 Node 内置 `node:http` / `node:crypto`。

## 测试

| 文件 | 数量 |
|------|------|
| `tests/task-9-local-api.test.ts` | 21 |
| `tests/task-9-local-api-streaming.test.ts` | 7 |
| `tests/task-9-local-api-security.test.ts` | 11 |
| `tests/task-9-local-api-concurrency.test.ts` | 12 |
| `tests/helpers/local-agent-api-fixtures.ts` | — |
| **合计** | **51** |

全量：32 文件 / 790 测试（基线 739 + 51）。

## 受控变异（12 项）

| # | 变异 | 检出 |
|---|------|------|
| 1 | 允许 `0.0.0.0` host | 是 |
| 2 | 删除敏感字段拒绝 | **否**（根字段允许列表已覆盖同一批字段） |
| 3 | 删除 body 大小限制 | 是 |
| 4 | 删除 `session_busy` 守卫 | 是 |
| 5 | Runner 异常原文写入响应 | 是 |
| 6 | 不同 Session 共享事件数组 | 是 |
| 7 | `listEvents` 返回内部引用 | **否**（HTTP 序列化使客户端侧修改无法触及 Store） |
| 8 | 删除断开连接 Abort | 是 |
| 9 | 删除 iterator 释放 | 是 |
| 10 | 取消后仍允许继续 emit | **否**（取消路径在 emit 前已返回，sawTerminal 守卫冗余） |
| 11 | 不写出 NDJSON 行 | 是 |
| 12 | 删除 res.close 时 abort | **否**（测试通过 cancel 端点触发 abort，未覆盖纯客户端断开） |

**8/12 检出**；4 项未独立检出，原因已如实记录。

## 网络与凭据

- 无真实外部网络访问（测试仅连本机 `127.0.0.1` 回环）
- 不读取 CredentialStore
- 不依赖 Provider Registry / local-persistence
- 源码无 `fetch(`、axios、undici、WebSocket、`node:fs`、`process.env`

## 未实现

- CLI / Desktop / Tauri / Web UI
- SQLite / 文件持久化 / OS Keychain
- 真实 Provider 调用
- 远程监听 / CORS / API Key 鉴权
- 审批 UI / Memory / 上下文压缩
