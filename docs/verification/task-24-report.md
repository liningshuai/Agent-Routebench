# Task 24 验证报告

## 基线

- HEAD: `3649efd92d75240c1e37edd7feb836fb0b766934`
- HEAD^: `6389020193602e2b4c4be368ba5e32d4b2b4c93a`
- 分支: `workbench/agent-core`

## 修改文件

| 文件 | 用途 |
|------|------|
| `apps/desktop/src-tauri/src/proxy.rs` | 新增 `NodeSidecarBackend` + `NativeEventSink` + 测试 |
| `apps/desktop/src-tauri/src/errors.rs` | 新增 proxy 错误码 |
| `apps/desktop/src-tauri/src/lib.rs` | 生产 runtime wiring 到 proxy |
| `packages/local-agent-api/src/server.ts` | 新增 `x-agent-turn-id` header |
| `tests/task-24-native-proxy.test.ts` | 集成测试（5） |
| `tests/task-24-native-proxy-security.test.ts` | 安全测试（5） |
| `tests/task-24-native-proxy-streaming.test.ts` | 流式测试（4） |
| `tests/task-24-native-proxy-cancellation.test.ts` | 取消测试（3） |
| `tests/task-24-native-proxy-integration.test.ts` | 端到端测试（2） |
| `tests/task-19-native-runtime.test.ts` | 更新 production wiring 断言 |
| `tests/task-19-native-runtime-security.test.ts` | 更新 production wiring 断言 |
| `docs/native-proxy.md` | 设计文档 |
| `docs/architecture.md` | 追加 Task 24 段落 |

## 测试数量

- Rust: 93（新增 ~17 proxy 测试）
- TypeScript: 1795 全量（新增 19 Task 24 测试）

## 验证命令

```text
corepack pnpm install --frozen-lockfile → 0
corepack pnpm verify:layout             → 0
corepack pnpm typecheck                 → 0
corepack pnpm build:local-agent-host    → 0
corepack pnpm build:desktop             → 0
corepack pnpm test                      → 0（1795 passed）
corepack pnpm security:scan             → 0
corepack pnpm evals:deterministic       → 0
cargo fmt --check                       → 0
cargo check                             → 0
cargo test --lib                        → 0（93 passed）
git diff --check                        → 0
```

## 边界声明

- 没有真实 Provider 调用 / 真实网络 / 真实凭据
- 没有修改 `.superpowers/`
- NotReady Host 的 turn 产生固定 `runner_error`，不伪造 `completed`
- 测试全绿不代表不存在其他缺陷
