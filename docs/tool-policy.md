# Tool Policy、审批闸门与安全工具执行边界

本文件描述 Task 7 在 `@agent-workbench/agent-runtime` 中新增的工具执行闸门。

它只解决**是否允许调用一个工具**，不提供任何工具，也不提供任何审批界面。

## 1. 位置与职责

```text
ToolExecutionRequest
        ↓
ToolPolicy            （注入式，决定 allow / deny / ask）
        ↓
ToolApprovalHandler   （注入式，仅在 ask 时被询问）
        ↓
ToolExecutor          （注入式，真正执行）
```

闸门是一个**显式包装层**：

```ts
const governed = createGovernedToolExecutor({ executor, policy, approvalHandler });
const loop = createAgentLoop({ gateway, toolExecutor: governed });
```

`createAgentLoop()` 本身完全不知道策略与审批的存在。Task 6 的轮次编排、
取消语义、错误清洗、工具串行执行和消息追加逻辑**一行未改**。

## 2. 什么都不默认提供

本包**没有**：

- shell 工具、文件读写工具、网络工具；
- 默认 `ToolExecutor`：没有注入就拒绝执行；
- 默认 `ToolPolicy`：没有注入就拒绝（fail-closed）；
- 审批 UI、审批事件、审批持久化；
- “记住此选择” / always allow；
- 自动批准策略或批准名单；
- 任何对 `child_process`、`fs`、`http`、`https`、`fetch`、`WebSocket` 的引用。

所有 executor、policy、approval handler 都是调用方注入的 fake 或 class fixture，
自动化测试完全离线。

## 3. 公开接口

```ts
type ToolPolicyDecision = "allow" | "deny" | "ask";

interface ToolPolicy {
  decide(
    request: ToolExecutionRequest,
    signal?: AbortSignal,
  ): ToolPolicyDecision | Promise<ToolPolicyDecision>;
}

type ToolApprovalDecision = "approved" | "denied";

interface ToolApprovalRequest {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

interface ToolApprovalHandler {
  requestApproval(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): ToolApprovalDecision | Promise<ToolApprovalDecision>;
}

interface GovernedToolExecutorOptions {
  readonly executor: ToolExecutor;
  readonly policy?: ToolPolicy;
  readonly approvalHandler?: ToolApprovalHandler;
}

function createGovernedToolExecutor(
  options: GovernedToolExecutorOptions,
): ToolExecutor;
```

固定内容常量：

```text
TOOL_POLICY_DENIED_CONTENT      = "Tool execution was denied."
TOOL_APPROVAL_UNAVAILABLE_CONTENT = "Tool approval is unavailable."
TOOL_APPROVAL_DENIED_CONTENT    = "Tool execution was denied."
TOOL_APPROVAL_FAILED_CONTENT    = "Tool approval failed."
TOOL_POLICY_FAILED_CONTENT      = "Tool policy evaluation failed."
```

错误：

- 错误码：`invalid_tool_policy_options`
- 异常类型：`ToolPolicyError`
- 常量表：`TOOL_POLICY_ERROR_CODES`

## 4. 结构化接口校验

`executor`、`policy`、`approvalHandler` 通过 **callable method 检查** 校验：

- 非 `null`；
- `typeof === "object"`；
- 不是数组；
- 目标方法是 `function`。

因此下面这些**都可以**：

- 对象字面量；
- `null` 原型对象；
- class 实例（方法在 prototype 上）。

下面这些**全部同步拒绝**并抛出 `invalid_tool_policy_options`：

```text
null  undefined（仅 executor）  []  "allow"  1  true  {}
{ execute: 1 }  { decide: 1 }  { requestApproval: 1 }
```

不使用 `isPlainObject()`，也不通过 `Object.getPrototypeOf()` 判断依赖是否为普通对象。
`options` 包本身仍需是普通对象。错误消息固定，**不回显被拒的值**。

## 5. 决策状态机

```text
aborted？                → 固定失败（由 Agent Loop 输出 aborted）
没有 policy              → deny                    （默认拒绝）
policy.decide()
├─ allow                 → executor.execute()
├─ deny                  → TOOL_POLICY_DENIED_CONTENT（不询问审批，不执行）
├─ ask，没有 handler     → TOOL_APPROVAL_UNAVAILABLE_CONTENT
├─ ask
│   ├─ "approved"        → executor.execute()
│   ├─ "denied"          → TOOL_APPROVAL_DENIED_CONTENT
│   └─ 其他任何值        → TOOL_APPROVAL_FAILED_CONTENT
└─ 其他任何值            → TOOL_POLICY_FAILED_CONTENT
```

要点：

- **没有 policy 就是 deny**，绝不默认 allow。
- 只有**精确字符串** `"approved"` 才算批准。`true`、`1`、`"yes"`、`"allow"`、
  `"APPROVED"`、`"approved "`、`null`、`undefined` 一律按审批失败处理。
- `allow` / `deny` 时**完全不联系** `approvalHandler`。
- 决策**从不缓存**：每个工具调用都会重新询问 policy（与 approval handler）。

## 6. 异常清洗

| 来源 | 结果 |
|---|---|
| `policy.decide()` 抛异常或 reject | `TOOL_POLICY_FAILED_CONTENT` / `isError: true` |
| policy 返回非法值 | `TOOL_POLICY_FAILED_CONTENT` |
| `requestApproval()` 抛异常或 reject | `TOOL_APPROVAL_FAILED_CONTENT` |
| approval 返回非法值 | `TOOL_APPROVAL_FAILED_CONTENT` |
| `executor.execute()` 抛异常或 reject | `TOOL_FAILURE_CONTENT`（Task 6 常量，“Tool execution failed.”） |
| executor 返回畸形结果 | **原样透传**，由 Task 6 的 Agent Loop 统一安全分类 |

异常中的 `message`、`stack`、URL、路径、`Authorization`、`Bearer`、token、
secret、`apiKey` **都不会**出现在结果、事件或日志里。本包不产生任何日志输出。

## 7. 取消语义

| 阶段 | 行为 |
|---|---|
| 预取消 | 不调用 policy / handler / executor |
| policy pending | signal 已传给 policy；取消后不进入审批、不执行 |
| approval pending | signal 已传给 handler；取消后不执行 |
| 批准后、执行前 | **再次检查 signal**，已取消则不执行 |
| executor 运行期 | signal 已传给 executor；executor 永不结束时 Loop 仍及时结束 |
| 迟到 resolve / reject | 不产生 unhandled rejection |

“取消后由谁输出 aborted”：闸门本身不产生事件——它只保证**不执行工具**，
最终由 Agent Loop 输出唯一的 `aborted`，且不输出 `loop_completed`。

## 8. 结果不进入事件流

- 工具结果只进入下一轮 `ModelRequest`；
- `tool_execution_completed` 只有 `toolCallId` 与 `isError`；
- `AgentLoopEvent.error`、审批决定、日志中都不出现工具内容。

## 9. 与 Task 6 的兼容性

- Task 6 的 579 个测试全部保持通过；
- `AgentLoopEvent` 结构未变；
- 工具串行执行、消息追加、轮数上限、取消语义均未变；
- class Gateway / class ToolExecutor 兼容性不回退。

## 10. 未实现

审批 UI、审批持久化、remember decision、自动批准、shell/文件/网络工具、
Local Agent API、CLI、Desktop/Tauri、真实供应商调用、真实 API Key。
