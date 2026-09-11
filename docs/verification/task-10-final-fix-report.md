# Task 10 最终小修报告

## 范围

修复两个 P1 缺陷，不开始 Task 11，不新增其他功能。

## 基线

- HEAD: `b170f706209b073219c65bcf8229d18b0ef6d287`
- 父提交: `592c4129f7ba8d1e91d3699b09d005da6b1013c9`
- 分支: `workbench/agent-core`

## 缺陷与修复

### 缺陷 1：HTTP Promise 永不结束时无法及时取消

**根因**：`fetchCatalogText` 使用 `await httpClient(request)`。若 HTTP Promise 永不 settle，`AbortSignal` 无法及时结束调用。

**修复**：HTTP Promise 与 AbortSignal 竞速。

- HTTP Promise 一创建就安装 resolve/reject 处理器
- 与 abort Promise 竞速；abort 胜出时立即抛 `aborted`
- 迟到 resolve 时主动 `releaseResponseBody`
- 迟到 reject 被消费，不产生 unhandled rejection
- 不等待挂起的 HTTP Promise 或 body `return()`

### 缺陷 2：非法 UTF-8 被静默替换

**根因**：`TextDecoder("utf-8", { fatal: false })` 把非法字节替换为 `�`，表面合法的 JSON 仍可解析成功。

**修复**：改为 `fatal: true`；解码异常折叠为固定 `provider_protocol_error`。

## 修改文件

| 文件 | 变更 |
|------|------|
| `packages/provider-discovery/src/discovery.ts` | HTTP/abort 竞速 + 迟到 body 释放 |
| `packages/provider-discovery/src/parse.ts` | `fatal: true` UTF-8 解码 |
| `tests/task-10-provider-discovery-cancellation.test.ts` | +5 挂起取消回归 |
| `tests/task-10-provider-discovery-protocol.test.ts` | +4 非法 UTF-8 回归 |
| `docs/provider-discovery.md` | 边界说明更新 |
| `docs/verification/task-10-final-fix-report.md` | 本报告 |

未修改：`security-scan.mjs`、`evals-deterministic.mjs`、`README.md`、`architecture.md`、其他 packages、`.superpowers/`、lockfile。

## Red 证据

```text
corepack pnpm test tests/task-10-provider-discovery-cancellation.test.ts tests/task-10-provider-discovery-protocol.test.ts
退出码: 1
关键失败:
  - hanging HTTP listModels / checkProvider → 超时（timed out waiting for abort）
  - invalid UTF-8 → 错误地成功返回含 � 的 catalog
```

## Green 证据

```text
corepack pnpm test tests/task-10-provider-discovery-cancellation.test.ts tests/task-10-provider-discovery-protocol.test.ts
退出码: 0
输出: Test Files 2 passed (2); Tests 46 passed (46)
```

## 新增测试（9）

挂起取消（5）：

1. listModels HTTP 永不 settle → abort 后有界时间内 `aborted`，HTTP 调用 = 1
2. checkProvider HTTP 永不 settle → `status: "aborted"`
3. 迟到 resolve → 调用方无 catalog，body 被释放
4. 迟到 reject → 无 unhandled rejection
5. 并发隔离：A 挂起取消、B 正常 healthy

非法 UTF-8（4）：

1. JSON 字符串值内非法字节 → `provider_protocol_error`
2. 非法字节跨 chunk → 拒绝
3. JSON 外非法字节（表面合法 JSON）→ 拒绝
4. 不返回含 `�` 的 catalog

保留：合法中文 / emoji / 多 chunk UTF-8 / ASCII / body 限制 / iterator 释放。

## 全量测试

```text
881（基线 872 + 9）；Task 1–10 全部通过
```

## 受控变异（5 项）

| # | 变异 | 检出 |
|---|------|------|
| 1 | 删除 HTTP/AbortSignal 竞速 | 是（5 失败 / 超时） |
| 2 | 删除迟到 resolve 的 body release | 是 |
| 3 | `fatal: true` 改回 `fatal: false` | 是（3 失败） |
| 4 | 删除迟到 reject 的早期 consumer | **否**（abort 路径的 consumer 已覆盖同一行为） |
| 5 | 删除 abort 后的最终状态检查 | 是 |

**4/5 检出**。变异 4 为防御性冗余：abort 胜出分支同样安装了 reject consumer。

## 验证命令

```text
corepack pnpm install --frozen-lockfile   → 0
corepack pnpm verify:layout               → 0
corepack pnpm typecheck                   → 0
corepack pnpm test tests/task-10-*.test.ts → 0（77）
corepack pnpm test                        → 0（881）
corepack pnpm security:scan               → 0
corepack pnpm evals:deterministic         → 0
git diff --check                          → 0
```

## 边界声明

- 没有真实 Provider 调用 / 真实外部网络
- 没有新增 retry / failover / 缓存
- 没有修改 Provider Registry / CredentialStore
- 没有开始 Task 11
- 测试全绿不代表不存在其他缺陷
- Task 8 security scan 放行问题仍在，本小修未触碰
