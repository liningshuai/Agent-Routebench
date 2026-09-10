# Task 3 最后一轮小修报告：取消检查顺序与 CR 跨 chunk 行结束

本文件是 Task 3 的第三份（也是最后一份）验证记录。前两份保持原样作为历史：

- `docs/verification/task-3-report.md`（Task 3 初版实现）
- `docs/verification/task-3-rework-report.md`（返工：五项缺陷）

本文件**不重写历史**，也不声称「缺陷从未发生」。它记录独立验收在上一轮之后新发现的
两个边界缺陷、根因、修正，以及本次修正**证伪了前两份报告的哪些结论**。

---

## 1. 范围

本次只修复两个已复现边界，并完成 Git 交付：

1. **缺陷 A**：取消检查晚于推进 SSE 帧迭代器。
2. **缺陷 B**：单独 CR 跨 chunk 时错误拼接下一行，破坏分片不变性。

没有实现 Task 4，没有新增真实传输、认证、路由调度、多轮 Agent Loop、工具执行、
审批、持久化、Desktop 或 CLI。没有新增第三方运行时依赖，`pnpm-lock.yaml` 未变化。

---

## 2. 缺陷 A：取消检查晚于帧解析

### 2.1 复现

同一个 `Uint8Array` 依次包含：

1. 合法 OpenAI 文本帧（产出 `text_delta: first`）。
2. 非法 UTF-8：`0xff, 0x0a, 0x0a`。

消费者取得 `first` 后 `abort()`，再取下一个事件：

- **期望**：唯一的 `aborted`，随后 `done = true`。
- **实际**：`provider_protocol_error`。

### 2.2 根因

`decodeFrameStream` 用 `for (const frame of parser.framesFrom(chunk))` 遍历帧。

`for...of` 在进入循环体**之前**就会调用帧迭代器的 `next()`。因此当循环体里的
`if (cancelled())` 有机会执行时，下一帧**已经被解析**了。若该帧畸形
（非法 UTF-8、超限未结束帧），解析先抛出 `AdapterStreamError`，被外层 `catch`
转成 `provider_protocol_error`，取消检查永远没机会生效。

特别注意：**不能只在 `catch` 里把协议错误改写成 `aborted`**。那只是掩盖症状，
被取消的消费者仍然解析了本不该解析的字节，而且无法区分「取消」与「客户端自己
驱动了畸形流」。

### 2.3 修正

`packages/model-gateway/src/adapters/stream-runtime.ts`

- 帧迭代器改为**显式驱动**（`parser.framesFrom(...)` + 显式 `next()`），
  取消检查放在 `frames.next()` **之前**。
- 保留「每个事件 yield 恢复之后」的取消检查（帧内多事件抑制）。
- 在 source 读完后、`parser.finish()` 之前也补了一次取消检查。
- 帧迭代器在 `finally` 中 `return()`，放弃当前 chunk 未解析的尾部；
  source 迭代器仍由外层 `finally` 释放。
- 终止事件（`completed` / `error`）已输出后立即 `return`，不再追加 `aborted`。
- 悬挂 `source.next()`、悬挂 `return()`、`AbortSignal` 竞速、上游异常与
  unhandled rejection 处理**全部保持原状**，未削弱。

### 2.4 修正后

- 消费 `first` → `abort()` → 下一个事件恰为 `aborted` → 随后 `done = true`。
- 不再解析同 chunk 的畸形尾部，不再出现 `provider_protocol_error` 或 `completed`。
- **未取消**时行为不变：`first` 保留，随后一个 `provider_protocol_error`。

### 2.5 回归用例

`tests/task-3-adapter-integration.test.ts` → `task 3 final fix — cancellation precedes frame iteration`
（两种协议各覆盖）：

| 用例 | 断言 |
|------|------|
| `aborts instead of parsing trailing invalid bytes in the same chunk` | 剩余事件恰为 `[aborted]`，随后 `done` |
| `aborts instead of parsing an oversized trailing frame in the same chunk` | 同上（`maxFrameBytes: 4096` + 5000 字节未结束帧） |
| `still reports a protocol error for the same chunk when it is not cancelled` | `first` 保留 + 恰一个 `provider_protocol_error` + 无 `completed` |
| `does not advance the frame iterator again after an abort` | 迭代器 spy：取消后推进次数**不再增加** |

