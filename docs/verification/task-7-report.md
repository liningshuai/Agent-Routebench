# Task 7 执行报告：Tool Policy、审批闸门与安全工具执行边界

## 1. 最终状态

**DONE_WITH_CONCERNS**

代码、测试、文档与确定性评测全部完成，全部必需验证命令退出码 0，8 项受控变异
**全部被检出**。唯一 concern 是 Git 分支引用可能需要再次恢复（见 §17）。

## 2. 基线提交

- 分支 `workbench/agent-core`
- 基线 HEAD：**`feaeb9601ecf76d614a4f8783a5c2604c84579bc`**
  （`fix(runtime): accept gateway and executor class instances`）
- 开工前 `git status --short --branch` 只有 `?? .superpowers/`
- 基线验证：`typecheck` 0、`test` 0（21 files / **579** tests）、
  `verify:layout` / `security:scan` / `evals:deterministic` 均 0

## 3. 修改文件清单

| 文件 | 用途 |
|---|---|
| `packages/agent-runtime/src/tool-policy.ts` | **新增**：策略决策、审批闸门、固定结果常量、结构化校验、取消检查 |
| `packages/agent-runtime/src/types.ts` | 新增 `ToolPolicyDecision` / `ToolPolicy` / `ToolApprovalDecision` / `ToolApprovalRequest` / `ToolApprovalHandler` / `GovernedToolExecutorOptions` |
| `packages/agent-runtime/src/index.ts` | 统一导出 Task 7 的类型、常量与工厂 |
| `tests/task-7-tool-policy.test.ts` | 新增 35 个测试：公开面、决策与执行、审批、失败处理、结构化校验、Loop 集成 |
| `tests/task-7-tool-policy-security.test.ts` | 新增 15 个测试：恶意异常清洗、事件无泄露、源码边界、无默认工具 |
| `tests/task-7-tool-policy-cancellation.test.ts` | 新增 12 个测试：预取消、policy / approval / executor pending、late settle、并发隔离 |
| `docs/tool-policy.md` | **新增**：Task 7 完整说明 |
| `docs/verification/task-7-report.md` | **新增**：本报告 |
| `README.md` | 当前阶段更新为 Task 7；文档索引新增两项 |
| `docs/architecture.md` | 新增「Task 7（已完成）」章节 |
| `docs/agent-runtime.md` | 新增 §10「工具策略与审批闸门（Task 7）」 |
| `scripts/evals-deterministic.mjs` | 文件检查 + Stage 2 实跑 Task 7 场景 + 准确文案 |

未修改：`agent-contracts`、`model-gateway` 源码逻辑、`provider-registry`、
Task 1–6 的任何测试、`packages/agent-runtime/src/agent-loop.ts`（Task 6 行为零改动）。
未修改、未暂存、未提交 `.superpowers/`；未访问 `..\cc-switch-agent`。

## 4. 新增公开接口

**类型**：`ToolPolicyDecision`、`ToolPolicy`、`ToolApprovalDecision`、
`ToolApprovalRequest`、`ToolApprovalHandler`、`GovernedToolExecutorOptions`、
`ToolPolicyErrorCode`、`ToolPolicyErrorKey`

**函数**：`createGovernedToolExecutor(options)`

**类**：`ToolPolicyError`

**常量**：`TOOL_POLICY_DENIED_CONTENT`、`TOOL_APPROVAL_UNAVAILABLE_CONTENT`、
`TOOL_APPROVAL_DENIED_CONTENT`、`TOOL_APPROVAL_FAILED_CONTENT`、
`TOOL_POLICY_FAILED_CONTENT`、`TOOL_POLICY_ERROR_CODES`

**错误码**：`invalid_tool_policy_options`

## 5. 默认策略行为

**没有注入 `ToolPolicy` → `deny`**，绝不默认 allow。测试
`denies by default when no policy is injected`、
`does not fall back to allowing when the policy is missing`、
`accepts an options bag without the optional members` 锁定该行为（M1 变异会使其失败）。

## 6. allow / deny / ask 状态机

```text
aborted？              → 固定失败（由 Agent Loop 输出 aborted，不执行）
没有 policy            → deny
policy.decide()
├─ allow               → executor.execute()          （不联系审批处理器）
├─ deny                → TOOL_POLICY_DENIED_CONTENT  （不联系审批处理器、不执行）
├─ ask，无 handler     → TOOL_APPROVAL_UNAVAILABLE_CONTENT
├─ ask
│   ├─ "approved"      → executor.execute()
│   ├─ "denied"        → TOOL_APPROVAL_DENIED_CONTENT
│   └─ 其他任何值      → TOOL_APPROVAL_FAILED_CONTENT
└─ 其他任何值          → TOOL_POLICY_FAILED_CONTENT
```

- 只有**精确字符串** `"approved"` 才放行。`true`、`1`、`"yes"`、`"allow"`、
  `"APPROVED"`、`"approved "`、`null`、`undefined` 一律 `TOOL_APPROVAL_FAILED_CONTENT`。
