# Task 3 执行报告

> 本文件是 Task 3（双协议请求转换与离线流式解析）的实现报告。
> 最终 commit hash 见对话回复，不要求本文件包含自身提交哈希。

## 1. 最终状态

**DONE**

两种协议均已实现请求编码与增量 SSE 解码；无整体缓冲；工具 ID 与参数不丢失不串线；
EOF/截断不会误报 `completed`；usage 累计值不重复相加；原始上游错误不进入事件；
取消等待可结束；新增包依赖方向未变；未越界实现真实网络。

## 2. 基线与提交

- 工作目录：`C:\Users\liningshuai\Desktop\科研PART\学习\agent-workbench\agent-workbench-app`
- 分支：`workbench/agent-core`
- 基线 HEAD：`fa10eabc7253e84de31c2cc8ba41442e67650ce1`（已确认属于当前历史）
- 基线状态：无已修改文件；未跟踪文件仅 `.superpowers/`（3 个 md）
- 基线 `typecheck`：exit 0；基线测试：7 个文件 / 106 个测试，exit 0
- 实现提交：见 §14「Git 信息」

## 3. 修改文件与职责

### 新增：协议适配器（`packages/model-gateway/src/adapters/`）

| 文件 | 职责 |
|------|------|
| `types.ts` | `EncodedModelRequest`、`StreamDecodeOptions`、`ProtocolAdapter`、`OpenAIChatAdapterOptions`、默认上限常量 |
| `errors.ts` | `AdapterError`（encode 抛出）与 `AdapterStreamError`（decode 内部）；两组稳定 code；固定文案 |
| `request-validation.ts` | 先调用共享 `validateModelRequest`，再执行角色/块类型子集、工具参数对象、schema 对象、工具关联规则 |
| `sse.ts` | `SseFrameParser` / `parseSseStream`：字节 → SSE 帧；UTF-8 跨 chunk、LF/CRLF、多行 data、注释、id/retry、帧上限 |
| `anthropic-request.ts` | `ModelRequest` → Anthropic Messages body |
| `anthropic-stream.ts` | Anthropic Messages SSE → `ModelStreamEvent` |
| `openai-chat-request.ts` | `ModelRequest` → Chat Completions body（含工具结果 JSON 信封） |
| `openai-chat-stream.ts` | Chat Completions SSE → `ModelStreamEvent` |
| `stream-runtime.ts` | 共享驱动：增量消费、取消竞速、单一终止事件、上游 `return()` 释放、选项校验 |
| `decode-utils.ts` | 帧内 JSON 解析、token 计数校验、缓存令牌检查、错误类型映射 |
| `index.ts` | 两个工厂函数 `createAnthropicMessagesAdapter` / `createOpenAIChatCompletionsAdapter` |

> `stream-runtime.ts` 与 `decode-utils.ts` 不在提示词“建议新增”清单内，是为避免在两个
> provider 解码器中重复实现取消与 JSON 校验而抽取的共享模块。

### 新增：测试

| 文件 | 测试数 | 覆盖 |
|------|--------|------|
| `tests/helpers/adapter-fixtures.ts` | — | 请求构造、字节切分、SSE 帧构造、gated/计数 source、限时取事件 |
| `tests/task-3-adapter-requests.test.ts` | 36 | 两种协议请求编码、工具历史校验、副本隔离 |
| `tests/task-3-sse.test.ts` | 23 | SSE 分帧与资源边界 |
| `tests/task-3-anthropic-stream.test.ts` | 33 | Anthropic 解码、usage、截断、错误映射 |
| `tests/task-3-openai-chat-stream.test.ts` | 33 | Chat Completions 解码、工具参数、finish/usage/DONE、错误映射 |
| `tests/task-3-adapter-integration.test.ts` | 20 | 取消、错误边界、增量流式、并发隔离、Agent Core 集成 |

### 新增：文档

- `docs/protocol-adapters.md`：官方资料链接与日期、公开接口、字段映射、支持/不支持、
  OpenAI 工具结果信封约定、usage/结束/截断/错误/取消规则、SSE 限制、未做真实验证的事实。
- `docs/verification/task-3-report.md`：本文件。

### 修改

| 文件 | 变更 |
|------|------|
| `packages/model-gateway/src/index.ts` | 导出适配器、SSE 分帧器与相关类型/错误；原有导出保持不变 |
| `packages/model-gateway/package.json` | 更新 `description`；依赖仍只有 `agent-contracts` |
| `README.md` | 当前阶段更新为 Task 3；补充「还没有」与 OpenAI 子集声明 |
| `docs/architecture.md` | 协议层说明、Task 3 组件表与边界 |
| `scripts/evals-deterministic.mjs` | 新增布局断言 + **实际运行** Task 3 离线协议场景并传递退出码 |

