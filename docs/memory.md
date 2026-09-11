# Memory 与上下文压缩

`@agent-workbench/agent-memory` 提供进程内 Memory Store 与确定性上下文构建/压缩。

## 架构位置

```text
Agent Runtime / Future API
        ↓
@agent-workbench/agent-memory
        ├─ InMemoryMemoryStore
        └─ deterministic Context Builder
                ↓
        injected ContextSummarizer
```

## Memory Store

- **进程内**实现，当前**不持久化**、不写文件、不写数据库
- Memory 由调用方**显式写入**，不从 AgentEvent / 模型输出 / 工具结果自动提取
- 搜索是确定性的文本匹配（按空白切词、小写、content+tags）
- 评分：命中 token 数降序 → updatedAt DESC → id ASC
- scope 隔离；防御性拷贝；固定错误消息

### 默认限制

| 常量 | 默认 | 上限 |
|------|------|------|
| entries per scope | 128 | 4096 |
| content bytes | 16 KiB | 256 KiB |
| tags per entry | 16 | 64 |
| tag bytes | 128 | 1024 |

## Context Builder

`buildContext(options)` 按 UTF-8 字节预算构建上下文：

1. 若加入 memory 后未超预算 → 返回完整消息，不调用 summarizer
2. 若超预算 → 保留 system / 最后 user / tool 原子组；旧历史交给 summarizer
3. 摘要以 `[Context summary]\n...` 的 system message 注入
4. Memory 以 `[Retrieved memory]\n- [kind] content` 的 system message 注入

### 保留规则

- 所有 system message 必须保留
- 最后一条 user message 及其之后的消息必须保留
- assistant `tool_call` 与对应连续 `tool` result 作为不可拆分组
- 保护区本身超预算 → `context_budget_exceeded`

### Summarizer 边界

- 注入式 `ContextSummarizer`；支持 object literal / null-prototype / class 实例
- 未提供 summarizer 且需要压缩 → `context_compression_required`
- summarizer 异常 → `context_compression_failed`（不回显原始异常）
  - **同步抛出**（`summarize()` 在被 `Promise.resolve()` 包裹前同步 throw）同样折叠为
    固定错误，不回显原始 message / stack / URL / 路径 / secret
  - 异步 reject 与 late reject 行为保持不变
- 取消：预取消 / pending 中取消 / late resolve/reject 均安全处理

### Signal 运行时校验

`options.signal` 仅接受合法的 AbortSignal 形状，否则 `invalid_context_options`：

- `undefined`（未提供）合法
- 原生 `AbortController().signal` 合法
- `null` / 空对象 / 仅有 `aborted` 的对象 / `addEventListener` 非 callable /
  `aborted` 非 boolean 一律拒绝，且错误消息固定，不回显传入对象
- 校验先行，杜绝取消路径上的原生 TypeError（如 `signal.addEventListener is not a function`）

## Context MemoryEntry 校验

`buildContext` 注入 memory 前对每个 `MemoryEntry` 做完整运行时校验，非法即
`invalid_context_memory`（固定文案，不回显被拒值）：

| 字段 | 约束 |
|------|------|
| `id` / `scopeId` | 非空且匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`（与 Memory Store 一致，≤64 字符、无 `\0`） |
| `kind` | `fact` / `preference` / `decision` / `todo` |
| `content` | 非空字符串、无 `\0`、UTF-8 字节数 ≤ 16 KiB（不静默截断） |
| `tags` | 数组且 ≤16 个；每个为非空字符串、无 `\0`、≤128 UTF-8 字节；不允许重复 |
| `createdAt` / `updatedAt` | 有限 number（拒绝 `NaN` / `±Infinity` / 字符串 / boolean） |
| 允许字段 | 仅 `id` `scopeId` `kind` `content` `tags` `createdAt` `updatedAt`；未知字段与敏感字段（`apiKey` / `token` / `authorization` / `headers` / `password` / `secret` / `credential` / `providerId` / `baseUrl` 等）一律拒绝 |

## 未实现

- 持久化 Memory / 数据库 / 向量搜索 / Embedding
- CredentialStore / OS Keychain
- 真实模型摘要调用
- CLI / Desktop / Tauri
- 自动记忆提取
