# Task 6 最终小修报告：让 Agent Runtime 接受 class 实例的 Gateway / ToolExecutor

## 1. 缺陷复现

**原问题**：`resolveAgentLoopOptions()` 用 `isPlainObject()` 判断注入的 `gateway` 与
`toolExecutor`，而 `isPlainObject()` 只接受 `Object.prototype` 或 `null` 原型的对象。

因此所有 **class 实现** 都被错误拒绝，抛出：

```text
AgentLoopError: Agent loop options are invalid.   (code: invalid_loop_options)
```

受影响的项目自有实现：

| 实现 | 位置 | 是否 class |
|---|---|---|
| `DeterministicFakeModelGateway` | `packages/model-gateway/src/fake-gateway.ts` | 是 |
| `RoutedHttpModelGateway` | `packages/model-gateway/src/routed-http-gateway.ts` | 是 |
| `ResilientRoutedHttpModelGateway` | `packages/model-gateway/src/resilient-routed-gateway.ts` | 是 |

即：把项目自己的任何一个网关交给 `createAgentLoop()` 都会直接失败。Task 6 原有测试
全部使用普通对象字面量 fake，所以没有覆盖到这条路径。

复现命令（修复前）：

```powershell
node node_modules/vitest/vitest.mjs run tests/task-6-agent-runtime.test.ts --reporter=default
```

实测输出：退出码 **1**，`Tests 8 failed | 39 passed (47)`，失败原因均为
`AgentLoopError: Agent loop options are invalid.`，例如：

```text
× accepts a class based ModelGateway
  → expected [Function] to not throw an error but 'AgentLoopError: Agent loop options ar…' was thrown
× runs a text turn through a class based gateway
  → Agent loop options are invalid.
```

## 2. 根因

`ModelGateway` 与 `ToolExecutor` 是**结构化接口**（TypeScript 的 `implements` 只约束形状），
但校验实现把"形状正确"误写成"必须是普通对象字面量"：

```ts
// 修复前
if (!isPlainObject(gateway) || typeof gateway.stream !== "function") { … }
if (toolExecutor !== undefined && (!isPlainObject(toolExecutor) || typeof toolExecutor.execute !== "function")) { … }
```

class 实例的原型是 `MyGateway.prototype`，既不等于 `Object.prototype` 也不是 `null`，
于是 `isPlainObject()` 返回 `false`，校验直接失败。这与 `ModelGateway` / `ToolExecutor`
的结构化边界相矛盾。

## 3. 修复位置

只改了 `packages/agent-runtime/src/agent-loop.ts`（一个文件，两处）：

1. 新增内部辅助函数 `hasCallableMethod(value, method)`：

```ts
function hasCallableMethod(value: unknown, method: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof (value as Record<string, unknown>)[method] === "function";
}
```

2. `resolveAgentLoopOptions()` 改用结构化检查：

```ts
const gateway = (options as { gateway?: unknown }).gateway;
if (!hasCallableMethod(gateway, "stream")) {
  throw agentLoopError("invalidLoopOptions");
}

const toolExecutor = (options as { toolExecutor?: unknown }).toolExecutor;
if (toolExecutor !== undefined && !hasCallableMethod(toolExecutor, "execute")) {
  throw agentLoopError("invalidLoopOptions");
}
```

保持不变的约束：

- `options` 本身**仍然**要求是普通对象（`isPlainObject(options)` 保留）；
- 仍然拒绝 primitive、`null`、数组、缺少方法、方法不是函数的对象；
- 不通过 `Object.getPrototypeOf()` 判断 gateway / executor 是否为普通对象；
- 没有放宽成任意 primitive；
- 没有删除任何非法输入校验。

`isPlainObject()` 仍用于它真正该用的地方（options 包本身、消息/内容块/工具定义/工具结果
的形状判定），共 8 处，`grep` 可查。

收益：`hasCallableMethod` 同时接受普通对象 / `Object.create(null)` 对象 / class 实例，
且只要求"存在可调用方法"，与接口定义一致。

## 4. class Gateway 回归证据

新增测试位于 `tests/task-6-agent-runtime.test.ts` 的
`task 6 runtime — class instances and structural interfaces`（13 个用例）。

**修复前**（Red）：

```text
Tests 8 failed | 39 passed (47)
× accepts a class based ModelGateway
× runs a text turn through a class based gateway
× accepts the project's own DeterministicFakeModelGateway class
× accepts the project's own RoutedHttpModelGateway class offline
× accepts the project's own ResilientRoutedHttpModelGateway class offline
```

**修复后**（Green）：上述 5 个用例全部通过，断言要点：

