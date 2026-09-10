# Task 3 协议适配器说明

本文件记录本阶段实现的两种模型协议 codec：请求转换（`encode`）与 SSE 流式解析
（`decode`）。**本阶段没有任何真实传输**：不建立连接、不注入认证、不做路由调度。

> 修订记录：本文件在 Task 3 返工（`docs/verification/task-3-rework-report.md`）与
> 最后一轮小修（`docs/verification/task-3-final-fix-report.md`）后更新。
> §5.3 与 §6.4 记录的是**修正后**的行为；此前版本的「下一个换行符即 CRLF」推断
> 与「帧迭代器先推进再检查取消」的顺序都已被证伪，详见最终修复报告。

## 1. 官方资料与查阅日期

查阅日期：**2026-09-10**（本机时区 GMT+8）。

| 协议 | 资料 |
|------|------|
| Anthropic Messages streaming | https://platform.claude.com/docs/en/build-with-claude/streaming |
| Anthropic Messages（请求结构） | https://platform.claude.com/docs/en/api/messages |
| OpenAI Chat Completions 请求结构 | https://developers.openai.com/api/reference/resources/chat |
| OpenAI Chat Completions streaming events | https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events |

### 1.1 官方协议事实（本实现依据）

Anthropic Messages 流式事件生命周期：

1. `message_start`（携带 `message.usage.input_tokens` / `output_tokens`）
2. 若干 `content_block_start` → `content_block_delta` → `content_block_stop`
3. 若干 `message_delta`（`delta.stop_reason`；`usage.output_tokens` 为**累计值**）
4. `message_stop`
5. `ping` 可穿插出现；`error` 可能中断流

`content_block_delta.delta` 的官方子类型：`text_delta`(`text`)、`input_json_delta`
(`partial_json`)、`thinking_delta`(`thinking`)、`signature_delta`(`signature`)。
`tool_use` 块的参数以 `partial_json` 分片下发，客户端需自行累积并在块结束时解析为
JSON 对象。官方示例的 `stop_reason` 取值包括 `end_turn` 与 `tool_use`；
`cache_creation_input_tokens` / `cache_read_input_tokens` 会出现在 `usage` 中。

OpenAI Chat Completions 流式 chunk（`chat.completion.chunk`）：

- 顶层：`id`、`object`、`created`、`model`、`choices[]`、`usage?`、`service_tier?`
- `choices[]`：`index`、`delta`、`logprobs?`、`finish_reason`
- `delta`：`role?`、`content?`、`refusal?`、`tool_calls?`（另有已废弃的 `function_call`）
- `tool_calls[]`：`index`、`id?`、`type: "function"?`、`function.name?`、`function.arguments?`
- `finish_reason`：`stop`、`length`、`tool_calls`、`content_filter`（`function_call` 已废弃）
- `stream_options.include_usage: true` 时，会在 `data: [DONE]` 之前额外发送一个
  `choices` 为空数组、仅携带 `usage` 的 chunk
- `max_tokens` 已废弃，新模型推荐 `max_completion_tokens`

### 1.2 本项目主动限定的兼容范围

以下限制是本项目的产品决定，不是协议事实：

- 只支持**流式**（`stream: true`），不支持非流式补全。
- 只支持**文本**与**客户端函数工具**；不支持多模态、音频、图片、文件。
- OpenAI 侧只支持 `n = 1`、`choice.index = 0`。
- Anthropic 侧不启用 prompt caching；`thinking` / `signature` 与服务端工具
  （`server_tool_use`、`web_search_tool_result` 等）一律视为不支持。
- 未知业务事件一律**严格拒绝**（`provider_protocol_error`），不静默丢弃。

### 1.3 尚未验证的供应商行为

本项目**没有对任何真实供应商端点做过验证**。第三方兼容实现可能在字段缺失、
事件顺序、`finish_reason` 取值、错误对象形状上与官方文档存在差异；这些差异
本阶段一律按不支持处理，而不是猜测兼容。

## 2. 公开接口

