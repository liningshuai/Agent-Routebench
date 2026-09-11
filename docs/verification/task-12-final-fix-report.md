# Task 12 最终小修报告：三个运行时边界问题

## 0. 任务开始时的基线事故与恢复（如实记录）

任务开始执行强制基线检查时发现仓库 Git 状态损坏：

- 分支 `workbench/agent-core` 为**未出生状态**（`.git/refs/heads/workbench/agent-core`
  引用文件丢失，`git rev-parse HEAD` 报 `fatal: Needed a single revision`）；
- 索引为空，全部 178 个跟踪文件显示为未跟踪；
- 工作区残留上一会话的 20 个输出文件（`_gs.txt`、`diag*.txt`、`fixref.txt`、
  `v_*.txt`、`verify_*.txt` 等），且 6 个 Task 12 文件的内容等于对象库中残留的
  上一会话修复提交 `673ccbf`（未进入本任务基线）；
- reflog 显示上一会话在基线之上创建过 `673ccbf`（parent = `26ff3b0e`），
  随后其"修引用"操作把分支引用弄丢。

按任务规定**立即停止、未修改任何文件**，经用户明确授权后执行恢复：

```text
git update-ref refs/heads/workbench/agent-core 26ff3b0e15ac2bbc15e23c844c78d672e239f15a
git reset                                # 仅重建索引
git restore <6 个被上一会话修改的文件>    # 还原为基线版本
rm <20 个上一会话残留 txt 文件>
```

恢复后基线校验通过：分支 = `workbench/agent-core`，HEAD =
`26ff3b0e15ac2bbc15e23c844c78d672e239f15a`，HEAD^ =
`5039ec01a46960bf3338e9ce7302fa4f6a76c5df`，工作区仅剩 `?? .superpowers/`。
对象库中的 `673ccbf` 保留（未被任何引用指向，仅供参考，未参与本次交付）。

## 1. 基线

```text
分支     : workbench/agent-core
HEAD     : 26ff3b0e15ac2bbc15e23c844c78d672e239f15a
父提交   : 5039ec01a46960bf3338e9ce7302fa4f6a76c5df
基线状态 : ?? .superpowers/（唯一未跟踪内容）
```

基线验证（修复开始前，全部真实 exit 0）：

```text
corepack pnpm install --frozen-lockfile  → 0
corepack pnpm verify:layout              → 0
corepack pnpm typecheck                  → 0
corepack pnpm test                       → 0（44 文件 / 1000 测试）
corepack pnpm security:scan              → 0（169 files）
corepack pnpm evals:deterministic        → 0
```

## 2. 三个缺陷及根因

### 缺陷 1：summarizer 同步抛错未被安全清洗

`packages/agent-memory/src/context-builder.ts` 的 `runSummarizer()` 中：

```ts
const pending = Promise.resolve(
  summarizer.summarize(...),   // 在被 Promise.resolve() 包裹前同步执行
);
```

`summarize()` 同步 throw 时，原始异常（message、stack、URL、secret）直接逃逸，
不会被折叠为 `context_compression_failed` / `Context compression failed.`。

### 缺陷 2：非法 AbortSignal 未被拒绝

`packages/agent-memory/src/context-validation.ts` 的 `parseBuildOptions()` 中：

```ts
if (signal !== undefined && signal !== null) { ... }
```

- `signal: null` 完全绕过校验，随后 `isAborted()` 里 `null.aborted` 触发原生
  `TypeError`；
- `{ aborted: false }` 之类伪 signal 通过校验（只查了 `aborted` 是否 boolean），
  取消路径调用 `signal.addEventListener(...)` 时抛原生 `TypeError`；
- 旧代码还以 `signal as AbortSignal` 直接断言绕过形状检查。

### 缺陷 3：Context MemoryEntry 校验不完整

