# Node CLI for Local Agent API

`@agent-workbench/cli` 是 Local Agent API 的官方 Node.js 命令行客户端。命令编排仍在
CLI 包内，但 HTTP API 封装和 NDJSON 流式解析自 Task 16 起由
`@agent-workbench/local-agent-client` 统一提供，避免 Desktop 与 CLI 出现两套协议实现。

## 设计目标

- **类型安全**：完整 TypeScript 类型定义，契约由 `@agent-workbench/local-agent-api` 提供
- **流式优先**：增量解析 NDJSON 流，逐事件 yield，支持大响应与长时运行
- **安全边界**：
  - 仅接受 loopback URL（`http://127.0.0.1` 或 `http://localhost`）
  - 拒绝 14 种敏感命令行参数（`--apiKey`、`--token`、`--secret` 等）
  - 错误消息固定，不泄露 URL、响应 body、路径、异常或敏感参数值
  - UTF-8 fatal 验证，拒绝非法编码
  - 严格的尺寸限制：单行 256 KiB、总响应 16 MiB
- **依赖注入**：核心逻辑可注入 `CliIo`（stdio）、`CliRuntime`（时间、退出）、`fetch`，测试完全离线运行
- **取消支持**：所有异步操作接受 `AbortSignal`，CLI 监听 `SIGINT` / `SIGTERM` 统一取消

## 架构

```
apps/cli/src/
├── index.ts              # 程序入口，信号处理、异常边界
├── main.ts               # 命令执行编排，stdout/stderr 路由
├── cli.ts                # 命令路由，注入 CliIo / CliRuntime
├── args.ts               # 参数解析与安全验证
├── api-client.ts         # 共享 LocalAgentApiClient 的 CLI 兼容导出
├── ndjson.ts             # 共享 NDJSON 解析器的 CLI 兼容导出
└── errors.ts             # 固定错误码与消息，7 种安全错误
```

共享实现位于 `packages/local-agent-client/src/`。CLI 保留原有构造函数和导入路径，
因此既有命令与测试无需改写；Desktop 通过自己的 loopback adapter 使用同一实现。

共享客户端的安全约束包括：仅 loopback URL、无认证头、固定错误消息、fatal UTF-8、
精确 AgentEvent 校验、NDJSON 行/总字节上限，以及可取消且不等待迟到网络 Promise 的
响应处理。共享客户端不访问 Provider Registry、CredentialStore 或 Model Gateway。

### 数据流

1. **启动**：`index.ts` → 注册信号处理器 → 调用 `main()`
2. **参数解析**：`parseArgs()` 拒绝敏感参数、校验 loopback URL
3. **命令路由**：`Cli.run()` 根据命令分发到对应方法
4. **API 调用**：`LocalAgentApiClient` 构造 HTTP 请求、调用 `fetch`
5. **流式解析**：`parseNDJSONStream()` 逐行解码、校验、yield `AgentEvent`
6. **输出**：`CliIo.writeOutput()` / `.writeError()` 写入 JSON 或纯文本
7. **取消**：信号触发 `AbortController.abort()` → 所有操作立即中止 → 退出码 130

## 命令

### `health`
检查 Local Agent API 健康状态。

```bash
node apps/cli health --base-url http://127.0.0.1:4317
```

输出：
```json
{"status":"ok","version":"v1"}
```

### `create-session`
创建新会话。

```bash
node apps/cli create-session --base-url http://127.0.0.1:4317
```

输出：
```json
{"id":"sess-abc123","status":"idle","createdAt":1704067200000,"updatedAt":1704067200000}
```

### `get-session`
查询会话状态。

```bash
node apps/cli get-session --base-url http://127.0.0.1:4317 --session-id sess-abc123
```

### `list-events`
列出会话所有历史事件（非流式）。

```bash
node apps/cli list-events --base-url http://127.0.0.1:4317 --session-id sess-abc123
```

输出：`AgentEvent[]` JSON 数组

### `cancel`
取消正在运行的会话。

```bash
node apps/cli cancel --base-url http://127.0.0.1:4317 --session-id sess-abc123
```