未修改：`packages/agent-core/**`、`packages/agent-contracts/**`、`packages/provider-registry/**`
（除 `docs`/`README`/`scripts` 外无跨包改动）。

## 4. 公开接口与包依赖

### 公开接口

```ts
export interface EncodedModelRequest { readonly body: { readonly [key: string]: JsonValue } }
export interface StreamDecodeOptions {
  readonly signal?: AbortSignal;
  readonly maxFrameBytes?: number;
  readonly maxToolInputBytes?: number;
}
export interface ProtocolAdapter {
  encode(request: ModelRequest): EncodedModelRequest;
  decode(source: AsyncIterable<Uint8Array>, options?: StreamDecodeOptions): AsyncIterable<ModelStreamEvent>;
}
export interface OpenAIChatAdapterOptions {
  readonly tokenLimitField?: "max_tokens" | "max_completion_tokens";
}
export function createAnthropicMessagesAdapter(): ProtocolAdapter;
export function createOpenAIChatCompletionsAdapter(options?: OpenAIChatAdapterOptions): ProtocolAdapter;
```

同时导出：`AdapterError`、`AdapterStreamError`、`ADAPTER_ERROR_CODES`、`STREAM_ERROR_CODES`、
`SseFrameParser`、`parseSseStream`、`assertAdapterRequest`、`encodeAnthropicMessagesRequest`、
`decodeAnthropicMessagesStream`、`encodeOpenAIChatRequest`、`encodeToolResultEnvelope`、
`decodeOpenAIChatCompletionsStream`、`DEFAULT_MAX_FRAME_BYTES`、`DEFAULT_MAX_TOOL_INPUT_BYTES`。

### 包依赖

- `model-gateway` 依赖：仅 `@agent-workbench/agent-contracts`（`workspace:*`）。
- 不依赖 `agent-core`、不依赖 `provider-registry`、不新增任何第三方依赖。
- 无跨包 `../../<其他包>/src/...` 导入。

## 5. 两种协议的实际支持范围

`anthropic_messages`：

- 支持：流式文本、客户端 `tool_use`、`usage`、`end_turn` / `tool_use` 结束、`ping` 忽略。
- 不支持（报 `provider_protocol_error`）：`thinking` / `signature`、服务端工具、
  非零缓存令牌计数、`max_tokens` / `stop_sequence` / `refusal` / `pause_turn` 结束、
  未知事件类型。

`openai_compatible`（仅 Chat Completions）：

- 支持：流式文本、function tools、usage chunk、`stop` / `tool_calls`、`[DONE]`。
- 不支持（报 `provider_protocol_error`）：Responses API、Codex/ChatGPT 账户流程、
  `function_call` 旧字段、`refusal`、reasoning 扩展、`length` / `content_filter`、
  `n > 1`、`choice.index != 0`、未知 chunk 形状。

## 6. 各检查点 Red/Green 证据

| 检查点 | Red 命令与退出码 | Red 关键断言 | Green |
|--------|------------------|--------------|-------|
| A 请求编码 | `pnpm test` → **1** | `TypeError: (0 , createAnthropicMessagesAdapter) is not a function`（工厂与编码器均不存在） | exit **0**，36 个新测试 |
| B SSE 分帧 | `pnpm test` → **1** | `Cannot find module '../packages/model-gateway/src/adapters/sse.js'` | exit **0**，23 个新测试 |
| C Anthropic 解码 | `pnpm test tests/task-3-anthropic-stream.test.ts` → **1** | 12 项行为失败，例如 `expected [ { type: 'error' } ] to deeply equal [ { type: 'text_delta' }, … ]`、`expected 'provider_protocol_error' to be 'rate_limited'` | exit **0**，33 个新测试 |
| D OpenAI 解码 | `pnpm test tests/task-3-openai-chat-stream.test.ts` → **1** | 15 项行为失败，例如 `expected '' to be '你好'`、`expected 'provider_protocol_error' to be 'gateway_error'` | exit **0**，33 个新测试 |
| E 取消与集成 | 首次执行即 **0**（见下） | 无行为缺陷：取消/释放逻辑在检查点 C 的 `stream-runtime.ts` 中已实现 | exit **0**，20 个测试 |
| E 变异校验 | `pnpm test tests/task-3-adapter-integration.test.ts` → **1** | 移除取消支路后 4 项失败：`expected [error] to deeply equal [aborted]`、`timed out waiting for a decoded event`、两处 `Test timed out in 5000ms` | 恢复后 exit **0** |

关于检查点 E：E 的行为（取消、错误边界、集成）在 C 阶段实现 `stream-runtime.ts` 时
已经落地，因此 E 的首轮执行为 Green。为证明这些断言确实可失败，做了一次**受控变异检查**：
临时移除 `decodeFrameStream` 的预取消判断与 `nextStep` 的 `AbortSignal` 竞速，重跑 E，
得到 4 项具体行为失败（含「等待 `next()` 时取消超时」），随后从备份恢复并重新验证全绿。
变异检查不是交付内容，工作区已还原（`grep` 确认 `options.signal` 两处仍在）。

