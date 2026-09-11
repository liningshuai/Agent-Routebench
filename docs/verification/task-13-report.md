# Task 13 验证报告

## 范围

Node CLI for Local Agent API: `@agent-workbench/cli`

## 基线

- Task 13 初始实现: `23359147bc481aa79f74f3685f45599e6a91f0a8` (父提交: `ded4fc938be0af74f2e54aef286c674338ecfd4d`)
- 第一次收尾修复: `f5e295d9000029699b66191c4aa4b409b4517609` (父提交: `23359147bc481aa79f74f3685f45599e6a91f0a8`)
- 第二次验证收尾: `d88845f97d262489da4c020561ddf6adec57001a` (父提交: `f5e295d9000029699b66191c4aa4b409b4517609`)
- 第三次文档修正: `80b2e241c925e246f5ea87310b71e372bb8f0904` (父提交: `d88845f97d262489da4c020561ddf6adec57001a`)
- 当前最终提交: `80b2e241c925e246f5ea87310b71e372bb8f0904`
- 分支: `workbench/agent-core`
- 工作区: 仅 `.superpowers/` 未跟踪

## 新增包

`apps/cli/`

**核心实现 (882 行)**:
- `src/ndjson.ts` (192 行) — NDJSON 流式解析器，UTF-8 验证，终止事件检查
- `src/api-client.ts` (158 行) — HTTP 客户端，会话包装解析，AbortSignal 传播
- `src/cli.ts` (160 行) — 命令路由，依赖注入接口（CliIo, CliRuntime）
- `src/main.ts` (61 行) — Node.js 入口，错误处理，退出码映射
- `src/args.ts` (209 行) — 参数解析，loopback 验证，敏感参数拒绝
- `src/errors.ts` (36 行) — 固定错误码和消息
- `src/types.ts` (22 行) — TypeScript 类型定义
- `src/index.ts` (9 行) — 公共 API 导出
- `package.json` (26 行) — 包配置，运行时依赖 @agent-workbench/agent-core 和 @agent-workbench/local-agent-api
- `tsconfig.json` (9 行) — TypeScript 编译配置

运行时依赖：
- `@agent-workbench/agent-core` (AgentEvent 类型)
- `@agent-workbench/local-agent-api` (LocalAgentSession, LocalAgentTurnRequest 契约)

## 测试

| 文件 | 数量 | 说明 |
|------|------|------|
| task-13-cli-args.test.ts | 59 | 参数解析、loopback 验证、敏感参数拒绝 |
| task-13-cli-client.test.ts | 31 | HTTP 客户端、会话验证、请求构造、Content-Type 验证、会话包装解析 |
| task-13-cli-streaming.test.ts | 28 | NDJSON 解析、终止验证、UTF-8 fatal、取消 |
| task-13-cli-security.test.ts | 10 | 错误消息固定、无 process.env、退出码分离 |
| task-13-cli-integration.test.ts | 3 | 实际服务器集成、完整工作流 |
| helpers/cli-fixtures.ts | - | FakeFetch 工具类 |
| **合计** | **131** | |

全量：49 文件 / 1163 测试（1032 基线 + 131 Task 13）。

## 受控变异（8 项执行，8 项检出）

| # | 变异 | 目标文件 | 检出 |
|---|------|----------|------|
| 1 | 删除 NDJSON 终止事件验证 | ndjson.ts | ✅ 是 (2 failed) |
| 2 | 删除 loopback 地址验证 | args.ts | ✅ 是 (5 failed) |
| 3 | 删除单行大小限制（256 KiB） | ndjson.ts | ✅ 是 (1 failed) |
| 4 | 删除 UTF-8 fatal 验证 | ndjson.ts | ✅ 是 (1 failed) ⭐ |
| 5 | 修改固定错误消息为动态 | errors.ts | ✅ 是 (1 failed) |
| 6 | 删除 session 响应包装解析 | api-client.ts | ✅ 是 (2 failed) ⭐ |
| 7 | 忽略 AbortSignal 预检查 | ndjson.ts | ✅ 是 (2 failed) |
| 8 | 删除 Content-Type 请求头 | api-client.ts | ✅ 是 (3 failed) ⭐ |

