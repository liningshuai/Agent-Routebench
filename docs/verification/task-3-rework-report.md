# Task 3 返工报告：取消、工具关联、SSE 边界与非法参数处理

> 本文件记录对 Task 3 独立验收所提五项缺陷的修复过程。
> 原 Task 3 报告 `docs/verification/task-3-report.md` **保持原样作为历史记录**，
> 本文件说明该报告中哪些结论被验收证据修正。
> 最终 commit hash 见对话回复。

## 1. 结论摘要

| # | 缺陷 | 状态 | 主要修改位置 |
|---|------|------|--------------|
| 1 | 同一 chunk 内取消失效 | 已修复 | `adapters/stream-runtime.ts` |
| 2 | OpenAI 不同 index 复用同一工具 ID | 已修复 | `adapters/openai-chat-stream.ts` |
| 3 | SSE 把后续帧字节计入当前帧限额 | 已修复 | `adapters/sse.ts` |
| 4 | 终止帧后的垃圾污染已完成响应 | 已修复 | `adapters/sse.ts` + `adapters/stream-runtime.ts` |
| 5 | Anthropic 非对象 initial input 被静默替换为 `{}` | 已修复 | `adapters/anthropic-stream.ts` + `adapters/decode-utils.ts` |

## 2. 对原 Task 3 报告的修正

原报告中有四处结论被本次验收证据证明**过强或不准确**，现更正如下：

1. 原报告称「decode 增量输出并支持取消；终止后停止消费并释放上游」。
   **修正**：终止后确实停止消费，但取消检查只覆盖了 chunk 边界；
   取消发生在**同一个 chunk 的帧之间**时仍会继续输出正常事件。
   §6.4 的表述已补充为「覆盖读取 chunk、后续帧、后续事件三个阶段」。

2. 原报告称「单帧上限默认 1 MiB」而实现把未处理的后续帧字节也算进当前帧。
   **修正**：实现与文档口径不一致；现已按「单帧全部行及行结束符（含最终空行）」
   独立计数，并明确「同一 chunk 内多个小帧的总长度可以超过单帧上限」。

3. 原报告称「未知业务事件严格拒绝；截断与不支持内容绝不视为成功」，但
   `parser.push()` 会先解析整个 chunk，导致终止帧**之后**的畸形字节把一次
   已经完成的合法响应变成 `provider_protocol_error`。
   **修正**：新增惰性分帧 `framesFrom()`，解码器到达终止事件后不再解析同一 chunk 的
   剩余字节，也不再读取后续 chunk。

4. 原报告称工具调用「不输出不完整或无效的 tool_call」。
   **修正**：该结论对「参数不完整」成立，但未覆盖
   (a) 不同 index 复用同一工具 ID，
   (b) Anthropic `tool_use.input` 为非法非对象时被静默替换为 `{}`，
   (c) 工具参数中出现 `1e400`→`Infinity` 这类非有限数值。
   三者现已分别拒绝，详见 §6。

原报告中关于「没有真实供应商端到端验证」「工具事件仍是内部数据」
「不宣称具备通用秘密检测能力」等表述本次不作修改，仍然成立。

## 3. 缺陷一：同一 chunk 内取消失效

**原复现**：一个 `Uint8Array` 内包含两个完整 SSE 帧；取到 `text_delta: first` 后
`abort()`，再次 `next()` 仍得到 `text_delta: second`。

**根因**：取消检查集中在 `nextStep()`（chunk 边界）。`parser.push(chunk)` 一次性返回
整个 chunk 的所有帧，驱动循环在帧与事件之间没有重新检查 `AbortSignal`。

**修改位置**：`packages/model-gateway/src/adapters/stream-runtime.ts`

**修复**：驱动循环在三个位置重新检查取消——
读取 chunk 之前、同一个 chunk 内每个帧之前、以及**每次 `yield` 恢复之后**。
取消已发生时不再输出任何正常事件，只输出一个 `aborted` 并结束。
帧内多事件批次仍然整批发出（避免 `usage` + `completed` 被截断），
终止判定在整批之后。悬挂 `next()` 仍可取消，监听器被移除，
上游 `return()` 被调用但不被等待。