`assertMemoryEntry()` 只检查了 `Array.isArray(input.tags)` 与各字段的基础类型，
缺少与 Memory Store 对齐的完整约束：id/scopeId 格式（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`）、
content 16 KiB UTF-8 上限与 `\0`、tag 元素类型/非空/去重/128 字节/16 个上限等。
非法 entry（如 `tags: [123]`、`id: "../evil"`、超长 content）可原样注入上下文。

## 3. 实际修改文件（全部在允许清单内）

```text
packages/agent-memory/src/context-builder.ts        修复 1
packages/agent-memory/src/context-validation.ts     修复 2 + 修复 3
tests/task-12-context-compaction.test.ts            新增 3 个测试（同步抛错）
tests/task-12-context-cancellation.test.ts          新增 8 个测试（signal 校验）
tests/task-12-memory-security.test.ts               新增 21 个测试（entry 校验）
tests/helpers/memory-fixtures.ts                    新增 makeMemoryEntry() 工厂
docs/memory.md                                     补充三个边界的文档
docs/verification/task-12-final-fix-report.md       本报告
```

## 4. 同步 summarizer 异常修复说明

`runSummarizer()` 中把同步调用包进 try/catch，同步 throw 统一
`failContext("compressionFailed")`（code = `context_compression_failed`，
message = `Context compression failed.`，均不回显原始异常任何内容）：

```ts
let pending: Promise<string>;
try {
  pending = Promise.resolve(
    summarizer.summarize(
      { messages: structuredClone(omitted), omittedMessageCount: omitted.length },
      signal,
    ),
  );
} catch {
  failContext("compressionFailed");
}
```

- 异步 reject 路径（无 signal 的 `await pending` catch、有 signal 的 race
  `err` 分支）保持原样，继续折叠为同一固定错误；
- cancellation / late resolve / late reject（`pending.then(undefined, () => undefined)`
  兜底消费）行为不变；
- class summarizer（实例方法同步 throw）同样被清洗。

## 5. 非法 AbortSignal 修复说明

新增运行时形状校验 `isAbortSignalLike()`，`parseBuildOptions()` 中
`signal !== undefined` 时必须通过校验，否则 `invalid_context_options`
（message 固定 `Context options are invalid.`，不回显传入对象）：

```ts
function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { aborted?: unknown; addEventListener?: unknown };
  return (
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function"
  );
}
```

- `undefined` 合法；原生 `AbortController().signal` 合法；
- `null` / `{}` / `{aborted:false}` / `{aborted:false,addEventListener:1}` /
  `{aborted:"false",addEventListener(){}}` 全部拒绝；
- 返回值改用校验后的 `validatedSignal`，删除了旧的 `signal as AbortSignal`
  断言绕过；
- 本实现未使用 `removeEventListener()` 清理监听器（监听器以 `{once:true}`
  挂载），故按任务规定未强制校验该方法。

## 6. MemoryEntry 完整校验说明

`assertMemoryEntry()` 补齐与 Memory Store（`memory-store.ts` 的
`ID_PATTERN` 与默认限制）对齐的约束，全部失败路径统一
`invalid_context_memory` / `Context memory is invalid.`，不回显被拒值：

| 字段 | 校验 |
|------|------|
| `id` / `scopeId` | 非空且匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（≤64 字符；字符集天然排除 `\0`） |
| `kind` | 仅 `fact` / `preference` / `decision` / `todo` |
| `content` | 非空、无 `\0`、UTF-8 字节数 ≤ `DEFAULT_MAX_MEMORY_CONTENT_BYTES`（16 KiB），超限抛错不截断 |
| `tags` | 数组且 ≤ `DEFAULT_MAX_MEMORY_TAGS`（16）个；元素必须是非空字符串、无 `\0`、≤ `DEFAULT_MAX_MEMORY_TAG_BYTES`（128）UTF-8 字节；不允许重复；不静默过滤 |
| `createdAt` / `updatedAt` | 有限 number（拒绝 `NaN` / `±Infinity` / 字符串 / boolean） |
| 字段白名单 | 仅允许 7 个已知字段；未知字段与敏感字段（`apiKey`/`token`/`authorization`/`headers`/`password`/`secret`/`credential` 等，含大小写归一）一律拒绝 |

## 7. Red 阶段真实输出

先写测试再改实现。聚焦运行（3 个测试文件，生产代码未动）：

```text
命令: corepack pnpm vitest run tests/task-12-context-compaction.test.ts \
      tests/task-12-context-cancellation.test.ts tests/task-12-memory-security.test.ts