### `run-turn`
执行一个对话轮次，流式输出事件。

```bash
node apps/cli run-turn \
  --base-url http://127.0.0.1:4317 \
  --session-id sess-abc123 \
  --message "Hello" \
  --route-id default-route
```

每行输出一个 `AgentEvent` JSON 对象：
```
{"type":"turn_started","requestId":"req-1","turnIndex":0}
{"type":"text_delta","requestId":"req-1","text":"Hello"}
{"type":"completed","requestId":"req-1"}
```

### `stream-turn`
执行对话轮次，仅输出文本增量（非结构化流）。

```bash
node apps/cli stream-turn \
  --base-url http://127.0.0.1:4317 \
  --session-id sess-abc123 \
  --message "Hello"
```

直接输出文本内容，无 JSON 包装：
```
Hello, how can I help you?
```

### `version`
显示版本信息。

```bash
node apps/cli version
```

## API 客户端

### `LocalAgentApiClient`

类型安全的 HTTP 客户端，封装所有 Local Agent API 端点。

```typescript
import { LocalAgentApiClient } from "@agent-workbench/cli/api-client";

const client = new LocalAgentApiClient("http://127.0.0.1:4317");

// 健康检查
const health = await client.health();

// 创建会话
const session = await client.createSession();

// 执行轮次（流式）
const request = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  routeId: "default-route",
};

for await (const event of client.runTurn(session.id, request)) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
}
```

#### 方法签名

```typescript
class LocalAgentApiClient {
  constructor(baseUrl: string, fetch?: typeof globalThis.fetch);

  health(signal?: AbortSignal): Promise<LocalAgentHealth>;
  createSession(signal?: AbortSignal): Promise<LocalAgentSession>;
  getSession(id: string, signal?: AbortSignal): Promise<LocalAgentSession>;
  listEvents(id: string, signal?: AbortSignal): Promise<readonly AgentEvent[]>;
  cancel(id: string, signal?: AbortSignal): Promise<unknown>;
  
  runTurn(
    id: string,
    request: LocalAgentTurnRequest,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent>;
}
```

#### 响应处理

- **会话响应解包**：服务器返回 `{ session: {...} }` 包装格式时自动提取内层 `session` 对象
- **HTTP 错误**：非 2xx 状态码抛出 `api_http_error`，固定消息"Local Agent API request failed."
- **网络错误**：连接失败、超时抛出 `api_unavailable`
- **协议错误**：响应格式不符合契约抛出 `api_protocol_error`
- **取消**：`AbortSignal` 触发时抛出 `aborted` 错误

#### 安全特性

- **仅 POST 发送 Content-Type**：所有 POST 请求（`/v1/sessions`、`/v1/sessions/:id/cancel`、`/v1/sessions/:id/turns`）发送 `Content-Type: application/json`
- **不发送认证头**：CLI 用于本地 loopback 通信，不发送 `Authorization`、`token` 等认证头
- **错误消息不含敏感信息**：错误对象不包含 URL、响应 body、路径或异常详情

## NDJSON 流式解析器

### `parseNDJSONStream()`

增量解析 NDJSON 流，逐事件 yield `AgentEvent`。

```typescript
import { parseNDJSONStream } from "@agent-workbench/cli/ndjson";

const response = await fetch("http://127.0.0.1:4317/v1/sessions/sess-1/turns", {
  method: "POST",
  body: JSON.stringify(request),
});

for await (const event of parseNDJSONStream(response.body!, signal)) {
  console.log(event);
}
```

#### 安全特性

- **UTF-8 fatal 验证**：使用 `TextDecoder("utf-8", { fatal: true })`，拒绝非法 UTF-8 序列
- **尺寸限制**：
  - 单行上限 256 KiB（262,144 字节）
  - 总响应上限 16 MiB（16,777,216 字节）
- **终止事件校验**：流必须以 `completed` 或 `error` 事件结束，之后不得有其他事件
- **增量解码**：支持 UTF-8 多字节字符、Emoji 跨 chunk 分割
- **取消支持**：`AbortSignal` 触发时立即释放 reader、抛出 `aborted` 错误

