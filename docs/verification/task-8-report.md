# Task 8 验证报告

## 范围

非敏感 Provider / Route 配置持久化：`@agent-workbench/local-persistence`。

## 基线

- 基线 HEAD：`354b4d50d2c2024a1b7efcd449f37e0e186b0a54`（Task 7）
- 工作区：仅 `.superpowers/` 未跟踪

## 新增包

`packages/local-persistence/`

- `src/types.ts` — `PersistedConfigV1`
- `src/errors.ts` — `PersistenceError` + 稳定错误码
- `src/snapshot.ts` — 快照创建 / 校验 / Registry 恢复
- `src/json-store.ts` — `JsonConfigStore` + `InMemoryJsonConfigStore`
- `src/file-store.ts` — `createFileJsonConfigStore` 原子文件存储
- `src/index.ts` — 包入口

依赖：仅 `@agent-workbench/provider-registry`（workspace）与 Node 内置 `node:fs/promises` / `node:path`。

## 测试

| 文件 | 数量 |
|------|------|
| `tests/task-8-persistence-snapshot.test.ts` | 37 |
| `tests/task-8-persistence-file.test.ts` | 29 |
| `tests/task-8-persistence-security.test.ts` | 18 |
| `tests/task-8-persistence-concurrency.test.ts` | 14 |
| **合计** | **98** |

## 原子写入证明

- 临时文件与目标同目录（`.{basename}.{ts}.tmp`）
- rename 失败时抛 `config_file_replace_failed`，不写目标
- 非法 snapshot 不改变旧文件
- 成功 save 后目录内无残留临时文件
- 并发 save 串行化，无交叉混写

## 非敏感边界证明

- `credentialRef: "credential:test-provider"` 允许保存
- `credential:test-provider-secret-value` 被拒绝
- secret / apiKey / headers / Authorization 字段被拒绝
- 文件内容 marker 扫描：`TASK8_SYNTHETIC_SECRET` 等永不出现
- CredentialStore 中的 secret 不进入快照
- 环境变量不被读取

## 受控变异（12 项）

| # | 变异 | 检出 |
|---|------|------|
| 1 | 删除 version 校验 | 是 |
| 2 | 接受未知 root 字段 | 是 |
| 3 | 跳过 secret-like 字段检查 | 否（`ALLOWED_*_FIELDS` 已覆盖同一批字段，属冗余防护） |
| 4 | 直接覆盖目标文件（无 temp+rename） | 是 |
| 5 | 允许相对路径 | 是 |
| 6 | 读取不存在文件时抛错 | 是 |
| 7 | load 返回内部可变引用 | 是 |
| 8 | 内存 save 不串行 | 是 |
| 9 | 异常原文放入错误消息 | 是 |
| 10 | 恢复失败返回部分 Registry | 是 |
| 11 | 非法 save 覆盖旧值 | 是 |
| 12 | 接受不支持的 version | 是 |

11/12 检出；1 项为防御性冗余检查，已被允许字段校验覆盖。

## 明确未实现

- 真实模型调用 / 真实 Provider / 网络访问
- CredentialStore / OS Keychain 持久化
- Session / Memory / 上下文压缩
- Local Agent API / CLI / Desktop
- Agent Loop 重试 / 审批 UI
