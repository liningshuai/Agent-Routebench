# Task 13 受控变异报告

## 8 项受控变异执行结果

| # | 变异 | 目标文件 | 预期检出 | 实际结果 |
|---|------|----------|----------|----------|
| 1 | 删除 NDJSON 终止事件验证 | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (2 failed) |
| 2 | 删除 loopback 地址验证 | apps/cli/src/args.ts | task-13-cli-args.test.ts | ✅ 检出 (5 failed) |
| 3 | 删除单行大小限制（256 KiB） | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (1 failed) |
| 4 | 删除 UTF-8 fatal 验证 | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (1 failed) ⭐ |
| 5 | 修改固定错误消息为动态 | apps/cli/src/errors.ts | task-13-cli-security.test.ts | ✅ 检出 (1 failed) |
| 6 | 删除 session 响应包装解析 | apps/cli/src/api-client.ts | task-13-cli-client.test.ts | ✅ 检出 (2 failed) ⭐ |
| 7 | 忽略 AbortSignal 预检查 | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (2 failed) |
| 8 | 删除 Content-Type 请求头 | apps/cli/src/api-client.ts | task-13-cli-client.test.ts | ✅ 检出 (3 failed) ⭐ |

## 检出率

- **成功检出**: 8/8 (100%)
- **改进**: 3 项原未检出或未覆盖变异现已通过新增测试检出 (Mutation 4, 6, 8)

## 详细说明

### Mutation 1: 删除 NDJSON 终止事件验证 ✅
- **变异**: `if (!terminated)` → `if (false)` (ndjson.ts line 42)
- **结果**: 2 tests failed / 26 passed
- **检出测试**: 
  - "stream without terminal event is rejected"
  - "empty stream is rejected"

### Mutation 2: 删除 loopback 地址验证 ✅
- **变异**: `if (host !== "127.0.0.1" && host !== "localhost")` → `if (false)` (args.ts line 30)
- **结果**: 5 tests failed / 54 passed  
- **检出测试**: task-13-cli-args.test.ts 中对外部 URL 的拒绝测试
  - "rejects http://example.com"
  - "rejects http://192.168.1.1:4317"
  - "rejects http://[::1]:4317"
  - "rejects http://0.0.0.0:4317"
  - "rejects http://my-server.local:4317"

### Mutation 3: 删除单行大小限制 ✅
- **变异**: `MAX_LINE_BYTES = 256 * 1024` → `MAX_LINE_BYTES = 999999999` (ndjson.ts line 4)
- **结果**: 1 test failed / 27 passed
- **检出测试**: "line exceeding 256 KiB is rejected"

### Mutation 4: 删除 UTF-8 fatal 验证 ✅ ⭐
- **变异**: `{ fatal: true }` → `{ fatal: false }` (ndjson.ts line 18)
- **结果**: 1 test failed / 27 passed
- **检出测试**: "invalid UTF-8 inside JSON string field is rejected with fatal validation" ⭐ NEW
- **改进**: 添加新测试构造包含非法 UTF-8 字节 (0xff, 0xfe) 的 JSON 字符串字段
- **技术细节**: 使用 Uint8Array 手动拼接 valid prefix + invalid bytes + valid suffix

### Mutation 5: 修改固定错误消息为动态 ✅
- **变异**: `CLI_ERROR_MESSAGES[key]` → `getDynamicMessage(key)` 返回 `"Error: ${key}"` (errors.ts line 27-28)
- **结果**: 1 test failed / 9 passed
- **检出测试**: "fixed error messages do not vary by input"

### Mutation 6: 删除 session 响应包装解析 ✅ ⭐
- **变异**: `if (response && typeof response === "object" && "session" in response)` → `if (false)` (api-client.ts lines 26-28, 37-39)
- **结果**: 2 tests failed / 29 passed
- **检出测试**: ⭐ NEW
  - "createSession unwraps { session: {...} } wrapper from server response"
  - "getSession unwraps { session: {...} } wrapper from server response"
