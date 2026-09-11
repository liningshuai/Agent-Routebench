# Task 13 受控变异报告

## 8 项受控变异执行结果

| # | 变异 | 目标文件 | 预期检出 | 实际结果 |
|---|------|----------|----------|----------|
| 1 | 删除 NDJSON 终止事件验证 | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (2 failed) |
| 2 | 删除 loopback 地址验证 | apps/cli/src/args.ts | task-13-cli-args.test.ts | ✅ 检出 (5 failed) |
| 3 | 删除单行大小限制（256 KiB） | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (1 failed) |
| 4 | 删除 UTF-8 fatal 验证 | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ❌ 未检出 (0 failed) |
| 5 | 修改固定错误消息为动态 | apps/cli/src/errors.ts | task-13-cli-security.test.ts | ✅ 检出 (1 failed) |
| 6 | 删除 session 响应包装解析 | apps/cli/src/api-client.ts | task-13-cli-integration.test.ts | ✅ 检出 (1 failed) |
| 7 | 忽略 AbortSignal 预检查 | apps/cli/src/ndjson.ts | task-13-cli-streaming.test.ts | ✅ 检出 (2 failed) |
| 8 | 删除 Content-Type 请求头 | apps/cli/src/api-client.ts | task-13-cli-client.test.ts | ❌ 未检出 (0 failed) |

## 检出率

- **成功检出**: 6/8 (75%)
- **未检出**: 2/8 (25%)

## 详细说明

### Mutation 1: 删除 NDJSON 终止事件验证 ✅
- **变异**: `if (!terminated)` → `if (false)`
- **结果**: 2 tests failed / 25 passed
- **检出测试**: task-13-cli-streaming.test.ts 中缺少终止事件的测试

### Mutation 2: 删除 loopback 地址验证 ✅
- **变异**: 删除 `if (host !== "127.0.0.1" && host !== "localhost")` 检查
- **结果**: 5 tests failed / 54 passed  
- **检出测试**: task-13-cli-args.test.ts 中对 `http://example.com` 等外部URL的拒绝测试

### Mutation 3: 删除单行大小限制 ✅
- **变异**: `if (line.length > MAX_LINE_BYTES)` → `if (false)`
- **结果**: 1 test failed / 26 passed
- **检出测试**: task-13-cli-streaming.test.ts 中超大行测试

### Mutation 4: 删除 UTF-8 fatal 验证 ❌
- **变异**: `{ fatal: true }` → `{ fatal: false }`
- **结果**: 0 tests failed / 27 passed
- **原因**: 测试套件中缺少无效 UTF-8 序列测试
- **建议**: 添加测试验证非法 UTF-8 字节序列被拒绝

### Mutation 5: 修改固定错误消息为动态 ✅
- **变异**: 错误消息添加时间戳 `+ " [" + Date.now() + "]"`
- **结果**: 1 test failed / 9 passed
- **检出测试**: task-13-cli-security.test.ts 中 "fixed error messages do not vary by input" 测试

### Mutation 6: 删除 session 响应包装解析 ✅
- **变异**: 跳过 `{ session: {...} }` 包装解析，直接验证响应
- **结果**: 1 test failed / 2 passed
- **检出测试**: task-13-cli-integration.test.ts 中实际服务器集成测试

### Mutation 7: 忽略 AbortSignal 预检查 ✅
- **变异**: `if (signal?.aborted)` → `if (false && signal?.aborted)`
- **结果**: 2 tests failed / 25 passed
- **检出测试**: task-13-cli-streaming.test.ts 中 "pre-aborted signal rejects immediately" 测试

### Mutation 8: 删除 Content-Type 请求头 ❌
- **变异**: 删除 `headers["Content-Type"] = "application/json"` 行
- **结果**: 0 tests failed / 26 passed
- **原因**: 测试捕获了 content-type 但未验证其存在或正确性
- **建议**: 修改测试增强断言，确保 Content-Type 为 "application/json" 而非空字符串

## 测试覆盖缺口

基于未检出的变异，发现以下测试覆盖缺口：

1. **UTF-8 验证**: 缺少针对非法 UTF-8 字节序列的测试用例
2. **HTTP 请求头验证**: Content-Type 测试仅检查值，未验证头是否存在

## 执行记录

- 执行时间: 2026-09-11
- 执行者: Task 13 CLI Implementation
- 基线: 所有 1157 tests passed
- 变异后恢复: 每次变异后立即恢复源文件
