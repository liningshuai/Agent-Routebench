# Agent Backend Host Composition（Task 22）

Task 22 在 `apps/local-agent-host` 中新增显式 Composition API，把 Task 21 的可运行
Backend 接入 Task 20 的 Loopback Local Agent Host：

```text
AgentBackendOptions
→ createAgentBackendRunner()
→ createLocalAgentHost()
→ Local Agent API（loopback）
```

## 公开接口

~~~ts
import { createRunnableLocalAgentHost } from "@agent-workbench/local-agent-host";

const host = createRunnableLocalAgentHost({
  host: "127.0.0.1",   // 或 "localhost"；默认 "127.0.0.1"
  port: 8123,          // 1–65535 整数
  backend: {           // Task 21 的 AgentBackendOptions，显式注入
    registry,
    credentials,
    httpClient,        // 可选；默认网关 fetch transport
    toolExecutor, policy, approvalHandler, // 可选；fail-closed
  },
  store,               // 可选；显式注入的 LocalAgentSessionStore
  maxBodyBytes,        // 可选；透传给既有服务器
});

await host.start();    // created → starting → running
await host.close();    // 幂等
~~~

`LocalAgentHostOptions` 同时扩展了可选 `store` 与 `maxBodyBytes`，两者无损透传给既有
`createLocalAgentApiServer()`；不注入时服务器继续使用默认内存 Store 与既定 body 上限。

## 安全与默认行为

- **默认 Host 仍然 NotReady**：不带 runner 的 `createLocalAgentHost()` 继续使用
  `NotReadyLocalAgentRunner`；`runLocalAgentHostMain()` 不会自动创建
  ProviderRegistry / CredentialStore / Backend。
- **只显式注入**：Backend 只能通过 `backend` 选项启用；没有任何配置文件、环境变量、
  CLI 参数会自动创建 Provider、Route、Model 或凭据；不自动选择 Route 或 Model。
- **Store 只能显式注入**；不注入则使用既有默认内存 Store。
- **校验**：composition options 支持对象字面量、null-prototype 与 class 实例；
  拒绝 null/undefined/数组/primitive、缺失 backend、backend 方法缺失、Registry 或
  CredentialStore 方法缺失、非函数方法、非法 port、非 loopback host、非法
  maxBodyBytes、未知字段，以及 `backend` 与 `runner` 同时出现的歧义配置。
  校验同步失败于监听器创建之前，使用固定错误消息，不回显任何输入。
- **loopback-only**：仍然只监听 `127.0.0.1` / `localhost`；无 CORS、无远程监听。
- **凭据边界**：构造期不读取凭据、不发送 HTTP；预取消不解析 Route；secret 只进入
  Gateway 单次认证头；Provider URL、credentialRef、tool 结果、异常原文不进入事件。
- **工具 fail-closed**：未提供 Tool Policy 时，工具执行仍被 `GovernedToolExecutor`
  拒绝。
- 生命周期 `created → starting → running → closing → closed` 不变；`close()` 幂等；
  重复 `start()` 返回既有固定错误。

## Node 入口

`runLocalAgentHostMain()` 保持 Task 20 行为：仅解析 `--host/--port`、启动
NotReady 默认 Runner 的宿主。要以真实 Backend 运行，调用方必须在自己的 Node 进程中
显式使用 `createRunnableLocalAgentHost()`（自动配置加载与 API Key CLI 参数属于后续
任务，本任务明确不实现）。

## 当前状态

Task 22 只完成 Node 侧 Composition。仍未实现：Tauri Rust 宿主与 Node Backend 的
跨进程连接、真实 Provider E2E（未验证任何真实 API Key）、自动配置加载、OS Keychain、
Memory/Session Persistence 集成、安装包、托盘与自动更新。测试全绿不代表不存在其他
缺陷。
