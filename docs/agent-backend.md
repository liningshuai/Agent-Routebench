# Agent Backend

`@agent-workbench/agent-backend`（Task 21）把既有抽象组装成一个可运行的
`LocalAgentRunner`。它不重新实现任何协议解析、重试、故障转移、多轮循环或工具执行，
只做组装与事件契约适配。

## 组件图

```text
ProviderRegistry + CredentialStore
   + (injected) HttpClient
   → ResilientRoutedHttpModelGateway      （重试 / 故障转移仍在这里）
   → AgentRuntime createAgentLoop         （多轮、工具、取消仍在这里）
   → （可选）GovernedToolExecutor          （fail-closed policy / approval）
   → AgentLoopEvent → AgentEvent 适配层
   → LocalAgentRunner
   → Local Agent API Host（Task 20）
```

## 公开接口

~~~ts
import { createAgentBackend, createAgentBackendRunner } from "@agent-workbench/agent-backend";

const backend = createAgentBackend({
  registry,             // 必需；ProviderRegistry
  credentials,          // 必需；CredentialStore
  httpClient,           // 可选；默认为网关内置的 fetch transport
  retryPolicy, wait,    // 可选；透传给 Resilient Gateway
  toolExecutor, policy, approvalHandler, // 可选；经 createGovernedToolExecutor 包装
  maxTurns, maxToolCallsPerTurn, maxToolResultBytes,
  defaultMaxTokens,     // Runner 请求缺省 maxTokens 时使用（正整数）
  maxFrameBytes, maxToolInputBytes,
});

runner === backend.runner; // createAgentBackendRunner 只返回 runner
~~~

`registry` / `credentials` / `toolExecutor` / `policy` / `approvalHandler` 支持
对象字面量、null-prototype 对象与 class 实例；仅检查所需方法是否可调用。非法
options 同步抛出固定错误 `Agent backend options are invalid.`（code
`invalid_options`），不回显任何输入。

## 依赖方向

`agent-backend → provider-registry / model-gateway / agent-runtime / agent-core /
agent-contracts / local-agent-api`，全部经由公开包入口。没有任何反向依赖。

## 请求转换

`LocalAgentRunnerRequest → ModelRequest`：

| 字段 | 规则 |
| --- | --- |
| `requestId` | 必须等于 `turnId`，不生成第二个 ID |
| `routeId` / `model` | 必填非空字符串；缺失即产生固定 `invalid_request` 事件，绝不自动选择 Route/Model，也不触碰 CredentialStore |
| `messages` / `tools` | 防御性复制；`tools ?? []` |
| `maxTokens` | 缺省用 `defaultMaxTokens`（默认 4096）；必须为正安全整数 |

## AgentLoopEvent → AgentEvent 映射

| AgentLoopEvent | 输出 |
| --- | --- |
| `route_selected` / `text_delta` / `tool_call` / `usage` | 1:1 映射，`requestId` 重写为 `turnId` |
| `turn_started` / `tool_execution_started` / `tool_execution_completed` | 不输出 |
| `completed` | 暂存（deferred），不立即输出 |
| `loop_completed` | 输出恰好一个最终 `completed` 并结束流 |
| `error` | 输出固定清洗后的 `error`（code/message/retryable），不再输出 `completed` |

**中间 completed 规则**：Runtime 在每个模型轮结束都会发 `completed`，随后可能继续
执行工具并进入下一轮；Local Agent API 把第一个 `completed` 当作整条 HTTP 流的终止。
因此适配层把 `completed` 暂存，一旦出现任何后续可见事件就丢弃暂存值；只有看到
`loop_completed` 才输出唯一一个最终 `completed`。映射是增量流式的，不会为了判定
终止而缓冲整个响应；提前退出/错误/取消时通过 `return()` 释放上游迭代器，悬挂的
`next()` 不会产生 unhandled rejection。

## Tool Policy

- 未提供 executor：保持 Agent Runtime 自身的 fail-closed 语义。
- 提供 executor：经 `createGovernedToolExecutor()` 包装；无 policy 默认 deny；
  `ask` 必须有 `approvalHandler`；只有精确 `"approved"` 放行；异常折叠为固定安全
  结果；AbortSignal 原样透传；不缓存决策；工具结果内容绝不进入 `AgentEvent`。

## Session 终态规则（Task 9 最小修正）

Stream 正常结束但最后一个终止事件是 `error` 时，Session 不再被标记 `completed`：

- 终止 `completed` → `completed`
- 终止 `error` 且 code ≠ `aborted` → `failed`
- 终止 `error` 且 code = `aborted` → `cancelled`
- Runner 抛异常 → 固定 `runner_error` + `failed`（既有行为）

## 安全边界

- 凭据只在 Gateway 单次请求的认证头内部短暂出现；不进入 `ModelRequest`、事件、
  Session、错误或日志；Backend 构造期间不读取 CredentialStore，只在真实 Turn 时由
  Gateway 按既有逻辑读取。
- 新包生产源码不含 `fetch`、`node:http`、`node:fs`、`process.env`、子进程；
  所有 HTTP 经由注入的 `HttpClient`。
- Provider URL、credentialRef、tool 结果内容、异常原文、stack 不进入任何事件。

## 当前状态

Task 21 完成 Node / TypeScript 侧的 Backend 组装。真实 Provider E2E、真实 API Key
验证、Tauri Rust 宿主与该 Backend 的跨进程连接、Memory / Session Persistence 集成
均未实现，属于后续任务。测试全绿不代表不存在其他缺陷。
