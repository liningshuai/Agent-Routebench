# Task 6 执行报告：有界 Agent Loop 与受控工具执行边界

## 1. 最终状态

**DONE_WITH_CONCERNS**

代码、测试、文档与确定性评测全部完成，全部必需验证命令退出码为 0。唯一 concern 是
**Git 分支引用再次未能落盘**（见 §14）：提交对象已正确生成并校验，但本环境写不进嵌套
引用 `refs/heads/workbench/agent-core`。按提示词要求未做任何绕过。

## 2. 基线

| 项目 | 值 |
|---|---|
| 仓库 | `agent-workbench-app` |
| 分支 | `workbench/agent-core` |
| 基线 HEAD | `8fefff72baf51025bed44346c68e9a0fea79170c`（`feat(gateway): add bounded retry and provider failover`） |
| 开工前 `git status` | 只有 `?? .superpowers/` |
| 开工前基线验证 | `typecheck` 0、`test` 0（21 files / **488** tests）、`verify:layout` 0、`security:scan` 0（73 files）、`evals:deterministic` 0（stage 1 + 3 组场景） |

`HEAD` 与要求完全一致，因此在本基线上实现，未做任何重置。

## 3. 修改文件清单

**新增包 `packages/agent-runtime/`**

| 文件 | 用途 |
|---|---|
| `package.json` | 包清单；`types`/`exports` 指向 `src/index.ts`；依赖只有 `agent-contracts` + `agent-core` |
| `tsconfig.json` | 继承 `tsconfig.base.json` |
| `src/types.ts` | `ToolExecutionRequest` / `ToolExecutionResult` / `ToolExecutor` / `AgentLoopOptions` / `AgentLoopEvent` / `AgentLoop` / `DEFAULT_AGENT_LOOP_LIMITS` |
| `src/errors.ts` | `AGENT_LOOP_ERROR_CODES`、固定文案表、`AgentLoopError`、`agentLoopError()`、`TOOL_FAILURE_CONTENT` |
| `src/agent-loop.ts` | Agent Loop 全部行为：选项校验、轮次编排、整批工具校验、串行执行、消息追加、取消竞速、上游释放 |
| `src/index.ts` | 统一导出；复用 agent-core / agent-contracts 的类型与实现，不复制契约 |

**新增测试**

| 文件 | 测试数 | 覆盖 |
|---|---:|---|
| `tests/helpers/runtime-fixtures.ts` | — | `scriptedGateway` / `gatedGateway` / `hangingExecutor` / `recordingExecutor` / `deferred` / `until` / `deepFreeze` 等 |
| `tests/task-6-agent-runtime.test.ts` | 34 | exports、默认值、非法 options、首轮、输入不可变、多轮工具调用、消息追加、轮数预算、结果字节上限、流未完成 |
| `tests/task-6-agent-runtime-security.test.ts` | 29 | 执行器缺失、未知工具、非法 tool_call（id/name/input）、重复 id、单轮工具上限、非法与超限结果、异常不落事件、网关错误转发、源码与包边界扫描 |
| `tests/task-6-agent-runtime-cancellation.test.ts` | 15 | 预取消、模型流中取消、工具执行中取消、悬挂工具/上游、迟到 resolve/reject、并发隔离 |

**修改**

| 文件 | 用途 |
|---|---|
| `packages/agent-core/package.json` | 补上 `types` / `exports`（纯打包对齐，使 `@agent-workbench/agent-core` 可作为包名被解析；与 `agent-contracts`、`provider-registry` 形态一致，无逻辑改动） |
| `package.json`（根） | workspace devDependency 增加 `@agent-workbench/agent-runtime` |
| `pnpm-lock.yaml` | 新增 `packages/agent-runtime` importer 与链接 |
| `README.md` | 当前阶段更新为 Task 6 |
| `docs/architecture.md` | 依赖分层补入 Agent Runtime；新增 Task 6 段落；更新「单一 Agent Core」与后续任务 |
| `docs/agent-runtime.md` | 新增：公开接口、状态机、消息追加、工具校验、错误表、取消、安全边界 |
| `scripts/evals-deterministic.mjs` | 新增 11 个文件存在检查 + 新增 Task 6 场景实跑 + 更新输出文案 |

未修改：`agent-contracts`、`model-gateway`、`provider-registry` 的任何源码；Task 1–5 的
任何测试；`.superpowers/`；`..\cc-switch-agent`。

## 4. 新增公开接口