**回归用例**（`tests/task-3-adapter-integration.test.ts`）：
`stops an Anthropic chunk at the frame after abort`、
`stops an OpenAI chunk at the frame after abort`、
`suppresses later events produced by one Anthropic terminal frame`、
`suppresses later events produced by one OpenAI tool frame`、
`never emits completed once the signal aborted`、
`does not let a hanging upstream return() block cancellation`。

## 4. 缺陷二：OpenAI 重复工具 ID

**原复现**：同一帧内 `index:0` 与 `index:1` 都声明 `id: "same"`，
输出两个 `tool_call` 并 `completed`。

**根因**：ID 唯一性只在**单个 index 内部**校验（同 index 重复同一 ID 允许、
冲突 ID 拒绝），没有跨 index 校验。

**修改位置**：`packages/model-gateway/src/adapters/openai-chat-stream.ts`（`emitToolCalls`）

**修复**：输出前先对整批（按 index 升序）做完整校验：缺失 id/name、
跨 index 重复 ID、参数解析失败都会在**任何 `tool_call` 被写入事件数组之前**抛出
`provider_protocol_error`。不修改上游 ID。

**回归用例**（`tests/task-3-openai-chat-stream.test.ts`）：
`rejects the same id used by two indexes in one frame`、
`rejects the same id used by two indexes across frames`、
`detects the duplicate even when index 1 arrives before index 0`、
`accepts the same id re-declared for the same index`、
`rejects a conflicting id for the same index`、
`does not emit a first call before discovering the duplicate`、
`never rewrites the upstream tool id to make it unique`。

## 5. 缺陷三：SSE 单帧限额计算错误

**原复现**：`maxFrameBytes: 16` 下，`"data: x\n\ndata: y\n\ndata: z\n\n"`
（每帧 9 字节）抛出 `provider_protocol_error`。

**根因**：`push()` 先把整个 chunk 追加进 `#pending`，再逐行处理；
限额检查使用 `#frameBytes + #pending.length`，而 `#pending` 里还包含**后续帧**的字节。

**修改位置**：`packages/model-gateway/src/adapters/sse.ts`

**修复**：`#pending` 现在只保存**当前帧的未完成行**；每帧独立计数；
检查发生在 dispatch/reset **之前**（因此「加上最终空行才超限」也会失败）；
只缓存当前帧的未完成行，越界在复制进缓存**之前**抛出。

**回归用例**（`tests/task-3-sse.test.ts`）：
`accepts several small frames whose combined size exceeds the frame limit`、
`produces the same frames whatever the chunking`、
`accepts a frame exactly at the limit and rejects one byte over`、
`rejects a frame that only overflows once the final blank line is counted`、
`rejects an unterminated frame that grows past the limit across chunks`、
`counts UTF-8 bytes rather than JavaScript characters`、
`counts supplementary plane characters as four bytes each`、
`restarts the count for the next frame after a frame completes`、
`accepts a large chunk made of many small frames`。

## 6. 缺陷四：终止后的垃圾污染成功响应

**原复现**：一个 chunk 依次包含合法文本帧、`finish_reason: stop`、`[DONE]`、
非法 UTF-8 字节与空行；当前得到 `provider_protocol_error`，连前面的合法文本也没有输出。

**根因**：`parser.push()` 先解析整个 chunk 再返回帧数组，尾部解析错误在解码器处理
终止帧之前就抛出。

**修改位置**：`packages/model-gateway/src/adapters/sse.ts`（新增 `framesFrom()`）
与 `packages/model-gateway/src/adapters/stream-runtime.ts`（改用惰性帧）