---

## 3. 缺陷 B：单独 CR 跨 chunk 拼接错误

### 3.1 复现

```text
data: x\rdata: y\n\n
```

- 整块解析：`x\ny`（正确）。
- 按 CR 后切分 `["data: x\r", "data: y\n\n"]`：实际得到 `xdata: y`（错误）。

### 3.2 根因

`SseFrameParser.framesFrom()` 把 chunk 末尾的 CR 留在 `#pending`，等待下一个 chunk。
但它的 CRLF 判定写成：

```ts
const crlfSplitFromPrefix =
  prefix.length > 0 &&
  prefix[prefix.length - 1] === CR &&
  chunk[found.lineEnd] === LF;   // ← 检查的是「本 chunk 里找到的那个换行符」
```

它检查的是**本 chunk 中下一次找到的行结束符**，而不是**紧邻缓存中那个 CR 的下一字节**。
在 `data: x\rdata: y\n\n` 的第二段里，从下标 0 开始扫描找到的 LF 位于 `data: y` 之后，
与缓存里的 CR 中间隔着 `data: y`；但判定成立，于是代码把上一行减掉 CR 后
直接与 `data: y` 拼接，得到 `data: xdata: y`。

### 3.3 修正

`packages/model-gateway/src/adapters/sse.ts`

- 在 `framesFrom()` 开头新增 **CR 解析块**：若 `#pending` 以 CR 结尾，则由
  **`chunk[0]`** 决定归属——
  - `chunk[0] === LF`：同一个 CRLF 终止符，两字节只计一次，`cursor = 1`；
  - 否则：CR 已单独结束上一行，新 chunk 从下标 0 开始新行；
  - `chunk` 为空：**保持等待**，不丢失状态。
- EOF 路径沿用 `findLineEnd(..., atEof = true)`：单独 CR 正常结束该行，
  随后照常判断帧是否完整（完整帧成功、未完成帧 `provider_protocol_error`）。
- 删除基于「下一个换行符」的错误推断分支 `crlfSplitFromPrefix`。
- 帧字节限额口径不变：每个 CR、LF 只计一次；检查仍发生在 dispatch/reset 之前，
  也仍发生在把尾部复制进缓存之前。
- 惰性分帧、终止后停止解析、取消行为均未改动。

### 3.4 修正后

| 输入 | 整块 | 任意两段切分 | 逐字节 |
|------|------|--------------|--------|
| `data: x\rdata: y\n\n` | `x\ny` | `x\ny` | `x\ny` |
| `data: x\r\ndata: y\n\n` | `x\ny` | `x\ny` | `x\ny` |
| `data: x\r\r\n\n` | `x` | `x` | `x` |
| `data: \u4f60\u597d\rdata: \ud83d\ude80x\n\n` | `\u4f60\u597d\n\ud83d\ude80x` | 同 | 同 |

### 3.5 回归用例

`tests/task-3-sse.test.ts` → `task 3 final fix — CR carries no frame state across chunks`：

| 用例 | 覆盖要求 |
|------|----------|
| `ends the previous line on a lone CR instead of gluing the next line` | 最小复现 + CR 后接非 LF |
| `treats a CRLF pair split across chunks as one terminator` | CRLF 恰好跨 chunk |
| `keeps waiting when an empty chunk follows a trailing CR` | CR 后出现空 chunk |
| `handles a CR that is followed by another CR (blank line)` | CR 后再接 CR |
| `treats a CR at EOF as an ordinary line terminator` | EOF 落在 CR 后：完整帧成功 / 未完成帧失败 |
| `handles mixed LF, CRLF and lone CR line endings` | 三种行结束符混合 |
| `gives the same verdict at the frame limit whatever the chunking` | 限额边界下分片不改变结论（上限 9 通过 / 8 失败） |
| `keeps multi-line CJK and emoji data intact across every chunking` | 中文 + emoji 的字节数与字符数不同 |
| `produces identical frames for every two-way and byte-wise chunking` | 所有两段切分 + 单字节分片，断言实际 data 内容 |