```ts
ToolExecutionRequest  ToolExecutionResult  ToolExecutor
AgentLoopOptions      ResolvedAgentLoopOptions
AgentLoopEvent        AgentLoop
DEFAULT_AGENT_LOOP_LIMITS            // { maxTurns: 8, maxToolCallsPerTurn: 16, maxToolResultBytes: 65536 }
createAgentLoop(options)             // AgentLoop
resolveAgentLoopOptions(options)     // 同步校验
AGENT_LOOP_ERROR_CODES  AgentLoopError  agentLoopError  agentLoopMessage  TOOL_FAILURE_CONTENT
```

同时 re-export（不复制实现）：`AgentMessage`、`AgentToolDefinition`、`JsonValue`、
`ModelRequest`、`ModelGateway`、`ModelStreamEvent`、`AgentCore`、`AgentEvent`、
`AgentValidationError`、`createAgentCore`、`isJsonValue`、`validateModelRequest`。

## 5. Agent Loop 状态机

```text
预取消 → 一个 aborted error（不调用 gateway、不调用工具、无 turn_started）

turn 0..
  turn_started
  createAgentCore(gateway).run(turnRequest)  ← 每轮 context 独立
    增量转发 route_selected / text_delta / tool_call / usage / completed
    error → 转发该已清洗的 error 并结束（无 loop_completed）
  流未 completed → incomplete_model_response
  无 tool_call → loop_completed(turns = turnIndex + 1)
  有 tool_call → 整批校验后串行执行 → 追加 assistant/tool 消息 → 下一轮
```

终止事件唯一：正常路径恰好一个 `completed`（该轮模型响应）与一个 `loop_completed`
（整个 loop）；失败路径只有 error；取消路径只有 `aborted`。

## 6. 工具调用与消息追加

下一轮 `messages` 一定是**新数组**：

```text
原始 messages
+ { role: "assistant", content: [ text（若该轮有文本）, ...tool_call ] }
+ { role: "tool",      content: [ ...tool_result ] }
```

- 文本按到达顺序拼接；无文本则不产生 text block；`tool_call` 的 `id`/`name`/`input` 原样保留。
- 每个 `tool_result` 用 `toolCallId` 指回自己的调用（有专测断言逐条配对）。
- 单轮多个工具**串行**执行（`maxConcurrent === 1` 有断言），顺序与模型输出一致。
- 调用方 `request` / `messages` / `tools` 被 `deepFreeze` 后仍全程不被修改（深拷贝隔离）。
- `routeId` / `model` / `tools` / `maxTokens` 每轮保持不变。

## 7. 取消与资源释放证明

| 场景 | 断言 |
|---|---|
| 预取消 | `gateway.calls === 0`、工具 0 次调用、事件恰为 `[aborted]` |
| 模型流中取消 | 先取到 `text_delta`，`abort()` 后恰好一个 `aborted`，无第二个 `text_delta`、无 `completed` |
| 上游 `next()` 永不 settle | 用 `AbortSignal` 竞速，取消后**照样立即结束**（不是等下一个 chunk） |
| 工具执行中取消 | 同一个 `AbortSignal` 传给 `Executor.execute`（`signals[0] === controller.signal`） |
| 工具永不 settle | loop 仍及时结束；`gateway.calls` 保持 1（不开始下一轮） |
| 迟到 resolve / reject | `process.on("unhandledRejection")` 断言为空 |
| 悬挂 `return()` | 释放上游时**不 await**，不阻塞对外结束 |
| 终止后 | `aborted` 之后没有任何正常事件，也没有 `loop_completed` |
| 并发 | 两个 loop 同时挂起在各自 gateway 上，turn 计数、tool_call id、消息历史、工具结果、signal 全部隔离；取消一个不影响另一个 |

## 8. 凭据与错误安全证明

- `AgentLoopOptions` 上没有任何凭据/传输字段（有源码断言：`apiKey` / `api_key` /
  `authorization` / `headers` / `baseUrl` / `endpoint` 均不出现）。
- 事件流中不出现 secret、URL、Authorization、token、header：恶意工具异常
  （含 `TASK6_SYNTHETIC_PROBE_VALUE`、`/home/user/.ssh/id_rsa`、`https://provider.invalid/v1`、
  伪堆栈）后断言事件 JSON 全部不含。
- 工具结果内容**不进事件**：`tool_execution_completed` 只有 `toolCallId` 与 `isError`。
- 工具异常一律折叠为固定结果 `Tool execution failed.` / `isError: true`，不暴露原始异常。
- 网关错误仍由 Agent Core 清洗，runtime 只**原样转发**已清洗事件；抛出逃逸时使用固定
  `gateway_error` + `Model gateway request failed.`。
- 所有 runtime 错误消息都是固定文案，不回显工具 input、异常文本、URL、token 或配置值。

## 9. Red / Green 真实证据

### Red #1 —— 实现在缺失时