错误信息清洗的 Red 证据同样具体：C 阶段 `maps a structured rate limit error` 失败于
`expected 'provider_protocol_error' to be 'rate_limited'`，D 阶段
`does not guess the error class from free text` 失败于
`expected 'provider_protocol_error' to be 'gateway_error'` —— 说明错误映射断言是可失败的，
而非恒真。

## 7. 必测行为与测试对应关系

| 必测行为 | 位置 |
|----------|------|
| 两种协议文本/system/工具定义/工具历史完整转换 | `task-3-adapter-requests.test.ts`（Anthropic / OpenAI 两组） |
| 多工具及各自结果、空 tools | 同上 |
| 两种 OpenAI token 上限选项、非法选项 | 同上 |
| 错误 role/block 组合、孤立结果、重复结果、未完成调用 | 同上「shared history validation」 |
| 非对象 input/schema、循环 JSON | 同上 |
| 原始 request 不被修改、编码结果深拷贝隔离 | 同上「copy isolation」 |
| 不输出 requestId/routeId/凭据字段 | 同上 |
| 中文/emoji 单字节切分、CRLF 分片、多帧同 chunk、多行 data、注释 | `task-3-sse.test.ts` |
| 畸形 JSON、非法 UTF-8、半帧 EOF | `task-3-sse.test.ts` / `task-3-anthropic-stream.test.ts` / `task-3-openai-chat-stream.test.ts` |
| 帧大小与工具参数大小边界、按字节计数、持续检查 | `task-3-sse.test.ts` |
| 两种协议纯文本成功流、工具调用成功流 | `task-3-anthropic-stream.test.ts` / `task-3-openai-chat-stream.test.ts` |
| 多工具参数不串线 | 两者（Anthropic 按 block index，OpenAI 按 tool_call index） |
| 空参数对象 | 两者 |
| 无效 JSON、重复 ID、无效事件顺序 | 两者 |
| Anthropic usage 不重复累加 | `task-3-anthropic-stream.test.ts` |
| OpenAI usage-only chunk、无 usage 流 | `task-3-openai-chat-stream.test.ts` |
| finish/stop 标记缺失、截断、不支持内容 | 两者 |
| 成功与错误后不继续消费垃圾帧 | 两者 |
| 预取消、中途取消、等待 `next()` 时取消 | `task-3-adapter-integration.test.ts`「cancellation」 |
| 上游抛异常、调用方提前退出 | 同上 |
| 恶意 error 中 URL/伪造 Authorization/堆栈不泄露 | `task-3-anthropic-stream.test.ts`、`task-3-openai-chat-stream.test.ts`、集成测试 |
| adapter 实例并发调用互不污染 | `task-3-adapter-integration.test.ts`「concurrency」 |
| encode/decode 不调用 fetch、不导入网络模块、不访问 CredentialStore | `task-3-adapter-integration.test.ts` |

## 8. 完整验证

| 命令 | 退出码 | 关键输出 |
|------|--------|----------|
| `corepack pnpm install --frozen-lockfile` | 0 | `Lockfile is up to date, resolution step is skipped`（lockfile 未变） |
| `corepack pnpm typecheck` | 0 | 无错误 |
| `corepack pnpm test` | 0 | `Test Files 12 passed (12)`、`Tests 251 passed (251)` |
| `corepack pnpm verify:layout` | 0 | 通过 |
| `corepack pnpm security:scan` | 0 | 见 §14 |
| `corepack pnpm evals:deterministic` | 0 | 布局断言 + 实际运行 Task 3 集成场景 |
| `git diff --check` | 0 | 无空白错误 |
| `git fsck --connectivity-only` | 0 | 见 §14 |
| `git status --short --branch` | 0 | 见 §14 |

测试数量：基线 106 → 最终 251（新增 145）。

## 9. 流式与取消证明

增量（gate 证明）：`task-3-adapter-integration.test.ts` 中使用 `createGatedSource()`，
先只推入 `message_start` + `content_block_start` + 一个 `text_delta` 帧，在**流未结束、
gate 未关闭**的情况下断言已能取到 `{type:"text_delta"}`；随后再推入第二个 delta 并再次
取到事件；最后才推入 `content_block_stop` / `message_delta` / `message_stop` 并关闭 gate。
OpenAI 侧同理。另有专门的「does not buffer the whole response before the first event」用例。
没有使用「先收集完整数组再断言」的伪流式验证。

取消：