- policy 返回非法值（`maybe` / `ALLOW` / `1` / `true` / `null` / `undefined` / `{}`）
  一律 `TOOL_POLICY_FAILED_CONTENT`，且不联系审批处理器、不执行。
- 决策**从不缓存**：`re-evaluates the policy on every call instead of caching it`、
  `keeps calling the policy for every tool call of a loop`、
  `evaluates the policy separately for each concurrent loop` 三条锁定（M8 变异会使其失败）。

## 7. 审批取消证明

| 场景 | 断言 |
|---|---|
| 预取消 | `events` 恰为 `[aborted]`；policy / handler / executor 调用数均为 0；gateway 调用 0 |
| policy pending | `policy` 收到的 signal **就是** `controller.signal`；abort 后 `tools.requests` 为 0；恰一个 `aborted`；无 `loop_completed` |
| approval pending | handler 收到同一 signal；abort 后不执行；恰一个 `aborted` |
| 批准后、执行前 | 测试用可手动释放的 approval promise：abort 先落地，随后 `release("approved")`；`tools.requests` 仍为 0，gateway 只被调用 1 次 |
| executor pending / 永不结束 | `hangingExecutor` 永不 settle；abort 后 loop 及时结束，`events.at(-1)` 为 `aborted` |
| late resolve / reject | 三种 late settle（policy reject、approval resolve、executor reject）在 `process.on("unhandledRejection")` 下断言为空 |
| 并发 | 取消第一个 loop 不影响第二个；第二个的 signal 仍是自己的，最终得到 `loop_completed(turns: 2)` |

## 8. class 实例兼容证明

- `accepts class instances for policy, approval handler and executor`：
  断言 `Object.hasOwn(tools, "execute") === false` 且
  `Object.hasOwn(ScriptedPolicy.prototype, "decide") === true`，然后真的执行并返回
  `class-result:read_file`，证明方法是 prototype 上的真·class 方法。
- `accepts an approval handler whose method lives on the prototype`：
  `Object.hasOwn(handler, "requestApproval") === false`，仍能完成 `ask → approved → 执行`。
- `accepts plain objects and null prototype objects`：对象字面量与 `null` 原型对象都可用。
- M7 变异（把 `hasCallableMethod` 改回基于 `Object.getPrototypeOf` 的“普通对象”判定）
  导致 **21 个测试失败**，证明该兼容性是被真实覆盖的。

## 9. 工具不会在未批准时执行的证明

| 情况 | 断言 |
|---|---|
| 无 policy | `tools.requests` 为 0，结果 `isError: true` |
| deny | `tools.requests` 为 0，且 **审批处理器未被联系** |
| ask + denied | `tools.requests` 为 0 |
| ask + 非法值 | `tools.requests` 为 0 |
| ask + 无 handler | `tools.requests` 为 0，内容为 `Tool approval is unavailable.` |
| policy / handler 抛异常 | `tools.requests` 为 0 |
| 未声明的工具 | 由 Task 6 的 `unknown_tool` 先拦截：`tools.requests` 为 0 且 **policy 调用数为 0** |

## 10. 错误和异常清洗证明

恶意对象包含 `TASK7_SYNTHETIC_SECRET`、`https://provider.invalid/v1`、
`Authorization: Bearer TASK7_SYNTHETIC_SECRET`、`/home/user/.ssh/id_rsa` 与伪造 stack：

- policy 抛异常 / reject → `Tool policy evaluation failed.`
- approval 抛异常 / reject → `Tool approval failed.`
- executor 抛异常 → `Tool execution failed.`（Task 6 常量）
- 五个固定常量本身不含任何标记
- Agent Loop 事件 JSON 中不含任何标记（工具结果只进下一轮请求，不进事件）
- M6 变异（把异常 `message` 原样返回给模型）导致 **9 个测试失败**

源码级断言：`agent-runtime` 全目录不含 `fetch(`、`node:http`、`node:https`、
`node:fs`、`node:child_process`、`WebSocket`、`process.env`、`keytar`、`sqlite`、
`require(`、`console.log/error/warn/info`、`localStorage`、`writeFile`、
`appendFile`、`createWriteStream`、`remember`、`alwaysAllow`、`indexedDB`、
`openDatabase`，也不出现 `model-gateway` / `provider-registry` 字样。

## 11. Red / Green 证据

**Red #1（实现不存在）**

命令：`node node_modules/vitest/vitest.mjs run tests/task-7-*.test.ts --reporter=basic`
退出码 **1**，`Test Files 3 failed (3)`、`Tests 58 failed | 4 passed (62)`
关键输出：`TypeError: (0 , createGovernedToolExecutor) is not a function`

**Red #2（对"未实现治理逻辑"的占位模块，行为级失败）**

同一命令，退出码 **1**，`Tests 37 failed | 25 passed (62)`，代表性真实断言：