- 命令：`node node_modules/vitest/vitest.mjs run tests/task-6-agent-runtime.test.ts tests/task-6-agent-runtime-security.test.ts tests/task-6-agent-runtime-cancellation.test.ts --reporter=basic`
- 退出码：**1**
- 结果：`Test Files 3 failed (3)`、`Tests 62 failed | 16 passed (78)`
- 关键输出：`Cannot find module '../packages/agent-runtime/src/index.js'`（2 个 suite 收集失败）
  + 15 个 cancellation 用例单独失败

### Red #2 —— 对"非实现 stub"的行为级失败

仅创建包骨架（真实 `types.ts` / `errors.ts` / `index.ts` + 只做选项校验、**不做任何编排**的
`agent-loop.ts`），`typecheck` 0，然后运行同一组测试：

- 退出码：**1**
- 结果：`Test Files 3 failed (3)`、`Tests 62 failed | 16 passed (78)`
- 失败原因（真实行为断言，非"模块不存在"）：
  - `expected [] to have a length of 1 but got +0`（11 处：缺失 `turn_started` / `text_delta` /
    `tool_call` / `error` / `loop_completed` 等）
  - `expected undefined to deeply equal { role: 'tool', …(1) }`（assistant/tool 消息未追加）
  - `expected undefined to match object { code: 'invalid_tool_call' }`（非法 tool_call 未被拒绝）
  - `expected undefined to match object { code: 'duplicate_tool_call_id' }`
  - `expected undefined to match object { code: 'gateway_error', …(2) }`
  - `expected [] to have a length of 3 but got +0`（`turn_started` 轮次计数）
  - 13 处 `Test timed out in 5000ms`（取消类用例：stub 不结束 loop，`until()` 无法满足）

### Green

- 实现后 `typecheck`：**0**
- Task 6 聚焦测试：退出码 **0**，`Test Files 3 passed (3)`、`Tests 78 passed (78)`
- 全量：退出码 **0**，`Test Files 21 passed (21)`、`Tests 566 passed (566)`（488 → 566，新增 **78**，要求 ≥35）

Green 过程中修正了 4 个真实问题：

1. 遗漏 `completed` 事件（该轮模型响应完成时未向调用方输出）；
2. `AGENT_LOOP_ERROR_MESSAGES` 缺少 `gatewayFailure` 条目（typecheck 抓到）；
3. 测试把 `{ content: "x" }` 误列为非法结果（其实是合法结果）；
4. 两个取消用例存在竞态（用 `hangingExecutor` 与显式 `deferred` 改成确定性）。

## 10. 受控变异结果

对 `packages/agent-runtime/src/agent-loop.ts` 逐个施加变异，跑完即还原；脚本与备份已删除，
`grep MUTATION` 在 `packages/` 中命中数为 **0**。

| # | 变异 | 退出码 | 失败用例数 | 代表性失败断言 |
|---|---|---:|---:|---|
| M1 | 删除 `maxTurns` 预算守卫 | 1 | 1 | `refuses to execute tools when the budget is exhausted` |
| M2 | 删除 tool_call id 唯一校验 | 1 | 2 | `rejects a duplicated tool call id inside one turn`、`… reused by a later turn` |
| M3 | 删除未知工具守卫 | 1 | 1 | `refuses a tool that the request never declared` |
| M4 | 不再把 AbortSignal 传给 Executor | 1 | 1 | `forwards the abort signal to the tool executor`（`signals[0]` 不等） |
| M5 | 一批工具并发启动 | 1 | 1 | `executes several tool calls strictly serially and in order`（`maxConcurrent` ≠ 1） |
| M6 | 把工具结果内容放进完成事件 | 1 | 8 | `does not put tool result content into the completion event` 等 |
| M7 | 非法 tool input 静默替换为 `{}` | 1 | 3 | `rejects a non JSON tool input instead of replacing it` 等 |
| M8 | 工具执行中取消后继续下一轮 | 1 | 5 | `does not start a second turn after an abort` 等 |

**8/8 变异均被检出**，没有出现"不失败"的变异。

另有一项**如实说明**：把 Executor 的 rejection 原因写回 `tool_result` 的变异**不会被任何事件
断言检出**——因为工具结果从来不走事件通道，只出现在下一轮 `ModelRequest` 里。该通道由
Agent Core 的请求校验（`validateModelRequest`）与下一轮请求结构断言覆盖，而不是事件断言。

## 11. 验证命令与退出码

