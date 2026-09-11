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
- 取消：预取消 / pending 中取消 / late resolve/reject 均安全处理

## 未实现

- 持久化 Memory / 数据库 / 向量搜索 / Embedding
- CredentialStore / OS Keychain
- 真实模型摘要调用
- CLI / Desktop / Tauri
- 自动记忆提取
