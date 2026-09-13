# Task 25 验证报告

## 基线

- HEAD: `b1221aeb3e098e3d7dbc3919d25700bcc75f0198`
- HEAD^: `5cfd240d58ee171619d377e378000fcdbae7d11b`
- 分支: `workbench/agent-core`

## 修改文件

| 文件 | 用途 |
|------|------|
| `apps/local-agent-host/src/configured-host.ts` | 新增配置启动引导模块 |
| `apps/local-agent-host/src/errors.ts` | 新增 config bootstrap 错误码 |
| `apps/local-agent-host/src/index.ts` | 导出新模块 |
| `scripts/build-local-agent-host.mjs` | 添加 local-persistence 到 vendor 列表 |
| `tests/task-25-config-bootstrap.test.ts` | 引导测试（15） |
| `tests/task-25-config-security.test.ts` | 安全测试（10） |
| `tests/task-25-config-lifecycle.test.ts` | 生命周期测试（10） |
| `tests/task-25-config-credentials.test.ts` | 凭据测试（6） |
| `tests/task-25-config-integration.test.ts` | 集成测试（6） |
| `tests/task-22-runnable-host-security.test.ts` | 排除 configured-host.ts 的 node:fs 检查 |
| `docs/config-bootstrap.md` | 设计文档 |
| `scripts/evals-deterministic.mjs` | 纳入 Task 25 必需文件与离线场景 |
| `docs/verification/task-25-report.md` | 本次验证与收尾记录 |

## 测试数量

- Task 25: 47（≥ 45）
- 全量: 1842（1795 + 47）

## 验证命令

```text
corepack pnpm install --frozen-lockfile → 0
corepack pnpm verify:layout             → 0
corepack pnpm typecheck                 → 0
corepack pnpm build:local-agent-host    → 0
corepack pnpm build:desktop             → 0
corepack pnpm test                      → 0（1842 passed）
corepack pnpm security:scan             → 0
corepack pnpm evals:deterministic       → 0
git diff --check                        → 0

## Task 25 收尾验证

本次收尾基于提交 `e3c3420c2028572e9788c21efa6e6d2c840c1315`，增加两条真实行为回归并补齐确定性评测入口：

- 新增非法端口边界回归，以及 `uses the loaded route, injected credential and fake HTTP client for a turn`，后者证明磁盘配置恢复的 Route、显式注入的 CredentialStore 和 fake HttpClient 贯通到一次成功 Turn。
- Task 25 聚焦测试：`5 files / 47 tests passed`。
- 确定性评测 Stage 1 现在包含 Task 25 的实现、测试、文档；Stage 2 新增 `task 25 secure configuration bootstrap` 场景。

## 收尾受控变异

以下 9 项变异均逐项执行、记录失败、原位恢复，并在恢复后重新验证：

| # | 变异 | 结果 | 代表性检出 |
|---:|---|---|---|
| 1 | 删除缺失配置文件检查 | 检出 | 缺失配置测试解析为成功 Host |
| 2 | 接受相对配置路径 | 检出 | 相对路径测试收到 `config_not_found` 而非 `invalid_config_path` |
| 3 | 将非法配置统一映射为 `config_not_found` | 检出 | 非法快照、敏感字段、版本和孤立 Route 测试失败 |
| 4 | 启动阶段读取 CredentialStore | 检出 | 启动 `getCalls` 从 0 变为 1 |
| 5 | 删除 CredentialStore 形状校验 | 检出 | null、数组、primitive 和缺失方法测试失败 |
| 6 | 删除配置入口的 loopback 校验 | 检出 | 非 loopback Host 返回错误类型 |
| 7 | 放宽 port 0 | 检出 | 非法端口测试收到 Host 层 `invalid_port` |
| 8 | 不把组装好的 Runner 传给 Host | 检出 | 成功 Turn 无 `text_delta`，fake HTTP 未调用 |
| 9 | 丢弃磁盘 Registry、替换为空 Registry | 检出 | 成功 Turn 的配置 Route、凭据和 fake HTTP 回归失败 |

变异总数：`9/9` 执行并检出。所有临时变异均已恢复，源码无 mutation 标记或备份残留。

## 收尾后验证

```text
corepack pnpm typecheck                 → 0
corepack pnpm test（Task 25 五个显式文件） → 0（47 passed）
corepack pnpm test                      → 0（1842 passed）
corepack pnpm verify:layout             → 0
corepack pnpm security:scan             → 0
corepack pnpm evals:deterministic       → 0（包含 Task 25 场景）
git diff --check                        → 0
git diff --cached --check               → 0
```
```

## 边界声明

- 没有真实 Provider 调用 / 真实网络 / 真实凭据 / 环境变量访问
- 没有 OS Keychain / 配置 UI
- 没有修改 `.superpowers/`
- 测试全绿不代表不存在其他缺陷