#### 错误处理

- **非法 UTF-8**：抛出 `api_protocol_error`
- **超过尺寸限制**：抛出 `stream_too_large`
- **缺少终止事件**：抛出 `api_protocol_error`
- **终止后有事件**：抛出 `api_protocol_error`
- **JSON 解析失败**：抛出 `api_protocol_error`
- **事件契约校验失败**：抛出 `api_protocol_error`（字段缺失、类型错误、未知字段）

## 错误码

CLI 使用固定的 7 种错误码，所有错误消息固定、不包含敏感信息：

| 错误码 | 消息 | 场景 |
|--------|------|------|
| `invalid_arguments` | CLI arguments are invalid. | 参数缺失、类型错误、敏感参数、非 loopback URL |
| `invalid_base_url` | Local API URL is invalid. | URL 格式错误、非 HTTP、包含用户信息 |
| `api_unavailable` | Local Agent API is unavailable. | 网络连接失败、超时 |
| `api_http_error` | Local Agent API request failed. | HTTP 非 2xx 状态码 |
| `api_protocol_error` | Local Agent API returned invalid data. | 响应格式错误、契约校验失败、UTF-8 错误 |
| `stream_too_large` | Local Agent API response is too large. | 超过 256 KiB 单行或 16 MiB 总量 |
| `aborted` | Operation aborted. | 用户取消（Ctrl+C）或 AbortSignal 触发 |

示例：

```typescript
import { CLI_ERROR_CODES, createCliError } from "@agent-workbench/cli/errors";

try {
  await client.health();
} catch (err) {
  if (err.code === CLI_ERROR_CODES.apiUnavailable) {
    console.error("Local Agent API 不可用");
  }
}
```

## 参数安全

### Loopback-only 限制

CLI 仅接受 loopback URL：
- ✅ `http://127.0.0.1:4317`
- ✅ `http://localhost:8080`
- ✅ `http://127.0.0.1` （默认端口 80）
- ❌ `http://192.168.1.100` （非 loopback）
- ❌ `https://127.0.0.1` （HTTPS 不支持）
- ❌ `http://user:pass@localhost` （不允许用户信息）

### 敏感参数拒绝

以下 14 种参数会被拒绝：

```
--apiKey, --api-key, --api_key
--token
--secret
--password, --pass
--credential, --credentials
--authorization, --auth
--bearer
```

任何尝试传递这些参数都会导致 `invalid_arguments` 错误，固定消息不泄露参数名称或值。

## 依赖注入

CLI 核心逻辑支持完全注入，测试不访问真实 stdio、不调用 `process.exit()`、不依赖真实时间。

### `CliIo`

抽象 stdin/stdout/stderr：

```typescript
interface CliIo {
  writeOutput(data: string): void;
  writeError(data: string): void;
  readInput?(): string;
}
```

测试示例：

```typescript
const fakeIo: CliIo = {
  writeOutput: vi.fn(),
  writeError: vi.fn(),
};

const cli = new Cli(fakeIo, fakeRuntime, fakeClient);
await cli.run(["health"]);

expect(fakeIo.writeOutput).toHaveBeenCalledWith('{"status":"ok"}\n');
```

### `CliRuntime`

抽象进程控制与时间：

```typescript
interface CliRuntime {
  exit(code: number): void;
  now(): number;
}
```

测试可注入 fake runtime，避免真实 `process.exit()` 中断测试进程。

### 自定义 `fetch`

`LocalAgentApiClient` 接受自定义 `fetch` 函数，测试注入 fake HTTP 客户端：

```typescript
const fakeFetch = async (url: string, init?: RequestInit) => {
  return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
};

const client = new LocalAgentApiClient("http://127.0.0.1:4317", fakeFetch);
const health = await client.health(); // 不访问真实网络
```

## 测试覆盖

CLI 实现包含 131 个自动化测试，覆盖：