- 预取消：断言事件恰为一条 `aborted`，且 `source.nextCalls === 0`（未开始消费）。
- 中途取消：取得一个 `text_delta` 后 `abort()`，断言下一条事件为 `aborted`、随后流结束，
  且上游 `return()` 已被调用。
- 悬挂 `next()`：上游 `next()` 返回永不 settle 的 Promise，`abort()` 后**限时**（
  `nextEvent` 内置超时）取得 `aborted`；断言 `nextCalled === true` 证明确实在等待中取消。
- 悬挂 Promise 的 rejection：在 `abort()` 后主动 reject 上游 Promise，挂载
  `process.on("unhandledRejection")` 断言无未处理拒绝。
- 悬挂 `return()`：`releaseIterator()` 故意**不 await** 上游 `return()`，因此不会被悬挂的
  清理阻塞对外取消结束。
- 调用方提前退出：`iterator.return()` 后断言上游 `returnCalls >= 1`。

## 10. 错误清洗、工具关联与 usage 证据

- 错误清洗：两个解码器的错误事件只使用固定文案；测试断言事件 JSON 不含
  `TOP_SECRET_FIXTURE_VALUE`、`provider.invalid`、`authorization`、`bearer`、`x-api-key`，
  并且不通过 message 文本猜测类别（`invalid_request_error` + 文本 "rate limited" 仍映射
  `gateway_error`）。Agent Core 侧二次清洗，最终 Agent 事件为
  `{code:"gateway_error", message:"Model gateway request failed."}`。
- 工具关联：`assertToolCorrelation()` 覆盖孤立结果、重复结果、未完成调用、
  在下一条 user/assistant 消息前仍有待处理调用、历史末尾残留调用；
  Anthropic 按 `content_block` index 累积参数，OpenAI 按 `tool_calls[].index` 累积并按
  index 排序输出（测试刻意以 1 → 0 的到达顺序验证排序不依赖插入顺序）。
- usage：Anthropic 以三个累计 `message_delta` 验证取最后一次的 **21**（而非求和）；
  OpenAI 验证 usage-only chunk、无 usage 流不伪造零值、非法负值被拒绝。

## 11. 网络说明

- **查文档**：使用了 WebFetch 查阅 Anthropic 与 OpenAI 官方文档（见
  `docs/protocol-adapters.md` 的链接与日期）。这是开发期行为，不影响交付物。
- **安装依赖**：未新增任何依赖；`pnpm install` 只做 workspace 链接校验，
  `downloaded 0`。
- **应用与测试调用 Provider**：**没有**。测试全部使用合成字节流；
  集成测试中的 fetch spy 断言 0 次调用；源码级断言 `adapters/` 目录不含
  `fetch(`、`node:http(s)`、`undici`、`axios`、`node-fetch`。

## 12. 已知限制与环境失败

限制：

- 没有真实供应商端到端验证；第三方兼容实现的字段差异未覆盖。
- OpenAI 侧只覆盖 Chat Completions 的声明子集；`object` 字段不做校验。
- Anthropic 侧 `input_tokens` 只取 `message_start`；`message_delta` 中的
  `input_tokens` 不参与（按其累计语义本就不应重复计入）。
- 工具结果 JSON 信封是本项目约定，使用方需知晓。

环境：

- 本机 `corepack` shim 在 Git Bash 下路径被 MSYS 二次转换导致 `MODULE_NOT_FOUND`，
  改用等价的
  `MSYS2_ARG_CONV_EXCL="*" node "C:/Program Files/nodejs/node_modules/corepack/dist/corepack.js" pnpm …`
  调用同一 pnpm 12.3.4，Node v24.14.0。所有命令均在**普通权限**下成功，
  未出现 `EPERM`、符号链接权限或 Vitest 上级目录读取问题。
- 历史遗留（非本任务引入）：`git commit` 写 `.git/refs/heads/workbench/agent-core`
  在本沙箱内可能失败，导致提交对象 dangling。本次按流程**不手写 refs、不修改 HEAD**；
  实际情况见 §14 的实际记录。

## 13. git status、未提交文件与报告路径

见 §14。

## 14. Git 信息

见最终回复的 §9/Git 信息（随运行结果填写）。

## 15. 范围声明

本任务**没有**实现：

- 真实模型连接与 HTTP 传输、URL 拼接、探活、模型列表请求；
- 认证头注入、`CredentialStore` 读取；
- Anthropic / OpenAI 的真实端到端适配与验证；
- Provider 路由调度、重试、故障转移；
- 多轮 Agent Loop、工具执行、审批；
- 数据库、文件持久化、OS Keychain；
- Local Agent API、Desktop / Tauri、CLI；
- Memory、上下文压缩。

也未修改 `..\cc-switch-agent`、未复制 CC Switch 或 Claude Code 源码、
未使用 `git reset --hard` / `git checkout --` / force push、未改动既有 `.superpowers/`。