| 用例 | 关键断言 |
|---|---|
| `accepts a class based ModelGateway` | `createAgentLoop({ gateway })` 不抛出 |
| `keeps the class gateway method on the prototype` | `Object.hasOwn(gateway, "stream") === false` 且 `typeof ClassGateway.prototype.stream === "function"`（证明是真·class 方法） |
| `runs a text turn through a class based gateway` | `textOf(events) === "from-a-class"`、`gateway.calls.length === 1`、末尾 `loop_completed(turns: 1)` |
| `accepts the project's own DeterministicFakeModelGateway class` | 文本 `class-from-the-project` + `loop_completed(turns: 1)` |
| `accepts the project's own RoutedHttpModelGateway class offline` | 文本 `routed-class`、`http.calls() === 1`、`loop_completed(turns: 1)` —— 注入 fake HTTP client，**无真实网络** |
| `accepts the project's own ResilientRoutedHttpModelGateway class offline` | 文本 `resilient-class`、`http.calls() === 1`、`loop_completed(turns: 1)` —— 注入 `wait: async () => undefined`，**无真实等待、无真实网络** |

## 5. class ToolExecutor 回归证据

同一个测试块中：

| 用例 | 关键断言 |
|---|---|
| `accepts a ToolExecutor whose method lives on the prototype` | `Object.hasOwn(toolExecutor, "execute") === false` 且 `typeof ClassToolExecutor.prototype.execute === "function"`；`createAgentLoop` 不抛出 |
| `runs a tool call through a class based executor` | `toolExecutor.requests.length === 1`、`requests[0].id === "call-1"`、最终文本 `done`、`loop_completed(turns: 2)` |
| `appends the class executor result to the next request` | 第二轮请求的第三条消息恰为 `{ role: "tool", content: [{ type: "tool_result", toolCallId: "call-9", content: "class-result:read_file" }] }` |

即：class 执行器不仅能创建 loop，还能真正被调用、结果真正进入下一轮模型请求。

## 6. 仍然拒绝非法对象（未放宽）

| 用例 | 覆盖输入 |
|---|---|
| `still rejects null, arrays and primitives as the gateway` | `null`、`undefined`、`[]`、`"gateway"`、`7`、`true` |
| `still rejects a gateway without a callable stream` | `{}`、`{ stream: 1 }`、`{ stream: "stream" }`、`{ stream: null }`、无方法的 class 实例 |
| `still rejects a non object tool executor` | `null`、`[]`、`"executor"`、`3`、`true` |
| `still rejects a tool executor without a callable execute` | `{}`、`{ execute: 1 }`、`{ execute: {} }`、无方法的 class 实例 |

全部断言 `code === "invalid_loop_options"`。

## 7. 受控变异（证明新断言 load-bearing）

把两处校验**改回** `isPlainObject`（标记 `MUTATION-F1`）后重跑
`tests/task-6-agent-runtime.test.ts`：

```text
### MUTATION-F1 (revert to isPlainObject for gateway/executor) -> exit 1
    failing tests: 8
     - accepts a class based ModelGateway
     - runs a text turn through a class based gateway
     - accepts a ToolExecutor whose method lives on the prototype
     - runs a tool call through a class based executor
     - appends the class executor result to the next request
     - accepts the project's own DeterministicFakeModelGateway class
     - accepts the project's own RoutedHttpModelGateway class offline
     - accepts the project's own ResilientRoutedHttpModelGateway class offline
restored: True | backup gone: True
```

变异已从备份还原，`grep -rn MUTATION packages/ tests/` 命中 **0**，临时备份文件已删除。

## 8. 完整测试结果

| 命令 | 退出码 | 关键输出 |
|---|---:|---|
| `corepack pnpm typecheck` | **0** | 无错误 |
| `corepack pnpm test` | **0** | `Test Files 21 passed (21)` / `Tests 579 passed (579)` |
| `corepack pnpm verify:layout` | **0** | 通过 |
| `corepack pnpm security:scan` | **0** | `security:scan passed (85 files scanned…)` |
| `corepack pnpm evals:deterministic` | **0** | stage 1 84 files；stage 2 四组场景（Task 3/4/5/6）全部通过 |
| Task 6 聚焦测试 | **0** | `Tests 91 passed (91)` |
| `git diff --check` / `git diff --cached --check` | **0** / **0** | 无空白错误 |

测试数量变化：**566 → 579**（本次新增 **13**）。

| 文件 | 本次 | 备注 |
|---|---:|---|
| `tests/task-6-agent-runtime.test.ts` | 47 | 34 → 47（+13） |
| `tests/task-6-agent-runtime-security.test.ts` | 29 | 未变 |
| `tests/task-6-agent-runtime-cancellation.test.ts` | 15 | 未变 |
| Task 6 合计 | **91** | 78 → 91 |

**未修改**：`agent-contracts`、`model-gateway` 源码逻辑、`provider-registry`、
Task 1–5 的任何测试、`scripts/evals-deterministic.mjs`（本次允许清单未包含它）。

行为未变：Agent Loop 轮次编排、取消语义、错误清洗、工具串行执行、消息追加逻辑
一行未动 —— 只有"如何判定注入对象是否合法"这一处判断改变。