- **参数解析**（59 tests）：loopback 校验、敏感参数拒绝、必需参数、默认值
- **API 客户端**（31 tests）：HTTP 方法、URL 构造、Content-Type、会话包装解析、AbortSignal 传播、错误处理、响应校验
- **NDJSON 流式解析**（28 tests）：增量解析、UTF-8 跨 chunk、尺寸限制、终止事件、取消、非法数据
- **安全特性**（10 tests）：固定错误消息、错误码集合、不泄露敏感信息
- **集成测试**（3 tests）：真实 LocalAgentApiServer 端到端工作流

### 变异测试

执行了 8 项受控变异以验证测试质量：

1. **移除终止事件验证** → ✅ 检出（`rejects stream without termination event`、`rejects events after completed/error`）
2. **移除 loopback 检查** → ✅ 检出（`rejects URL with non-loopback hostname`、5 个相关测试）
3. **移除单行大小限制（256 KiB）** → ✅ 检出（`single line exceeding 256 KiB is rejected`）
4. **UTF-8 fatal: true 改为 false** → ✅ 检出（新增测试：非法 UTF-8 嵌入 JSON 字符串字段）
5. **修改固定错误消息为动态** → ✅ 检出（`error messages are fixed and do not vary`）
6. **移除 session 响应包装解析** → ✅ 检出（新增测试：`createSession unwraps { session: {...} } wrapper`、`getSession unwraps { session: {...} } wrapper`）
7. **移除 AbortSignal 预检查** → ✅ 检出（`AbortSignal stops iteration early`、`aborted signal before parsing rejects`）
8. **移除 POST Content-Type 头** → ✅ 检出（新增测试：所有 POST 端点发送 `application/json`）

**检出率：100% (8/8)**

所有变异均被检出，测试质量达到目标。

## 集成测试

CLI 包含 3 个集成测试，使用真实 `LocalAgentApiServer` 实例：

- **端到端健康检查**：启动服务器 → CLI 调用 `/health` → 验证响应
- **创建会话**：CLI 调用 `/v1/sessions` → 服务器返回会话 → 验证 session.id
- **流式轮次**：CLI 提交 `/v1/sessions/:id/turns` → 服务器返回 NDJSON 流 → CLI 解析事件 → 验证 `text_delta` / `completed`

集成测试验证了：
- 真实 HTTP 请求/响应
- 服务器会话响应包装格式（`{ session: {...} }`）的正确解包
- NDJSON 流式解析与事件契约
- 完整的错误处理路径

## 生产部署注意事项

1. **Node.js 版本**：需要 Node.js 24+（依赖原生 `fetch` 与 `AbortSignal`）
2. **URL 限制**：仅支持 loopback HTTP，不支持 HTTPS、远程 IP、域名
3. **无重试**：CLI 不实现重试逻辑，由 Local Agent API 服务端负责韧性
4. **无持久化**：CLI 是无状态客户端，不缓存会话、不持久化配置
5. **信号处理**：自动监听 `SIGINT` / `SIGTERM`，Ctrl+C 会取消所有进行中操作并退出码 130
6. **错误码**：所有错误写入 stderr、退出码 1，可通过 `CliError.code` 区分错误类型

## 依赖关系

```
@agent-workbench/cli
├── @agent-workbench/local-agent-api (契约)
├── @agent-workbench/agent-core (AgentEvent 类型)
└── Node.js 24+ 原生 API
    ├── fetch
    ├── AbortController / AbortSignal
    ├── TextEncoder / TextDecoder
    └── ReadableStream
```

CLI 不依赖任何第三方 HTTP 客户端库（axios、node-fetch 等），完全基于 Node.js 原生 API。

## 未来增强

当前 CLI 是最小可用实现，可能的增强方向：

- **交互式会话**：持续对话模式，无需每次指定 session-id
- **配置文件**：持久化 base-url、默认 route-id
- **输出格式**：支持 `--format json|text|compact` 选项
- **调试模式**：`--debug` 输出 HTTP 请求详情（不泄露敏感头）
- **多会话管理**：列出、删除、归档会话
- **工具结果注入**：从文件或 stdin 读取工具执行结果

这些增强不在当前 Task 13 范围内。