```ts
import type {
  JsonValue,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";

export interface EncodedModelRequest {
  readonly body: { readonly [key: string]: JsonValue };
}

export interface StreamDecodeOptions {
  readonly signal?: AbortSignal;
  readonly maxFrameBytes?: number;      // 默认 1 MiB
  readonly maxToolInputBytes?: number;  // 默认 1 MiB
}

export interface ProtocolAdapter {
  encode(request: ModelRequest): EncodedModelRequest;
  decode(
    source: AsyncIterable<Uint8Array>,
    options?: StreamDecodeOptions,
  ): AsyncIterable<ModelStreamEvent>;
}

export interface OpenAIChatAdapterOptions {
  readonly tokenLimitField?: "max_tokens" | "max_completion_tokens";
}

export function createAnthropicMessagesAdapter(): ProtocolAdapter;
export function createOpenAIChatCompletionsAdapter(
  options?: OpenAIChatAdapterOptions,
): ProtocolAdapter;
```

`encode` 是同步纯转换：不做 I/O、不返回 URL / headers / `credentialRef` / 认证信息，
也不会把 `requestId`、`routeId` 发给 Provider。

`decode` 是真正的增量解析：不先收集完整 source；每次调用独立维护解析状态，因此同一个
adapter 实例可以并发使用。

## 3. 请求字段映射

### 3.1 Anthropic Messages

| 内部 | Provider 字段 |
|------|---------------|
| `request.model` | `model` |
| `request.maxTokens` | `max_tokens` |
| — | `stream: true` |
| 历史开头的 `system` 文本 | 顶层 `system`（字符串；无 system 时省略） |
| `user` 文本块 | `messages[].role = "user"`，`content[].type = "text"` |
| `assistant` 文本块 | `messages[].role = "assistant"`，`content[].type = "text"` |
| `assistant` `tool_call` | `content[].type = "tool_use"`，保留 `id` / `name` / `input` |
| `tool` `tool_result` | `role = "user"` + `content[].type = "tool_result"`，保留 `tool_use_id` / `content` / `is_error` |
| `request.tools` | `tools[].{name, description, input_schema}`（`tools` 为空时省略整字段） |

合并规则：同一消息内相邻 `text` 块按原顺序连接（不插入未声明的文字）；转换后
**连续同角色消息合并为一个 content 数组**。消息顺序不发生改变。

### 3.2 OpenAI Chat Completions

| 内部 | Provider 字段 |
|------|---------------|
| `request.model` | `model` |
| `request.maxTokens` | `max_tokens`（默认）或 `max_completion_tokens` |
| — | `stream: true`、`n: 1`、`stream_options: { include_usage: true }` |
| `system` 文本 | `{ role: "system", content }` |
| `user` 文本 | `{ role: "user", content }` |
| `assistant` 文本 + `tool_call` | `{ role: "assistant", content, tool_calls[] }` |
| `tool_result` | `{ role: "tool", tool_call_id, content }`（每个结果一条消息） |
| `request.tools` | `tools[].{type: "function", function: {name, description, parameters}}` |

- 纯工具调用的 assistant 消息允许 `content: null`。
- `function.arguments` 为 `JSON.stringify(input)`。
- `tokenLimitField` 只输出被选中的那一个字段，**两个字段绝不共存**；不会根据模型
  名称猜测参数。该选项只表示字段选择能力，**不代表支持所有 OpenAI 模型**。
- 与 Anthropic 不同，本项目在 OpenAI 侧**不做同角色消息合并**，以保证
  `tool_call_id` 与 `tool` 消息的一一对应关系清晰可查。

### 3.3 OpenAI 工具结果 JSON 信封（项目约定）

Chat Completions 没有与 `tool_result.isError` 完全等价的统一字段。本项目将工具结果
编码为固定 JSON 信封，写入 `role: "tool"` 消息的 `content`：

```json
{"content":"原工具结果","isError":false}
```

```json
{"content":"原工具结果","isError":true}
```

这是**本项目的转换约定**，不是上游字段；不会添加非标准的 `is_error` 字段。
该约定由 `tests/task-3-adapter-requests.test.ts` 锁定。

## 4. 支持与不支持

支持：

- `anthropic_messages`：流式文本、客户端 `tool_use`、`usage`、`end_turn` / `tool_use` 结束。
- `openai_compatible`（Chat Completions）：流式文本、function tools、`usage`、
  `stop` / `tool_calls` 结束、`[DONE]` 终止。

明确不支持（遇到即返回固定协议错误，不静默丢弃）：

- OpenAI Responses API、Codex OAuth / ChatGPT 订阅登录、Gemini。
- 多模态、音频、图片、文件输入输出。
- reasoning / thinking 内容的完整保存与回放（Anthropic `thinking_delta`、
  OpenAI `reasoning` / `reasoning_content`）。