Test Files  3 failed (3)
     Tests  21 failed | 53 passed (74)
EXIT=1
```

关键行为级失败证据（真实断言消息）：

```text
同步 summarizer 异常未清洗（3 个）:
  expected Error: RAW_SECRET sk-live-abcdef https://… to be an instance of ContextError
  expected Error: RAW_SECRET class leak https://evil… to be an instance of ContextError
  expected Error: RAW_SECRET with-signal https://evi… to be an instance of ContextError

signal: null 未返回固定错误（1 个）:
  expected TypeError: Cannot read properties of null… to be an instance of ContextError

伪 signal 被接受（2 个）:
  {aborted:false} / {aborted:false,addEventListener:1} → expected { … } to be undefined
  （构建成功返回，而非拒绝）

非法 MemoryEntry 绕过校验（15 个）:
  数字/boolean/null/对象/嵌套数组 tag、空 tag、重复 tag、含 \0 tag、
  超 128 字节 tag、超 16 个 tags、非法 id、超 64 字符 id、非法 scopeId、
  超 16 KiB content、含 \0 content、错误信息回显检查
  → 全部 expected { messages: [ { …(2) } ], …(5) } to be undefined
    （非法 entry 被原样注入上下文并成功构建）
```

守卫测试（原生 signal、既有取消/late rejection、合法与边界 entry、
NaN/Infinity、未知/敏感字段）在 Red 阶段即通过，证明既有行为未被破坏。

## 8. Green 阶段真实输出

实现三个修复后，同一聚焦命令：

```text
Test Files  3 passed (3)
     Tests  74 passed (74)
EXIT=0

corepack pnpm typecheck → 0
```

全量回归：

```text
Test Files  44 passed (44)
     Tests  1032 passed (1032)
EXIT=0
```

## 9. 受控变异逐项结果

每项均为：临时修改 → 运行对应测试（记录真实退出码与失败数）→ 反向编辑完整恢复 →
重跑聚焦测试确认 74/74。共 8 项，全部检出：

| # | 变异内容 | 运行文件 | 真实结果 | 退出码 |
|---|----------|----------|----------|--------|
| 1 | 删除同步 summarizer 调用的 try/catch（恢复裸调用） | compaction | 3 failed（同步抛错 3 测试） | 1 |
| 2 | `isAbortSignalLike` 把 `null` 当合法 signal | cancellation | 1 failed（复现原生 TypeError） | 1 |
| 3 | 只检查 `aborted` boolean，删除 `addEventListener` callable 校验 | cancellation | 2 failed（仅有 aborted / addEventListener 非函数） | 1 |
| 4 | 删除 tag 元素类型校验（非字符串 tag 放行） | security | 4 failed（数字/boolean/null/对象 tag） | 1 |
| 5 | 删除重复 tag 校验 | security | 1 failed（重复 tag） | 1 |
| 6 | 删除 content UTF-8 16 KiB 字节限制 | security | 1 failed（超限 content） | 1 |
| 7 | 删除 id/scopeId 格式校验（退回仅非空检查） | security | 4 failed（非法 id / 超长 id / 非法 scopeId / 回显检查） | 1 |
| 8 | 把 summarizer 原始异常 message 写入错误 | compaction | 3 failed（message 含 RAW_SECRET/evil.invalid，非固定文案） | 1 |

全部恢复后：

```text
聚焦测试: 74 passed (74), EXIT=0
typecheck: EXIT=0
grep -rn "MUTATION" packages/ tests/ scripts/ → 0 命中
  （docs/verification/ 中命中的是基线既有的 task-5/6/7 历史报告文字，非本次残留）