- `expected { content: 'never' } to deeply equal { …(2) }` ×9（默认未拒绝、deny 仍执行）
- `expected undefined to be true` ×3（`isError` 缺失）
- `Test timed out in 5000ms.` ×3（pending 取消未生效）
- `policy null: expected '<no throw>' to be 'invalid_tool_policy_options'`（非法配置未拒）
- `loop with a hostile tool leaked TASK7_SYNTHETIC_SECRET`（异常原文未清洗）
- `expected undefined to be AbortSignal { aborted: false }`（signal 未传递）

**Green**

`typecheck` **0**；Task 7 聚焦 `Tests 62 passed (62)`；
全量 `Test Files 24 passed (24)`、`Tests 641 passed (641)`。

过程中修正了 4 个真实测试问题：两处断言把合法的 turn 0 `completed` 也算作违规
（改为「aborted 之后不得再有 completed」）；两处安全测试把恶意 input 放进
`tool_call` 事件（该事件本就携带 input），改为把标记只放入工具结果。

## 12. 受控变异结果 —— 8/8 全部被检出

| 变异 | 退出码 | 失败数 | 首个失败用例 |
|---|---:|---:|---|
| M1 默认策略改为 allow | 1 | 3 | `denies by default when no policy is injected` |
| M2 deny 仍调用 executor | 1 | 4 | `never runs the executor when the policy denies` |
| M3 approval denied 仍调用 executor | 1 | 2 | `never runs the executor when the approval is denied` |
| M4 非法审批值视为已批准 | 1 | 1 | `treats every value other than the exact string as a failure` |
| M5 删除 AbortSignal 传递 | 1 | 6 | `receives the abort signal and never runs the tool`（policy） |
| M6 异常原文返回给模型 | 1 | 9 | `never surfaces a throwing policy message or stack` |
| M7 删除 class 实例支持 | 1 | 21 | `runs the executor once when the policy allows` |
| M8 缓存决策复用 | 1 | 20 | `evaluates the policy separately for each concurrent loop` |

变异脚本与备份已删除；`grep MUTATION packages/ tests/` 命中 **0**；
还原后 `typecheck` 0、全量 641 通过。

## 13. 测试数量

| 范围 | 数量 |
|---|---:|
| Task 6 基线 | 21 文件 / 579 测试（全部保持通过） |
| Task 7 新增 | 3 文件 / **62** 测试（35 + 15 + 12） |
| 全量 | **24 文件 / 641 测试** |

## 14. 所有验证命令和退出码

| 命令 | 退出码 | 关键输出 |
|---|---:|---|
| `corepack pnpm install --frozen-lockfile` | **0** | `Lockfile is up to date` |
| `corepack pnpm verify:layout` | **0** | 通过 |
| `corepack pnpm typecheck` | **0** | 无错误 |
| `corepack pnpm test` | **0** | `Test Files 24 passed (24)` / `Tests 641 passed (641)` |
| `corepack pnpm security:scan` | **0** | 通过 |
| `corepack pnpm evals:deterministic` | **0** | stage 1 文件检查；stage 2 五组场景（Task 3/4/5/6/7）全通过 |
| Task 7 聚焦测试 | **0** | `Tests 62 passed (62)` |
| `git diff --check` | **0** | 无空白错误 |
| `git diff --cached --check` | **0** | 无空白错误 |

## 15. 安全扫描结果

`security:scan` 退出码 0。此外 Task 7 自带源码边界断言（见 §10），
覆盖禁止的运行时能力与禁止的持久化/日志能力。

## 16. 包依赖和源码边界

- `agent-runtime` 的 `dependencies` 仍仅 `agent-contracts` + `agent-core`；
  **新增文件不引入任何依赖**，未修改 `package.json` / `pnpm-lock.yaml`。
- `tool-policy.ts` 只从 `./types.js` 与 `./errors.js` 导入，无任何跨包 `src` 穿透。
- `agent-runtime` 源码中不出现 `model-gateway` / `provider-registry` 字样（有断言）。
- `agent-core`、`model-gateway` 均未反向依赖 `agent-runtime`。

## 17. Git commit hash / parent hash / status

提交信息：`feat(runtime): add tool policy and approval gate`

（本节在提交后补全。）

## 18. 未实现范围

审批 UI、审批事件、审批决策持久化、“记住此选择”、自动批准策略、shell / 文件 /
网络工具、`child_process` / `fs` / `fetch` / HTTP Server、Local Agent API、CLI、
Desktop/Tauri、Provider/Route/Credential 持久化、SQLite、OS Keychain、Memory、
上下文压缩、真实供应商调用、真实 API Key。

## 19. 已知环境问题

- `corepack` shim 在 Git Bash 下路径被 MSYS 二次转换，需用
  `MSYS2_ARG_CONV_EXCL="*" node "…/corepack/dist/corepack.js" pnpm …`。
- 本环境的 Git 嵌套引用写入历史上多次失败（Task 4 起反复出现）。若再次出现，
  将如实报告提交对象、父提交与恢复命令，不做任何绕过。
- **不宣称**“641 个测试通过即代表没有其他缺陷”。
