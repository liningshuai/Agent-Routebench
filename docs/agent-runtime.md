# Agent Runtime：有界多轮 Agent Loop 与工具执行边界

本文件描述 Task 6 实现的 `@agent-workbench/agent-runtime`：它把 Agent Core 的单次
模型请求组合成一个**有界多轮循环**，并在模型要求调用工具时，把执行权交给**调用方注入**
的 `ToolExecutor`。

**本层不提供任何工具。** runtime 中不存在 shell、文件读写或网络能力，也没有任何默认
执行器；没有注入 `ToolExecutor` 时，模型提出的工具调用会被固定错误拒绝。

## 1. 分层与依赖方向

```text
Agent Runtime            (packages/agent-runtime)
        |  只依赖抽象 ModelGateway
        v
Agent Core               (packages/agent-core)   createAgentCore / AgentEvent
        v
Agent Contracts          (packages/agent-contracts)

实际注入的 ModelGateway 可以是：
  DeterministicFakeModelGateway  |  RoutedHttpModelGateway  |  ResilientRoutedHttpModelGateway
```

- `agent-runtime` 的依赖只有 `@agent-workbench/agent-contracts` 与
  `@agent-workbench/agent-core`。
- **不依赖** `model-gateway`，也**不依赖** `provider-registry`：任何具体网关都通过
  `@agent-workbench/agent-contracts` 的 `ModelGateway` 接口注入。
- 不使用跨包 `../../<pkg>/src` 穿透导入。
- 校验逻辑复用 `createAgentCore()` / `validateModelRequest()` / `AgentValidationError`，
  错误清洗仍由 Agent Core 负责，runtime 不重新引入原始上游错误文本。

> 为了让 `@agent-workbench/agent-core` 能作为**包名**被解析，agent-core 的
> `package.json` 在本任务中补上了 `types` / `exports` 两个字段（与 `agent-contracts`、
> `provider-registry` 早已具备的形态一致）。这是纯粹的打包对齐，没有改动任何逻辑。

## 2. 公开接口

```ts
export interface ToolExecutionRequest {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

export interface ToolExecutionResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolExecutor {
  execute(
    request: ToolExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

export interface AgentLoopOptions {
  readonly gateway: ModelGateway;
  readonly toolExecutor?: ToolExecutor;
  readonly maxTurns?: number;
  readonly maxToolCallsPerTurn?: number;
  readonly maxToolResultBytes?: number;
}

export const DEFAULT_AGENT_LOOP_LIMITS = {
  maxTurns: 8,
  maxToolCallsPerTurn: 16,
  maxToolResultBytes: 65536,
} as const;

export interface AgentLoop {
  run(request: ModelRequest, signal?: AbortSignal): AsyncIterable<AgentLoopEvent>;
}

export function createAgentLoop(options: AgentLoopOptions): AgentLoop;
```

`AgentLoopEvent` 是一个可判别联合，每个事件都带 `requestId`，除 `loop_completed`
外都带 `turnIndex`：

| 事件 | 附加字段 |
|---|---|
| `turn_started` | `turnIndex` |
| `route_selected` | `routeId`、`model` |
| `text_delta` | `text` |
| `tool_call` | `id`、`name`、`input` |
| `usage` | `inputTokens`、`outputTokens` |
| `tool_execution_started` | `toolCallId`、`name` |
| `tool_execution_completed` | `toolCallId`、`isError` |
| `completed` | —（该轮的模型响应结束） |
| `loop_completed` | `turns`（总模型请求数） |
| `error` | `code`、`message`、`retryable` |

**`tool_execution_completed` 不含工具结果内容**：只报告 `toolCallId` 与 `isError`。
工具结果只进入下一轮 `ModelRequest`，不经过事件流。

### 2.1 选项校验与结构化接口

`createAgentLoop()` 会同步校验选项，失败时抛出 `AgentLoopError`
（`code: "invalid_loop_options"`），**不回显**被拒值：

| 字段 | 要求 |
|---|---|
| `options` 本身 | 必须是普通对象（`Object.prototype` 或 `null` 原型） |
| `gateway` | **非 `null` 的 object、不是数组，且存在可调用的 `stream` 方法** |
| `toolExecutor` | 可选；出现时必须是**非 `null` 的 object、不是数组，且存在可调用的 `execute` 方法** |
| `maxTurns` / `maxToolCallsPerTurn` / `maxToolResultBytes` | 可选；出现时必须是正的安全整数 |