- 服务端工具与搜索工具（`server_tool_use` / `web_search_tool_result`）。
- Anthropic prompt caching（出现非零缓存计数即报错，避免给出误导性的总 token 数）。
- OpenAI 旧版 `function_call`、`refusal`、`n > 1`、`choice.index != 0`。
- 截断结束（Anthropic `max_tokens`；OpenAI `length` / `content_filter`）。
- 真实 HTTP 传输、认证头注入、URL 拼接、探活、模型列表、路由调度、重试、故障转移。

## 5. SSE 分帧与资源限制

共享 `SseFrameParser` 负责字节 → 帧；供应商解码器只负责帧内 JSON 语义。

- 使用流式 `TextDecoder`（`fatal: true`）；非法 UTF-8 → `provider_protocol_error`。
- 支持 UTF-8 多字节字符跨 chunk、一帧跨多 chunk、一个 chunk 含多帧。
- 支持 LF、CRLF 与单独 CR；CR 与 LF 落在不同 chunk 时仍算同一个 CRLF 终止符（见 §5.3）。
- 支持多行 `data:`（以 `\n` 连接）、以 `:` 开头的注释行、`event` / `id` / `retry` 字段。
- 空行结束一帧。注释、`ping`、`id`、`retry` 永远不会成为模型文本。
- 只派发至少包含一个 `data` 字段且数据非空的帧。
- **最终业务帧必须由空行结束**；EOF 时残留半帧按截断处理（`provider_protocol_error`）。
- 工具参数累积上限默认 **1 MiB**；上限必须是正的安全整数，否则 `invalid_adapter_options`。

### 5.1 单帧字节上限口径

`maxFrameBytes`（默认 **1 MiB**）限制的是**单个帧**，不是单个 source chunk：

- 一帧的大小 = 该帧全部行的 UTF-8 字节数，**包含所有行结束符与结尾空行的结束符**。
- 每帧独立计数：一帧 dispatch/reset 之后，下一帧从 0 重新开始。
- 因此同一个 chunk 内多个合法小帧的**总长度可以超过单帧上限**，这是允许的。
- 计数按 **UTF-8 原始字节**，不使用 JS 字符数（10 个 CJK 字符是 30 字节，
  6 个 emoji 是 24 字节）。
- 当前帧一旦超过上限**立即失败**；检查发生在 dispatch/reset **之前**，因此
  「加上最终空行才超限」也会失败，不存在清零后被绕过的窗口。
- 未结束帧同样受上限约束，且**跨 chunk 持续检查**。
- 只缓存当前帧的**未完成行**，不把整个 chunk 先复制进内部累计缓存再检查；
  越界会在复制前就被拒绝。

### 5.2 惰性分帧

- `SseFrameParser.framesFrom(chunk)` 返回**惰性**帧迭代器；`push(chunk)`（数组接口）
  保留给已有调用方，内部即 `[...framesFrom(chunk)]`。
- 两个协议的 `decode` 都使用惰性接口：一旦供应商语义终止（`message_stop` /
  `[DONE]` / `error`），**当前 chunk 的剩余字节不再解析**，
  也不会再读取后续 chunk，上游 iterator 随即释放。
- 因此「合法完成后追加的非法字节或超限帧」不会污染已经完成的响应。
- 惰性迭代器被放弃后，该 parser 实例不再复用（解码结束即丢弃）。

### 5.3 行结束符与跨 chunk 的 CR

行结束符是单字节 ASCII，扫描时永远不会切开 UTF-8 多字节序列。解析器把 chunk 末尾
的 CR 暂时留在缓存中，因为它的归属只能由**紧随其后的那一个字节**决定：

- 下一 chunk 首字节是 **LF** → 视为同一个 `CRLF` 终止符，两字节只计一次。
- 下一 chunk 首字节**不是** LF → CR 已单独结束上一行，新 chunk 从它自己的首字节开始新行。
- 下一 chunk 为**空** → 保持等待，不丢失该状态。
- **EOF** → 按单独 CR 行结束符处理，然后照常判断帧是否完整。

关键点是**绝不能用「下一次找到的换行符」推断是否是 CRLF**：例如
`data: x\rdata: y\n\n` 在 CR 后切分时，后面确实还有一个 LF，但它与缓存中的 CR 之间
隔着 `data: y`，两者不是同一个终止符。早期的实现按「下一个 LF」判断，会把
`data: y` 直接拼到上一行上，得到 `xdata: y` 而不是 `x\ny`。