## 9. Git 信息

- 基线（本次返工）：`91c17e51eb85f76acae223c52d1e26ac243c6788`
  （本次开工时该引用仍未落盘，但 `git diff --quiet 91c17e5…` 与
  `git diff --cached --quiet 91c17e5…` **均为空**，工作区与索引和该提交对象完全一致）
- 提交信息：`fix(runtime): accept gateway and executor class instances`
- 父提交：**`91c17e51eb85f76acae223c52d1e26ac243c6788`**（非根提交）
- 提交对象 hash：**本报告文件随该提交一起保存，因此不写自身哈希**；最终 hash 在交付回复中给出
- 暂存范围：只含本次允许修改的文件（`git add` 显式列出文件名，未使用 `git add .`）：
  - `packages/agent-runtime/src/agent-loop.ts`
  - `tests/task-6-agent-runtime.test.ts`
  - `docs/agent-runtime.md`
  - `docs/verification/task-6-final-fix-report.md`
- `git status --short --branch`：`## No commits yet on workbench/agent-core`（见 §10 环境问题）
- 未跟踪：仅 `.superpowers/`（未修改、未暂存、未提交）

## 10. 未解决的环境问题

**Git 嵌套引用依旧无法落盘**（Task 3 起第六次复现）：

- `git commit` 返回 0 并打印提交摘要，提交对象确实写入对象库（内容、父链、文件清单均已校验）；
- 但 `.git/refs/` 为空，`git rev-parse --verify HEAD` 退出 128，
  `git status --short --branch` 显示 `## No commits yet on workbench/agent-core`；
- 评审给出的恢复命令 `git update-ref refs/heads/workbench/agent-core <hash> 0000…`
  返回退出码 0，但引用**不落盘**（本次亦按该命令尝试过，结果相同，未恢复）。

**未做任何绕过**：未手写 `.git/refs`、未手工创建 Git 内部目录、未修改 `HEAD` /
`packed-refs` / reflog、未重新 `git init`、未在 unborn HEAD 上创建根提交、未重复提交、
未使用 `reset --hard` / `checkout --` / force push。

在可正常写入嵌套引用的环境执行以下两步即可完成交付（先把分支指到 Task 6 父提交，
再指到本次小修；两条命令都带"原引用必须不存在 / 必须是该值"的前置条件）：

```powershell
git update-ref refs/heads/workbench/agent-core `
  91c17e51eb85f76acae223c52d1e26ac243c6788 `
  0000000000000000000000000000000000000000

git update-ref refs/heads/workbench/agent-core `
  <本次小修 commit hash> `
  91c17e51eb85f76acae223c52d1e26ac243c6788

git log --oneline -3
```

`<本次小修 commit hash>` 由交付回复给出。若只想让分支指向最新状态，直接执行第二条即可
（它的前置条件是父提交，不会覆盖意外出现的其他历史）。

## 11. 结论

```text
原问题：class Gateway / class ToolExecutor 被错误拒绝
修复：改为结构化 callable method 检查（hasCallableMethod）
回归：class Gateway 与 class ToolExecutor 均可正常工作
```

- 13 个新增回归用例全部通过（含项目自有的 `DeterministicFakeModelGateway`、
  `RoutedHttpModelGateway`、`ResilientRoutedHttpModelGateway`，全部离线）；
- 原有 566 个测试全部保持通过（合计 579）；
- 非法输入仍被拒绝，未放宽任何约束；
- 无真实模型调用、无真实网络访问；
- `agent-runtime` 仍只依赖 `agent-contracts` + `agent-core`，不依赖 `model-gateway` /
  `provider-registry`，无跨包 `src` 穿透导入；
- 无凭据或异常消息泄露。

| 项目 | 结果 |
|---|---|
| 缺陷复现 | ✅ 修复前 8 个用例失败，原因为 `invalid_loop_options` |
| 根因 | ✅ 结构性接口被误判为"必须是普通对象" |
| 修复位置 | ✅ 仅 `packages/agent-runtime/src/agent-loop.ts`（新增 `hasCallableMethod` + 两处调用） |
| class Gateway 回归 | ✅ 6 个用例（含 3 个项目自有 gateway） |
| class ToolExecutor 回归 | ✅ 3 个用例（prototype 方法、真调用、结果进入下一轮） |
| 完整测试 | ✅ 21 文件 / 579 测试全绿；typecheck / verify:layout / security:scan / evals 全 0 |
| Git commit hash | ✅ 见交付回复（本报告随提交保存，故不写自身哈希） |
| parent hash | ✅ `91c17e51eb85f76acae223c52d1e26ac243c6788` |
| 未修改范围 | ✅ 见 §8 |
| 未解决的环境问题 | ⚠️ 嵌套 Git 引用无法落盘（见 §10） |