| 命令 | 退出码 | 关键输出 |
|---|---:|---|
| `corepack pnpm install --frozen-lockfile` | **0** | `Lockfile is up to date` |
| `corepack pnpm verify:layout` | **0** | 通过 |
| `corepack pnpm typecheck` | **0** | 无错误 |
| `corepack pnpm test` | **0** | `Test Files 21 passed (21)` / `Tests 566 passed (566)` |
| `corepack pnpm security:scan` | **0** | `security:scan passed (N files scanned…)` |
| `corepack pnpm evals:deterministic` | **0** | stage 1 84 files；stage 2 四组场景（Task 3/4/5/6）全部通过 |
| Task 6 聚焦测试 | **0** | `Tests 78 passed (78)` |
| `git diff --check` / `git diff --cached --check` | **0** / **0** | 无空白错误 |

> 报告文件缺失时 `evals:deterministic` 曾**真实失败**（exit 1，`AssertionError:
> docs/verification/task-6-report.md must exist`），证明该入口不是硬编码 passed。

## 12. 测试文件与测试总数

| 范围 | 文件数 | 测试数 |
|---|---:|---:|
| 基线（Task 0–5） | 18 | 488 |
| Task 6 新增 | 3 | **78** |
| 合计 | **21** | **566** |

## 13. 包依赖与边界证明

- `agent-runtime` 的 `dependencies` 恰为
  `@agent-workbench/agent-contracts` + `@agent-workbench/agent-core`；无 `devDependencies`。
- **不依赖** `@agent-workbench/model-gateway`、**不依赖** `@agent-workbench/provider-registry`。
- `agent-core` 与 `model-gateway` 的清单中均不含 `agent-runtime`（有测试断言）。
- `agent-runtime/src` 中不存在 `from "../../…"` 或 `from "../agent-…"` 这类跨包穿透导入（有测试断言）。
- `agent-runtime/src` 中不存在 `fetch(`、`node:http`、`node:https`、`node:fs`、
  `node:child_process`、`WebSocket`、`process.env`、`keytar`、`sqlite`、`require(`（有测试断言）。
- 依赖新增仅 1 个 workspace 包；未引入任何第三方运行时依赖，`pnpm-lock.yaml` 只增加
  importer 与本地链接。

## 14. Git commit hash、parent hash 与 status

- 提交信息：`feat(runtime): add bounded agent loop and tool execution boundary`
- **父提交必须为** `8fefff72baf51025bed44346c68e9a0fea79170c`
- 提交对象：见 §16（"提交对象与恢复命令"）
- 未跟踪：只有 `.superpowers/`（未修改、未暂存、未提交）
- `.superpowers/`、`node_modules`、构建产物、凭据均未进入暂存区；未使用 `git add .`

## 15. 未实现范围

shell 工具、文件读写工具、网络工具、`child_process`、`fs`、HTTP Server、
Local Agent API、CLI、Tauri/Desktop、Provider / Route / Credential 持久化、
SQLite、OS Keychain、Memory、上下文压缩、审批 UI、自动批准策略、
真实供应商调用与真实 API Key、新的重试与故障转移逻辑（沿用 Task 5）、
CC Switch / Claude Code 集成。

## 16. 已知环境问题

1. **Git 嵌套引用无法落盘**：`git commit` 返回 0 并打印提交摘要，但 `.git/refs/` 为空，
   `git rev-parse --verify HEAD` 退出 128，`git status` 显示
   `## No commits yet on workbench/agent-core`。标准命令
   `git update-ref refs/heads/workbench/agent-core <hash> 0000000000000000000000000000000000000000`
   同样返回 0 但不落盘（普通权限与受控权限各一次）。**未手写 refs、未改 HEAD /
   packed-refs / reflog、未 `git init`、未在 unborn HEAD 上创建根提交、未重复提交。**
   完整性校验：工作区与索引都与提交对象一致（`git diff --quiet <hash>` 与
   `git diff --cached --quiet <hash>` 均为空）。

   在可正常写引用的环境执行一次即可恢复：

   ```powershell
   git update-ref refs/heads/workbench/agent-core <hash> 0000000000000000000000000000000000000000
   ```

2. `corepack` shim 在 Git Bash 下路径会被 MSYS 二次转换，需用
   `MSYS2_ARG_CONV_EXCL="*" node "C:/Program Files/nodejs/node_modules/corepack/dist/corepack.js" pnpm …`
   调用同一个 pnpm 12.3.4。
3. pnpm 12 在本机创建目录符号链接会随机失败，`pnpm install` 偶需重试才收敛（本次首次
   即成功）。

## 17. 未做声明

- 未连接真实供应商，未执行真实模型调用；
- 未实现 Local Agent API、CLI、Desktop、审批、持久化、Memory；
- 不宣称"566 个测试通过即代表不存在其他缺陷"；
- 测试中的 gateway 与 ToolExecutor 全部是注入式 fake，无真实网络访问。