`ModelGateway` 与 `ToolExecutor` 是**结构化接口**，因此校验只看形状、不看原型：

- **接受** class 实例（方法在 prototype 上）—— 项目自有的 `DeterministicFakeModelGateway`、
  `RoutedHttpModelGateway`、`ResilientRoutedHttpModelGateway` 都是 class；
- **接受**普通对象字面量与 `Object.create(null)` 对象；
- **拒绝** `null`、数组、字符串、数字、boolean，以及缺少该方法或方法不是函数的对象。

实现上使用内部 `hasCallableMethod(value, method)`：`typeof value === "object"`、
非 `null`、非数组、且该字段是 `function`。**不会**用 `Object.getPrototypeOf()` 去要求
gateway / executor 是普通对象。

## 3. 状态机

```text
预取消？ --是--> 一个 aborted error，结束（不调用 Gateway）

turn = 0
  turn_started
  createAgentCore(gateway).run(turnRequest)
    route_selected / text_delta / tool_call / usage / completed / error  ── 增量转发
  ── 若收到 error：转发该（已清洗的）error，结束，无 loop_completed
  ── 若流未 completed：固定 incomplete_model_response error，结束
  ── 若无 tool_call：loop_completed(turns = turn + 1)，结束
  ── 若有 tool_call：整批校验
        数量 > maxToolCallsPerTurn        -> too_many_tool_calls
        未注入 toolExecutor               -> tool_execution_unavailable
        名称不在 request.tools 中          -> unknown_tool
        turn + 1 >= maxTurns              -> max_turns_exceeded（不执行任何工具）
      否则：逐个串行执行
        tool_execution_started -> 执行 -> tool_execution_completed
      追加 assistant 消息与 tool 消息，turn += 1，回到 turn_started
```

校验顺序是**固定**的，并且**先完整校验整批、再执行任何一个工具**，避免"执行到第三个
调用才发现越界"。

## 4. 消息追加规则

下一轮的 `messages` 一定是**新数组**，结构为：

```text
原始 messages
+ { role: "assistant", content: [ ...text blocks（若该轮有文本）, ...tool_call blocks ] }
+ { role: "tool",      content: [ ...tool_result blocks ] }
```

- 同一轮内相邻文本按原顺序拼接为一个 text block；没有文本时不产生 text block。
- `tool_call.id`、`name`、`input` 原样保留，**不改写、不重排**。
- `tool_result` 使用 `toolCallId` 指回调用；失败时带上 `isError: true`。
- 每个工具结果与它自己的调用配对，不会串线。
- 调用方传入的 `request` / `messages` / `tools` 从不被修改：runtime 只读取并深拷贝。
  `routeId`、`model`、`tools`、`maxTokens` 在每一轮都保持不变。

## 5. 工具调用校验

模型返回的每个 `tool_call` 都会在 runtime 内**重新校验**（不信任上游）：

- `id` 必须是非空字符串；`name` 必须是非空字符串；
- `input` 必须是有限 JSON 值（拒绝 `undefined`、函数、循环对象、`NaN`、`Infinity`）；
- 非法 input **不会被替换成 `{}`**，而是直接拒绝（`invalid_tool_call`）；
- `id` 在整个 loop 内唯一：同一轮重复、跨轮重复都拒绝（`duplicate_tool_call_id`）。

任一失败都会：不执行任何工具、不发起下一轮、不输出 `loop_completed`。

## 6. 工具结果校验

`ToolExecutor` 的返回值经过严格校验，不合法时**不暴露原始异常**，统一生成固定安全结果：

```text
content: "Tool execution failed."
isError: true
```

判定为失败的情况：抛出异常（同步抛或 reject）、返回值不是普通对象、`content` 不是字符串、
`isError` 出现但不是 boolean、`content` 的 **UTF-8 字节数**超过 `maxToolResultBytes`。

超限不静默截断；失败会让模型在下一轮看到固定结果并自行恢复。这一过程不产生 error 事件。