**修复**：新增惰性分帧接口；两个协议的 `decode` 都通过它按帧取用。
供应商语义终止后立即 `return`，同一 chunk 的剩余字节不再解析，后续 chunk 不再读取，
上游 iterator 通过 `finally` 释放。`push()` 数组接口保留，内部即
`[...framesFrom(chunk)]`，因此原有调用方行为不变。

**回归用例**：两个协议各 6 项——
`keeps the completed response when invalid utf-8 follows ...`、
`does not parse an oversized trailing frame after ...`、
`keeps a single safe error when garbage follows an upstream error`、
`still reports invalid utf-8 that appears before ...`、
`keeps already emitted text when a malformed frame appears before termination`、
`does not read the next source chunk after ...`；
另有 `exposes a lazy frame view that can be abandoned mid chunk`、
`still raises when the lazy view is driven past the malformed frame`、
`keeps the eager push() array API working`。

## 7. 缺陷五：Anthropic 非法 initial input 被替换为空对象

**原复现**：`content_block_start` 的 `tool_use.input` 为 `[]` 时，
最终输出 `input: {}` 的工具调用与 `completed`。

**根因**：`isPlainObject(contentBlock.input) ? contentBlock.input : {}` 把非法值
静默降级为空对象，等于把一次非法上游负载变成另一次「有效」调用。

**修改位置**：
`packages/model-gateway/src/adapters/anthropic-stream.ts`、
`packages/model-gateway/src/adapters/decode-utils.ts`（共享有限 JSON 校验）

**修复**：

- `tool_use.input` 必须存在且为普通 JSON 对象；`[]` / `null` / `"{}"` / 数字 /
  boolean / 缺失一律 `provider_protocol_error`，失败时无 `tool_call`、无 `completed`。
- 空对象 `{}` 合法；合法非空对象且无 delta 合法。
- 初始对象以 `JSON.stringify(input)` 的 UTF-8 字节长度计入 `maxToolInputBytes`。
- 非空初始对象 + 非空参数 delta = 歧义输入，明确拒绝（不合并、不覆盖）；
  `{}` + delta 继续支持。
- 新增共享 `assertFiniteJsonValue()`：解析后的工具参数必须只含有限数值，
  上游 `1e400` 解析出的 `Infinity` 在**两个协议**中都被拒绝（共享校验，行为不分叉）。

**回归用例**（`tests/task-3-anthropic-stream.test.ts`）：
`rejects a tool_use block whose initial input is not an object`（覆盖 `[]`、`null`、
`"{}"`、`123`、`false`、`"text"`）、`rejects a tool_use block with no input field at all`、
`accepts an empty initial object`、`accepts a non empty initial object with no argument deltas`、
`still supports an empty initial object plus streamed deltas`、
`rejects a non empty initial object combined with argument deltas`、
`rejects an initial object larger than the tool input limit`、
`rejects an initial object containing a non finite number`、
`rejects streamed arguments that parse to a non finite number`、
`rejects streamed arguments that exceed the tool input limit`；
OpenAI 侧：`rejects tool arguments that parse to a non finite number`。

## 8. 分片方式不变性

除分帧层自身的三态一致性用例外，两个协议各新增一条端到端一致性用例
（`produces identical events whatever the chunking of the same stream`）：
同一份字节分别以「整块 / 每帧 / 单字节」送入，解码出的 `ModelStreamEvent` 序列必须相同。

## 9. 兼容性与范围

- `ModelRequest`、`ModelStreamEvent`、`AgentEvent` 字段定义未变。
- Agent Core、Provider Registry、共享契约均未修改。
- `SseFrameParser.push()` 数组接口与已有有效测试保持兼容。
- 未新增第三方运行时依赖；`model-gateway` 仍只依赖 `agent-contracts`。
- 未实现任何 Task 4 内容。

## 10. 未声明的内容

- 不宣称「任意文本都能识别秘密」。
- 不宣称「测试数量通过即证明不存在其他缺陷」。
- 不宣称「Git 命令 exit 0 即证明引用已恢复」。
- 不宣称「本次已完成真实 Provider 端到端验证」。
