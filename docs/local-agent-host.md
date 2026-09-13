# Local Agent Host

`@agent-workbench/local-agent-host`（Task 20）是 Local Agent API 的仅回环（loopback-only）
宿主入口。它复用 Task 9 的 `@agent-workbench/local-agent-api` 服务器实现，不复制、不改写
任何服务器核心逻辑。

## 公开接口

~~~ts
import { createLocalAgentHost, NotReadyLocalAgentRunner } from "@agent-workbench/local-agent-host";

const host = createLocalAgentHost({
  host: "127.0.0.1",      // 或 "localhost"；默认 "127.0.0.1"
  port: 8123,             // 必须是 1–65535 的整数
  runner,                 // 可选；默认 NotReadyLocalAgentRunner
});

await host.start();         // created → starting → running；重复 start 返回固定 already_started
host.address();             // 运行中返回 http://127.0.0.1:<port>，启动前/关闭后为 undefined
await host.close();         // 幂等；created→closed 合法；closed 后重复 close 为 no-op
host.state();               // created | starting | running | closing | closed
~~~

## 参数校验

- host 只允许 `127.0.0.1` 与 `localhost`；`0.0.0.0`、私网地址、IPv6、远程域名与 URL
  一律以固定 `host_not_loopback` 错误拒绝；
- port 必须是 1–65535 的安全整数；0、负数、小数、NaN、Infinity、字符串、超范围值
  以固定 `invalid_port` 错误拒绝；
- runner 必须携带可调用的 `run()`；object literal、null-prototype 对象与 class 实例
  均可，null、数组、primitive、缺失或非函数 `run()` 以固定 `invalid_options` 拒绝；
- 所有错误消息固定，不回显 host、port 或底层异常。

## 生命周期

`start()` 只能成功一次；并发 `start()` 只会创建一个服务器（其余调用收到固定
`already_started`）。启动失败（例如端口被占用）不会伪造 running 状态。`close()`
幂等，对从未启动的宿主同样安全；关闭后 `address()` 返回 `undefined`，不会返回旧地址。

## 默认 Runner：为什么是 not-ready

Task 20 只交付宿主入口与生命周期，不组装 Agent Backend。`NotReadyLocalAgentRunner`
因此从不产生模型文本、`tool_call`、`usage` 或 `completed`：它的 `run()` 抛出固定的
`Local agent runner is not ready.`，由既有 Task 9 服务器统一折叠为固定
`runner_error` 事件（消息 `"Agent runner failed."`），不泄露任何内部细节。
Task 21 才负责把真实 Backend 组装进来并通过同一 `LocalAgentRunner` 注入边界接入。

## 安全边界

- 仅监听 loopback；无 CORS 头、无远程监听、无反向代理、无 WebSocket；
- 无 Provider URL、无 Authorization、无 API key、无 token、无 CredentialStore；
- 无文件持久化、无数据库、无子进程、无 shell；
- 不读取环境变量（CLI 端口来自 `--port` 参数）；不发起点任何 outbound HTTP 请求；
- HTTP 能力完全来自既有 Local Agent API Server，端点与错误契约
  （`session_not_found`、`session_busy`、`invalid_request`、`invalid_json`、
  `method_not_allowed`、`payload_too_large`、`runner_error`、NDJSON 事件流、
  AbortSignal 行为）全部保持 Task 9 原样。

## Node 入口

~~~powershell
corepack pnpm local-agent-host -- --host 127.0.0.1 --port 8123
~~~

入口注册 SIGINT / SIGTERM（各一次）并幂等关闭；返回退出码而不是调用
`process.exit()`，信号注册函数可注入以便测试。

## 当前状态

Task 20 只提供 loopback Local Agent API Host 入口和生命周期管理；当前仍然没有真实
Agent Backend、真实模型调用或 Provider 接入。Task 21 才负责完整 Agent Backend 组装。

## Task 22 — Runnable Backend Composition

`createRunnableLocalAgentHost({ host, port, backend, store?, maxBodyBytes? })` 把
Task 21 的 `AgentBackendOptions` 组装为 Runner 并接入本宿主。默认 `createLocalAgentHost()`
与 `runLocalAgentHostMain()` 行为不变（NotReady 默认 Runner、无环境变量读取）。
`LocalAgentHostOptions` 新增可选 `store` 与 `maxBodyBytes`，无损透传给既有服务器。
详见 [Agent Backend Host Composition](agent-backend-host.md)。