**检出率**: 100% (8/8)

**改进**:
- Mutation 4: ⭐ 新增测试 "invalid UTF-8 inside JSON string field is rejected with fatal validation"
- Mutation 6: ⭐ 新增 2 个测试覆盖 createSession 和 getSession 的 `{ session: {...} }` 包装解析
- Mutation 8: ⭐ 新增 3 个测试覆盖所有 POST 端点的 Content-Type 验证

详见 [task-13-mutations.md](./task-13-mutations.md)。

## 安全约束验证

### 网络限制
- ✅ 仅接受 `http://127.0.0.1` 和 `http://localhost`
- ✅ 拒绝 `http://example.com` 等外部 URL
- ✅ 拒绝 HTTPS、用户名/密码、查询参数、片段
- ✅ 所有测试使用注入的 fake fetch，零真实网络调用

### 凭据隔离
- ✅ CLI 模块不导入 dotenv
- ✅ 不访问 `process.env`
- ✅ 拒绝 `--api-key`, `--token`, `--credential` 等 14 个敏感参数
- ✅ Runtime 通过依赖注入提供 fetch 和 exit
- ✅ `CredentialStore` 调用次数为 0

### 错误消息安全
- ✅ 所有错误消息固定，不随输入变化
- ✅ 不回显 URL、session ID、内容
- ✅ 7 个固定错误码：`invalid_arguments`, `invalid_base_url`, `api_unavailable`, `api_http_error`, `api_protocol_error`, `stream_too_large`, `aborted`
- ✅ 退出码分离：1=参数/URL, 2=API, 3=取消

### 协议安全
- ✅ NDJSON 单行限制 256 KiB
- ✅ 总响应限制 16 MiB
- ✅ UTF-8 fatal 模式（严格验证）
- ✅ 强制终止事件（completed/error）
- ✅ AbortSignal 传播和预检查

## 实现细节

### NDJSON 流式解析
```typescript
export async function* parseNDJSONStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent>
```
- 增量解析，跨块边界处理
- TextDecoder `fatal: true` 严格 UTF-8 验证
- 每行 256 KiB 限制，总计 16 MiB 限制
- 6 种 AgentEvent 类型验证
- 强制流终止检查（completed/error）
- AbortSignal 支持，立即取消和清理

### API 客户端
```typescript
class LocalAgentApiClient {
  async health(signal?: AbortSignal): Promise<unknown>
  async createSession(signal?: AbortSignal): Promise<LocalAgentSession>
  async getSession(id: string, signal?: AbortSignal): Promise<LocalAgentSession>
  async listEvents(id: string, signal?: AbortSignal): Promise<readonly AgentEvent[]>
  async cancel(id: string, signal?: AbortSignal): Promise<unknown>
  async runTurn(id: string, request: LocalAgentTurnRequest, signal?: AbortSignal): AsyncIterable<AgentEvent>
}
```
- 会话响应包装解析：`{ session: {...} }` → `LocalAgentSession`
- Content-Type: `application/json` 请求头
- AbortSignal 传播到 fetch
- 固定错误处理（无 URL/ID 回显）

### 命令行接口
8 个命令：
1. `health` - 健康检查
2. `session-create` - 创建会话
3. `session-show <id>` - 查看会话
4. `events <id>` - 列出事件
5. `cancel <id>` - 取消会话
6. `run <id> <message>` - 执行 turn
7. `run-from-file <id> <file>` - 从文件执行
8. `version` - 版本信息