因此无论把同一段字节流切成整块、任意两段还是逐字节，解析结果都完全一致。

## 6. usage、结束、截断、错误与取消

### 6.1 usage

- Anthropic：`input_tokens` 取 `message_start`；`output_tokens` 使用后续
  `message_delta` 的**累计值**（赋值，绝不累加）。正常结束前输出一次汇总 usage。
- OpenAI：`usage` chunk 映射 `prompt_tokens` → `inputTokens`、
  `completion_tokens` → `outputTokens`；两者都是非负安全整数，否则报错。
- usage 缺失时**不伪造零值**：不输出 usage 事件。

### 6.2 结束与截断

- Anthropic：只有 `message_stop` 且无未关闭块、`stop_reason ∈ {end_turn, tool_use}`
  时才输出 `completed`；`max_tokens` / `stop_sequence` / `refusal` / `pause_turn`
  等一律按协议错误处理，**不执行残缺工具调用**。
- OpenAI：只有收到 `[DONE]`、此前已有合法 `finish_reason`、且没有未完成工具时
  才输出 `completed`；`length` / `content_filter` 等按协议错误处理。
- EOF 缺少终止标记、空流、畸形 JSON、错误字段类型、未结束工具参数都不能静默成功。
- 已输出的文本不会撤销；后续失败输出一个 `error`，绝不伪造 `completed`。

### 6.3 错误

`encode` 失败抛 `AdapterError`，code 只可能是：

```text
invalid_adapter_request
unsupported_adapter_input
invalid_adapter_options
```

消息为固定文案，不附带原始请求、参数或 `cause`。

`decode` 对外只输出既有 `ModelStreamEvent`，错误 code 限定为：

```text
aborted
provider_protocol_error
upstream_unavailable
rate_limited
gateway_error
```

- 只有明确识别的供应商结构化错误类型才映射为可重试类别：
  - `rate_limited`：Anthropic `rate_limit_error`；OpenAI `rate_limit_error` /
    `rate_limit_exceeded`
  - `upstream_unavailable`：Anthropic `overloaded_error`；OpenAI `server_error` /
    `overloaded_error`
- 其他上游错误统一 `gateway_error`。**不通过 message 文本猜测错误类型。**
- 原始 JSON、SSE 文本、URL、认证字段、堆栈与 `AbortSignal.reason` 都不会进入错误事件。
- 每次 `decode` 最多一个终止事件（`completed` 或 `error`）。终止后停止消费后续输入
  并释放 upstream iterator。

### 6.4 取消

- 开始前已 `aborted`：输出一个 `aborted`，**不开始消费** source（不调用 `source.next()`）。
- 消费过程中 `aborted`：停止输出正常事件，输出一个 `aborted`。
- **取消检查覆盖三个阶段**：读取 chunk 之前、**推进当前 chunk 的帧迭代器之前**、
  每个事件 yield 恢复之后。因此即使取消发生在**同一个 chunk 的帧之间**，
  也不会再输出 `text_delta`、`tool_call`、`usage` 或 `completed`。
- 「推进帧迭代器之前」是硬性顺序：帧迭代器是**显式驱动**的，取消检查必须先于
  `frames.next()`。否则 `for...of` 会在进入循环体之前就取出下一帧，
  一个**畸形尾部帧**会先抛出协议错误，使已经取消的消费者拿到
  `provider_protocol_error` 而不是 `aborted`。取消后帧迭代器会被 `return()`
  放弃，当前 chunk 的剩余字节既不解析也不校验。
- 该顺序可用测试内的迭代器 spy 证明：取消后帧迭代器的推进次数不再增加。
  两种协议都覆盖了「合法尾部帧」这一情形——此时输出本身无法区分正确与错误实现，
  只有推进次数能区分。
- 一个供应商帧产生多个事件时（例如 Anthropic `message_stop` 会产出
  `tool_call` + `usage` + `completed`），消费第一个非终止事件后取消，
  其余事件被抑制，只输出一个 `aborted`。
- 已经**实际输出**给消费者的终止事件保持不变，之后只追加 `aborted` 而不是别的正常事件。
- 正在等待 `source.next()` 时取消：通过 `AbortSignal` 竞速立即解除对外等待，
  **不依赖下一个 chunk 到达**。