- **改进**: 添加新测试验证当服务器返回 `{ session: {...} }` 包装格式时，客户端能正确解包
- **技术细节**:
  - 构造 fake fetch 返回 `{ session: { id, status, createdAt, updatedAt } }`
  - 断言返回值是内层 session 对象，不包含外层 wrapper
  - 删除包装解析逻辑后，测试失败（尝试验证包装对象而非 session）

### Mutation 7: 忽略 AbortSignal 预检查和循环检查 ✅
- **变异**: 两处 `if (signal?.aborted)` → `if (false)` (ndjson.ts lines 13-14, 32-34)
- **结果**: 2 tests failed / 26 passed
- **检出测试**: 
  - "AbortSignal already aborted before stream starts rejects immediately"
  - "AbortSignal stops iteration early"

### Mutation 8: 删除 Content-Type 请求头 ✅ ⭐
- **变异**: 注释掉 `init.headers = { "Content-Type": "application/json" }` (api-client.ts lines 106-108)
- **结果**: 3 tests failed / 26 passed
- **检出测试**: ⭐ NEW
  - "POST /v1/sessions sends application/json Content-Type"
  - "POST /v1/sessions/:id/cancel sends application/json Content-Type"
  - "POST /v1/sessions/:id/turns sends application/json Content-Type"
- **改进**: 添加新测试 describe block "POST Content-Type headers" 覆盖所有 3 个 POST 端点
- **技术细节**: 每个测试捕获 fetch init.headers 并验证 `Content-Type` 为 `"application/json"`

## 测试覆盖改进

基于原始未检出或未覆盖的变异，新增以下测试：

1. **UTF-8 验证 (Mutation 4)**: 
   - 新增测试: "invalid UTF-8 inside JSON string field is rejected with fatal validation"
   - 位置: tests/task-13-cli-streaming.test.ts line 415
   - 技术: 手动构造包含非法字节的 JSON 结构

2. **Session 响应包装解析 (Mutation 6)**:
   - 新增 2 个测试: "createSession unwraps { session: {...} } wrapper", "getSession unwraps { session: {...} } wrapper"
   - 位置: tests/task-13-cli-client.test.ts response validation describe block
   - 技术: fake fetch 返回包装格式，断言客户端返回解包后的 session

3. **HTTP Content-Type 验证 (Mutation 8)**:
   - 新增 describe block: "POST Content-Type headers"
   - 3 个新测试覆盖所有 POST 端点
   - 位置: tests/task-13-cli-client.test.ts
   - 同时修改 api-client.ts:53 传递 `{}` 而非 `undefined` 以确保 cancel 端点也发送 Content-Type

## 剩余测试覆盖缺口

**无剩余缺口** - 所有 8 项变异均已被检出，测试覆盖率达到目标。

## 执行记录

- **第一次执行**: 2026-09-11 (提交 f5e295d)
  - 基线: 所有 1161 tests passed (129 Task 13 + 1032 基线)
  - 初始检出率: 75% (6/8)
  - 改进: 新增 UTF-8 和 Content-Type 测试
  - 改进后检出率: 87.5% (7/8)

- **第二次执行**: 2026-09-11 (本次验证收尾)
  - 基线: 所有 1163 tests passed (131 Task 13 + 1032 基线)
  - 改进: 新增 2 个 session 包装解析测试
  - 最终检出率: 100% (8/8)

## 变异测试方法

每个变异按以下步骤执行：
1. 备份原始文件: `cp file file.backup`
2. 使用 `sed` 或手动 Edit 应用变异
3. 运行相关测试套件: `corepack pnpm vitest run tests/task-13-*.test.ts`
4. 记录失败测试数量和名称
5. 恢复原始文件: `mv file.backup file`
6. 验证恢复: 运行测试确保全部通过

## 结论

Task 13 CLI 实现通过 8 项受控变异验证，最终检出率 100%。三项原未检出或未覆盖变异 (UTF-8 fatal 验证、session 包装解析、Content-Type 请求头) 已通过新增测试完全覆盖。所有安全边界、协议约束和错误处理路径均有对应测试保护。