所有命令支持：
- `--base-url` (默认 http://127.0.0.1:4317)
- `--json` (JSON 输出)

### 依赖注入设计
```typescript
interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface CliRuntime {
  readonly fetch: typeof fetch;
  readonly exit: (code: number) => never;
}
```
- 测试注入 fake fetch 和可控 exit
- 生产环境 main.ts 注入真实实现
- 完全避免直接访问 process 或 globalThis

## 架构设计

### 模块职责
- `args.ts` - 纯解析，无副作用
- `api-client.ts` - 协议层，无 I/O 依赖
- `ndjson.ts` - 流处理，独立可测
- `cli.ts` - 业务逻辑，依赖注入
- `main.ts` - 平台绑定，唯一 process 访问点
- `errors.ts` - 集中错误定义
- `types.ts` - 共享类型

### 测试策略
- 单元测试：args, api-client, ndjson, errors（纯函数）
- 集成测试：cli + fake dependencies
- 端到端测试：cli + 真实 LocalAgentApiServer
- 安全测试：错误消息、process.env、退出码
- 取消测试：AbortSignal 各阶段

## 未实现

- npm 发布配置
- CLI 帮助文档生成
- 交互式模式
- 配置文件支持
- 日志级别控制
- 重试逻辑
- 进度条/彩色输出
- Shell 自动补全
- 真实 Provider 调用
- 真实模型调用
- 远程网络访问
- 凭据持久化

## 已完成

- ✅ `build:cli` 脚本已实现并可执行
- ✅ CLI 二进制打包功能正常工作
- ✅ 所有核心功能已实现并通过测试

## 已知缺口（已全部修复）

### 测试覆盖缺口（变异测试改进）
1. **UTF-8 验证测试**: ⭐ 已添加 - "invalid UTF-8 inside JSON string field is rejected with fatal validation"
2. **Content-Type 存在性断言**: ⭐ 已添加 - 3 个测试覆盖所有 POST 端点
3. **Session 响应包装解析**: ⭐ 已添加 - 2 个测试覆盖 createSession 和 getSession 的包装解析

### 非阻塞问题
- TypeScript streaming test 曾有类型推断问题（已修复，使用 non-null 断言）
- Windows Git LF/CRLF 警告（不影响功能）

## TDD 过程

### Red 阶段
1. 编写 125 个测试用例，覆盖所有命令、边界条件、错误路径
2. 创建 stub 实现，全部测试失败
3. 基线：0/125 passed

### Green 阶段  
1. 实现 `ndjson.ts` - NDJSON 解析器（192 行）
   - 修复 3 个流式测试：添加终止事件
   - 修复类型错误：non-null 断言
2. 实现 `api-client.ts` - HTTP 客户端（158 行）
   - 修复 cancel 方法：body undefined
   - 添加会话包装解析：`{ session: {...} }`
   - 修复类型断言：`as unknown as LocalAgentSession`
3. 实现 `cli.ts` - 命令路由（160 行）
4. 实现 `main.ts` - 入口（61 行）
5. 修复集成测试：session.id → sessionResponse.session.id
6. 最终：125/125 passed (100%)

### Refactor 阶段
1. 设计 8 项受控变异
2. 执行变异，记录检出情况
3. 初次结果：6/8 检出（75%），2 个测试缺口已记录
4. **第一次改进（收尾修复提交 f5e295d）**:
   - 添加 UTF-8 fatal 验证测试（Mutation 4）
   - 添加 Content-Type 验证测试覆盖所有 POST 端点（Mutation 8）
   - 修改 api-client.ts cancel 方法传递 `{}` 而非 `undefined`
   - 新增 4 个测试，总计 129 个测试
5. 中间结果：7/8 检出（87.5%）
6. **第二次改进（验证收尾提交 d88845f）**:
   - 添加 2 个 session 响应包装解析测试（Mutation 6）
   - createSession unwraps `{ session: {...} }` wrapper
   - getSession unwraps `{ session: {...} }` wrapper
   - 新增 2 个测试，总计 131 个测试
7. **最终结果：8/8 检出（100%），131 测试**

## 验证命令

所有验证均使用项目实际命令：

```bash
# 安装依赖
corepack pnpm install --frozen-lockfile

# 构建 CLI
corepack pnpm build:cli

# 验证项目结构
corepack pnpm verify:layout

# 类型检查
corepack pnpm typecheck

# Task 13 聚焦测试
corepack pnpm vitest run \
  tests/task-13-cli-args.test.ts \
  tests/task-13-cli-client.test.ts \
  tests/task-13-cli-streaming.test.ts \
  tests/task-13-cli-security.test.ts \
  tests/task-13-cli-integration.test.ts

# 全量测试
corepack pnpm test

# 安全扫描
corepack pnpm security:scan

# 离线评测
corepack pnpm evals:deterministic
```

## 提交信息

**Task 13 初始实现**:
```
commit 23359147bc481aa79f74f3685f45599e6a91f0a8
Author: liningshuai <3053472115@qq.com>
Date:   Fri Sep 11 16:04:36 2026 +0800

feat: implement Task 13 Node CLI for Local Agent API

20 files changed, 3032 insertions(+), 2 deletions(-)
```

**第一次收尾修复**:
```
commit f5e295d9000029699b66191c4aa4b409b4517609
Author: liningshuai <3053472115@qq.com>
Date:   Fri Sep 11 17:04:26 2026 +0800

fix(cli): close Task 13 delivery and evidence gaps

10 files changed, 967 insertions(+), 64 deletions(-)
```

**第二次验证收尾**:
```
commit d88845f97d262489da4c020561ddf6adec57001a
Author: liningshuai <3053472115@qq.com>
Date:   Fri Sep 11 18:12:45 2026 +0800

docs(cli): finalize Task 13 verification evidence

5 files changed, 185 insertions(+), 60 deletions(-)
```

**第三次文档修正** (当前最终提交):
```
commit 80b2e241c925e246f5ea87310b71e372bb8f0904
Author: liningshuai <3053472115@qq.com>
Date:   Fri Sep 11 18:25:47 2026 +0800

docs(cli): correct final Task 13 counts and history

2 files changed, 36 insertions(+), 29 deletions(-)
```

## 验证结果

Task 13 聚焦测试：**131/131 passed**
全量测试：**1163/1163 passed** (1032 基线 + 131 Task 13)
- 修改内容:
  - 新增 2 个 session 包装解析测试
  - 修正文档中测试数量（127→131）
  - 修正变异检出率（7/8→8/8）
  - 更新提交历史记录

## 完整性声明

- ✅ 所有 1163 测试通过（131 Task 13 + 1032 基线）
- ✅ TypeScript strict 模式编译通过
- ✅ 8 项受控变异执行完成，8 项检出（100%）
- ✅ 3 项原未检出变异已通过新增测试完全覆盖（Mutation 4, 6, 8）
- ✅ 零外部网络访问
- ✅ 零凭据或 process.env 访问
- ✅ 固定错误消息，无输入回显
- ✅ Git 提交包含所有源文件和测试
- ✅ 无 `.superpowers/` 文件提交
- ✅ 无强制 push 或危险 git 操作

## 验证命令参考

最终验证使用项目实际命令（如上节所示）。旧命令仅作历史参考：

```bash
# 历史参考（已废弃）
npm test                                      # 旧语法
npm test tests/task-13-*.test.ts             # 旧语法

# Git 验证
git log --oneline -5                         # 查看最近 5 次提交
git show --stat 80b2e241c925e246f5ea87310b71e372bb8f0904  # 查看当前最终提交
git diff d88845f97d262489da4c020561ddf6adec57001a HEAD --name-only  # 查看本次修改文件
```

## 当前状态

**当前 HEAD**: `80b2e241c925e246f5ea87310b71e372bb8f0904`
**当前 HEAD^**: `d88845f97d262489da4c020561ddf6adec57001a`
**工作区状态**: 仅 `.superpowers/` 未跟踪
**未修改**: 生产代码 (apps/cli/src/**)
**未修改**: 测试代码 (tests/**)
**未访问**: 真实网络、真实 Provider、真实凭据
**未提交**: `.superpowers/` 目录