`everyChunking()` 对同一字节流遍历 `whole`、逐字节、以及**全部两段切分位置**，
断言的是**实际 data 字符串**，不是事件个数。

---

## 4. 本次修正证伪了哪些既有结论

| 前两份报告 / 文档的结论 | 本次证据 |
|---|---|
| 返工报告称「取消检查覆盖读取 chunk / 后续帧 / 每次 yield 恢复后」 | 只覆盖「循环体内」，`for...of` 在进入循环体前已推进帧迭代器；同 chunk 畸形尾帧仍会绕过取消并报 `provider_protocol_error` |
| 返工报告称 CRLF 跨 chunk「保持正确」 | 只对「CR 后紧跟 LF」的切分正确；`data: x\rdata: y\n\n` 这类 CR 后接非 LF 的切分被判为 CRLF，产出 `xdata: y` |
| `docs/protocol-adapters.md` 原 §5.2 / §6.4 的相关描述 | 已按修正后行为改写，并新增 §5.3 说明「由紧邻 CR 的下一字节决定」，明确**不得**用「下一个换行符」推断 CRLF |

`docs/protocol-adapters.md` 已同步更新，并在文件开头加入修订记录指向本报告。

---

## 6. 交付状态（Git）

- 分支 `workbench/agent-core` 在本环境中仍为 **unborn**：`git symbolic-ref HEAD` 正常返回
  `refs/heads/workbench/agent-core`，但 `git show-ref` 退出 1（无任何引用），
  `git rev-parse --verify HEAD` 退出 128。
- 按授权执行的受权恢复命令：

  ```text
  git update-ref refs/heads/workbench/agent-core e931482f3745dc00b20c20b82fabaec56f94f2ea 0000000000000000000000000000000000000000
  ```

  命令**退出码为 0**，但随后 `git rev-parse --verify HEAD` 仍退出 128、
  `git show-ref --verify refs/heads/workbench/agent-core` 退出 128、
  `git log --oneline -5` 退出 128、`.git/refs/heads/` 仍为空。
  普通权限与受控权限（工具权限提升流程）各执行一次，结果相同。
  **因此不能仅凭退出码判定恢复成功。**
- 按要求**未使用任何绕行手段**：未手写 `.git/refs`、未直接修改 HEAD / `packed-refs` /
  reflog、未手工创建 Git 内部目录、未重新 `git init`、未创建或切换到其他分支作为替代方案、
  未反复创建临时探针引用。
- 由于 HEAD 仍为 unborn，**没有执行 `git commit`**：此时提交会生成**根提交**，
  丢掉 `e931482f…` 的父链，违反「修复应作为 `e931482f…` 之后的新提交」。
- 代码与测试改动**保留在工作区并已全部 `git add`**，未丢失；只是尚未形成提交。
- 本环境只报告现象，**不断言具体沙箱根因**（缺少对照证据）。

在可正常写引用的环境完成剩余交付（两步）：

```powershell
git update-ref refs/heads/workbench/agent-core e931482f3745dc00b20c20b82fabaec56f94f2ea 0000000000000000000000000000000000000000
git commit -m "fix(gateway): enforce cancellation and SSE chunk boundaries"
```

期望历史：`fa10eab… → e931482f…(Task 3) → <fix>`。

---

## 7. 未做声明

- 不宣称「任意文本都能识别秘密」。
- 不宣称「测试全绿即证明不存在其他缺陷」。
- 不宣称「Git 命令 exit 0 即证明引用已恢复」。
- 不宣称「已完成真实 Provider 端到端验证」——**没有任何真实网络调用**，
  所有 fixture 都是合成字节流。

本次修复的提交哈希在交付回复中给出；由于 Git 引用未能落盘，本报告文件与其余改动
一起保留在工作区/暂存区，尚无提交承载。
