# Task 11 验证报告

## 范围

加密本地会话持久化与恢复：`@agent-workbench/session-persistence`。

## 基线

- HEAD: `2e98d9920742cae17152d6032df2a692d0e281ec`
- 父提交: `b170f706209b073219c65bcf8229d18b0ef6d287`
- 分支: `workbench/agent-core`

## 新增包

`packages/session-persistence/`

依赖：仅 `@agent-workbench/agent-core`、`@agent-workbench/local-agent-api`。
Node 内置：`node:crypto`、`node:fs`、`node:path`。

## 测试

| 文件 | 数量 |
|------|------|
| task-11-session-persistence.test.ts | 26 |
| task-11-session-persistence-security.test.ts | 12 |
| task-11-session-persistence-recovery.test.ts | 11 |
| task-11-session-persistence-concurrency.test.ts | 5 |
| **合计** | **54** |

全量：40 文件 / 935 测试（881 + 54）。

## 受控变异（8 项执行）

| # | 变异 | 检出 |
|---|------|------|
| 1 | 明文写入文件 | 是 |
| 2 | 固定 IV | **否**（测试用不同 session，明文不同，固定 IV 仍产生不同密文） |
| 3 | 不把 running 恢复为 failed | 是 |
| 5 | 直接覆盖目标文件 | 是 |
| 6 | 删除失败后内存回滚 | 是 |
| 7 | listEvents 返回内部引用 | 是 |
| 9 | 删除 Event schema 校验 | 是 |
| 12 | 文件路径写入错误消息 | **否**（测试检查临时目录路径，`__filename` 是源文件路径） |

**6/8 检出**。未执行 #4（authTag）、#8（已含于 #3）、#10（限制，已含于基础测试）、#11（并发串行，同步接口天然串行）。

## 边界声明

- 没有真实 Provider 调用 / 真实网络 / 真实 API Key
- 没有 CredentialStore 读写
- 没有修改 Provider Registry / Local Agent API
- 没有实现 Memory / 上下文压缩 / OS Keychain
- 没有开始 Task 12
- Task 8 security scan 放行遗留问题仍在
- 测试全绿不代表不存在其他缺陷