- 竞速期间保持对悬挂 `next()` Promise 的 rejection 处理，不产生 unhandled rejection。
- 清理监听器；调用上游 `iterator.return()`（存在时）。悬挂的 `return()` 不会被等待，
  因此不会阻止对外取消结束。
- 调用方主动关闭输出 iterator 时同样释放上游。
- 不通过把 chunk 切成固定小片段来「制造」取消点：取消覆盖的是帧边界与事件边界。

## 7. 工具关联（两个协议共同子集）

进入协议编码前先运行共享 `validateModelRequest`，再执行本阶段的更严格子集校验：

- `system` 只能在历史最开头，且只含 `text`；`user` 只含 `text`；
  `assistant` 含 `text` / `tool_call`；`tool` 只含 `tool_result`。
- `tool_result.isError` 出现时必须是 boolean。
- 工具 `input` 必须是普通 JSON 对象（不能是字符串、数组、`null`）。
- 工具 `inputSchema` 必须是顶层 `type: "object"` 的普通 JSON 对象。
- JSON 不能循环引用，不能含函数、`undefined`、`NaN`、`Infinity`。
- 保留全部 `tool_call.id` 与 `tool_result.toolCallId`；每个结果必须引用一个仍待完成的
  调用；同一调用只能有一个结果；进入下一条 `user` / `assistant` 消息前该轮调用必须
  全部有结果；历史末尾不得残留待执行调用。
- 历史工具名称不要求属于本轮 `tools` 列表（历史与当前可用工具集合可能不同）。
- 工具历史不会被降级为普通聊天文本。

这些限制只存在于适配器层，**共享校验器对其他调用方的行为未被修改**。

### 7.1 解码侧的工具调用约束

**工具 ID 唯一性（OpenAI Chat Completions）**

- 同一次解码内，不同 `tool_calls[].index` 的**最终 ID 必须唯一**。
- 同一个 index 在后续片段中重复声明**相同** ID：接受（上游常见的分片行为）。
- 同一个 index 声明**冲突** ID：拒绝。
- 不同 index 声明**相同** ID：拒绝。
- 整批校验在**输出任何工具调用之前**完成：不会先输出第一条再发现第二条重复，
  也不会为了「修复」上游而改写工具 ID。
- 违反时输出恰好一个 `provider_protocol_error`，不输出 `completed`、不输出任何
  `tool_call`。
- 按 index 聚合与排序输出的行为不变（按 index 升序，与到达顺序无关）。

**工具参数的 JSON 值有效性（两个协议共享）**

- 解析后的工具参数必须是普通 JSON 对象，且**所有数值必须是有限值**。
- 上游写入 `1e400` 会被 `JSON.parse` 变成 `Infinity`，而 `Infinity` 不是 JSON 值
  （再序列化会变成 `null`）。两种情况都必须拒绝，两个协议使用同一份共享校验，
  行为不允许分叉。
- 空参数串（Anthropic 无 `input_json_delta`、OpenAI `arguments: ""`）按空对象 `{}` 处理。

**Anthropic `tool_use.input` 初始对象（`content_block_start`）**

- 本阶段要求 `tool_use.input` **必须存在且必须是普通 JSON 对象**；
  `[]`、`null`、`"{}"`、数字、boolean、缺失字段一律拒绝。
- 空对象 `{}` 合法。
- **不得**把非法初始值静默替换为 `{}`：那会把一次非法上游负载变成另一次看起来有效
  的工具调用。
- 初始对象与拼接后解析出的对象都必须是合格的有限 JSON 值（例如 `{"n":1e400}` 拒绝）。
- 初始对象的**大小口径**：`JSON.stringify(input)` 的 **UTF-8 字节长度**，受
  `maxToolInputBytes` 约束。
- 参数 delta 继续按片段的 UTF-8 字节数累积并与同一上限比较。
- 非空初始对象**同时**伴随非空参数 delta 属于歧义输入，本阶段**明确拒绝**，
  不做静默合并或覆盖。
- 官方常见形态（`input: {}` + `input_json_delta` 分片）继续支持。

## 8. 安全说明

- 工具事件（`tool_call`）目前仍是**内部数据**，不得直接当作未来 Renderer 的安全
  展示事件。
- 本项目**不宣称具备通用秘密检测能力**：适配器只保证不回显上游错误文本、
  不输出认证字段，不承诺识别任意形式的凭据。
- 测试中的 `TOP_SECRET_*`、`https://provider.invalid` 与伪造 `Authorization` 都是
  合成 fixture，不是真实凭据。