## 7. 稳定错误码与固定文案

| code | message | retryable |
|---|---|---|
| `invalid_loop_options` | `Agent loop options are invalid.` | 同步抛出 |
| `aborted` | `Request aborted.` | false |
| `tool_execution_unavailable` | `Tool execution is unavailable.` | false |
| `unknown_tool` | `The requested tool is not available.` | false |
| `invalid_tool_call` | `The model returned an invalid tool call.` | false |
| `duplicate_tool_call_id` | `The model returned a duplicate tool call id.` | false |
| `too_many_tool_calls` | `The model returned too many tool calls.` | false |
| `max_turns_exceeded` | `The agent loop reached its maximum number of turns.` | false |
| `tool_execution_failed` | `Tool execution failed.` | 仅作为固定工具结果内容使用 |
| `incomplete_model_response` | `The model stream ended before completion.` | false |
| `gateway_error` | `Model gateway request failed.` | false |

- 配置错误同步抛出 `AgentLoopError`（`code: "invalid_loop_options"`），**不回显**被拒值。
- 所有 message 都是固定文案，不拼接工具 input、异常文本、URL、token 或 header。
- `tool_execution_failed` 按第 7 项要求以**固定工具结果**形式出现（让模型可恢复），
  因此不会作为 error 事件发出。

## 8. 取消与资源释放

| 阶段 | 行为 |
|---|---|
| 预取消 | 不调用 gateway、不调用 ToolExecutor、不输出 `turn_started`；只输出一个 `aborted` |
| 模型流中取消 | 用 `AbortSignal` 与上游 `next()` 竞速，立即解除等待；只输出一个 `aborted` |
| 工具执行中取消 | 同一个 signal 传给 `ToolExecutor`；悬挂的工具 Promise 也能让 loop 及时结束 |
| 退避/下一轮之前 | 每次推进上游前重新检查 signal；取消后**不会**开始下一次模型请求 |

- 上游 iterator 在 `finally` 中释放；**不等待** `return()`（悬挂的清理不能阻塞结束）。
- 迟到 resolve / reject 都已被接住，不产生 unhandled rejection。
- 终止后不再输出任何正常事件：`aborted` 之后没有 `completed`、没有 `loop_completed`、
  没有新的 `text_delta` / `tool_call` / `usage`。
- 多个 loop 并发时，turn 计数、tool_call id 集合、消息历史、工具结果与 signal 互不共享。

## 9. 安全边界

- runtime 源码中不存在 `fetch(`、`node:http`、`node:https`、`node:fs`、
  `node:child_process`、`WebSocket`、`process.env`、`keytar`、`sqlite`、`require(`；
- 自动化测试中的 `ToolExecutor` 是注入式 fake；没有真实模型调用，也没有真实网络访问；
- 事件流中不会出现 credential、header、URL、Authorization、token 或 secret；
- `AgentLoopOptions` 上没有任何凭据或传输字段。

## 10. 工具策略与审批闸门（Task 7）

Task 6 的 `ToolExecutor` 语义不变。需要审批或策略判断的调用方应当**显式包装**它：

```ts
const governed = createGovernedToolExecutor({ executor, policy, approvalHandler });
const loop = createAgentLoop({ gateway, toolExecutor: governed });
```

`createAgentLoop()` 本身不知道策略与审批的存在。闸门的完整规则见
[Tool Policy 与审批闸门](tool-policy.md)，要点：

- 没有 `ToolPolicy` → `deny`（fail-closed）；`ask` 而没有 `ToolApprovalHandler`
  → “审批不可用”；只有精确 `"approved"` 才执行。
- 决策从不缓存，每个工具调用都重新询问。
- 所有失败与异常折叠为固定安全结果。
- policy / approval handler / executor 都通过结构化方法校验，class 实例可用。

## 11. 当前不支持

- 真实供应商 / 真实模型调用（全部测试离线）；
- 工具结果内容的回放或渲染（事件中没有这个通道）；
- 审批 UI、自动批准策略、审批决策持久化、“记住此选择”、持久化、Memory、上下文压缩；
- Local Agent API、CLI、Desktop / Tauri 入口；
- runtime 自身也不做重试与故障转移：那是注入的具体网关（Task 5）的职责。