无 .bak / 备份 / 临时文件残留
```

## 10. 未检出的变异

无。8/8 全部被新增测试检出。

## 11. 聚焦测试数量

```text
tests/task-12-context-compaction.test.ts   25（既有 22 + 新增 3）
tests/task-12-context-cancellation.test.ts 18（既有 10 + 新增 8）
tests/task-12-memory-security.test.ts      31（既有 10 + 新增 21）
合计                                       74（新增 32）
```

## 12. 全量测试数量

```text
小修前: 1000（44 文件）
小修后: 1032（44 文件，+32 全部为本次新增测试）
```

## 13. 全部验证命令和退出码（最终序列）

```text
corepack pnpm install --frozen-lockfile   → 0
corepack pnpm verify:layout               → 0
corepack pnpm typecheck                   → 0
corepack pnpm vitest run <task-12 三个文件> → 0（3 文件 / 74 测试）
corepack pnpm test -- <task-12 三个文件>   → 0（该形式在本机 pnpm 12.3.4 下
                                            不过滤参数，实际执行全量 44 文件 /
                                            1032 测试，为聚焦的超集）
corepack pnpm test                        → 0（44 文件 / 1032 测试）
corepack pnpm security:scan               → 0（169 files scanned）
corepack pnpm evals:deterministic         → 0（stage 1: 163 文件；
                                            stage 2: task 3–12 共 11 个场景通过）
git diff --check                          → 0（仅 docs/memory.md 的 LF→CRLF
                                            Windows 常规换行提示，无空白错误）
git diff --cached --check                 → 提交前执行（见第 18 节后验证）
```

## 14. 是否修改其他 Task

否。仅修改第 3 节列出的允许清单文件；未触碰
agent-contracts / agent-core / agent-runtime / model-gateway / provider-registry /
provider-discovery / local-persistence / local-agent-api / session-persistence、
memory-store.ts / types.ts / errors.ts / index.ts、package.json、pnpm-lock.yaml、
README、docs/architecture.md、scripts/*。未实现 Task 13 及任何新功能。

## 15. 是否访问网络

无。无网络请求、无真实 Provider 调用、无真实模型调用。所有 summarizer 均为测试注入的假实现。

## 16. 是否访问真实凭据

无。未读取 `process.env`，未访问 CredentialStore，测试中的 secret 均为合成标记字符串。

## 17. 是否修改 `.superpowers/`

未修改、未暂存、未提交。最终工作区唯一未跟踪内容仍为 `?? .superpowers/`。

## 18/19/20. Git 提交

```text
Commit message: fix(memory): harden context validation boundaries
Parent        : 26ff3b0e15ac2bbc15e23c844c78d672e239f15a
```

本报告文件随该提交一起创建，无法在提交前写入自身 hash；提交后的
`git rev-parse --verify HEAD`、`git show -s --format=fuller HEAD`、
`git diff-tree --no-commit-id --name-status -r HEAD` 与 `git status --short --branch`
已在交付信息中如实报告并验证（parent 必须且已是 `26ff3b0e`）。

## 21. 剩余 concern

1. 对象库中残留上一会话的孤儿提交 `673ccbf`（无引用指向）。它不影响本交付，
   未来 `git gc` 可能将其清除；如需引用请自行决定。
2. `corepack pnpm test -- <files>` 在本机 pnpm 12.3.4 / vitest 组合下不过滤参数
   （执行全量）。等效过滤命令为 `corepack pnpm vitest run <files>`。两种形式
   本次均通过。
3. signal 校验未强制 `removeEventListener` 为 callable：当前实现以 `{once:true}`
   挂载监听器、不调用 `removeEventListener`，按任务规定仅在实现使用该方法时才需校验。
   若未来实现改为显式移除监听器，需同步补该校验。
4. `docs/memory.md` 触发的 LF→CRLF 提示为 Windows 下 `core.autocrlf` 常规行为，
   非空白错误（`git diff --check` exit 0）。
5. 本报告不声称：已实现真实模型摘要 / Memory 持久化 / 真实 Provider 连接；
   不声称所有异常都能被任意文本扫描识别（清洗依赖固定文案错误与字段白名单，
   非内容扫描）；不声称"测试全绿即不存在其他缺陷"。
