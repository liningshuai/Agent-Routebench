# Task 9 最终小修报告

## 范围

仅修复 Local Agent API 校验的 3 个问题，未重新实现整个 API。

## 基线

- HEAD: `cf2c2d5b4abebefb64640d91fcbfb1b54a0ba3e4`
- 父提交: `d8a66ccc9545b48575f8eb880119bf549735eb16`

## 修复内容

### 1. `parseApiOptions(null)` 崩溃

**问题**：`typeof null === "object"`，原首层校验放行 `null`，随后访问 `raw.host` 抛出原生 `TypeError`。

**修复**：显式拒绝 `null` / `undefined` / 数组 / 非 object，在任何字段访问前抛出固定 `invalid_request`。

`runner` / `store` 仍支持 class 实例（仅校验方法存在，不用 `isPlainObject`）。

### 2. 工具定义使用共享校验

**问题**：`parseTurnRequest()` 只手写 `name` / `description` 部分校验。

**修复**：改调用 `@agent-workbench/agent-core` 公开入口的 `validateAgentToolDefinitions()`。

现在会拒绝：缺失 `inputSchema`、非法 `inputSchema`、重复工具名、空工具名、非对象工具定义、敏感字段等。

### 3. 深层敏感字段 fail-closed

**问题**：`assertNoSensitiveFields()` 在深度 > 32 时静默 `return`，深层 `token` 可被绕过。

**修复**：深度超过 `MAX_SENSITIVE_SCAN_DEPTH = 32` 时抛出固定 `invalid_request`（fail-closed）。

## Red / Green 证据

### Red

```text
corepack pnpm test tests/task-9-local-api.test.ts tests/task-9-local-api-security.test.ts
退出码: 1
关键失败:
- createLocalAgentApiServer(null) → TypeError（非 PersistenceError）
- 缺失 inputSchema → 200（应 400）
- 重复 tool name → 200（应 400）
- 深层 token / Authorization（嵌在 inputSchema 内，深度 40）→ 200（应 400）
```

### Green

```text
corepack pnpm test tests/task-9-*.test.ts
退出码: 0
输出: Test Files 4 passed (4); Tests 65 passed (65)
```

## 新增回归测试（14）

- `createLocalAgentApiServer(null)` / `([])` / `("invalid")` / `(undefined)`
- class Runner 仍可用 / class Store 仍可用
- 缺失 `inputSchema` / 非对象工具定义 / 重复工具名 / 空工具名 / 合法完整工具
- 深层 `token`（depth 40 in inputSchema）
- 深层 `Authorization`（depth 40 in inputSchema）
- 工具定义携带 `apiKey`

说明：原计划的「非法 inputSchema（含函数）」测试在 HTTP 层无法成立——`JSON.stringify` 会丢弃函数，改为「非对象工具定义」以覆盖共享校验路径。

## 测试数量

```text
小修前全量: 790
小修后全量: 804（+14，未删除既有测试）
Task 9 文件: 65（51 + 14）
```

## 验证命令

```text
corepack pnpm typecheck                                    → 0
corepack pnpm test tests/task-9-*.test.ts                  → 0（65 passed）
corepack pnpm test                                         → 0（804 passed）
corepack pnpm security:scan                                → 0
corepack pnpm evals:deterministic                          → 0
git diff --check                                           → 0
```

## 未修改

- `packages/agent-contracts/**`、`packages/agent-core/**`、`agent-runtime`、`model-gateway`、`provider-registry`、`local-persistence`
- `scripts/security-scan.mjs`
- `.superpowers/**`、`cc-switch-agent/**`
- Task 1–8 测试与业务逻辑

## 未检出 / 环境问题

无新增未检出变异。本小修为缺陷修复，未执行受控变异套件（原 Task 9 变异结果仍见 `docs/verification/task-9-report.md`）。
