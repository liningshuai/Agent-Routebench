# Task 10 验证报告

## 范围

Provider 健康检查与模型目录发现：`@agent-workbench/provider-discovery`。

## 基线

- HEAD: `592c4129f7ba8d1e91d3699b09d005da6b1013c9`
- 父提交: `cf2c2d5b4abebefb64640d91fcbfb1b54a0ba3e4`
- 分支: `workbench/agent-core`
- 工作区: 仅 `.superpowers/` 未跟踪

## 新增包

`packages/provider-discovery/`

- `src/types.ts` — Health / Catalog / HttpClient 类型
- `src/errors.ts` — 稳定错误码
- `src/parse.ts` — 目录解析 + 有界 body 读取
- `src/discovery.ts` — `createProviderDiscovery`
- `src/index.ts` — 包入口

依赖：仅 `@agent-workbench/provider-registry`、`@agent-workbench/model-gateway`。

**说明**：`packages/model-gateway/package.json` 原先缺少 `types`/`exports`，导致无法按包名解析。已补齐包元数据（非业务源码），未修改任何 model-gateway 业务逻辑。

## 测试

| 文件 | 数量 |
|------|------|
| task-10-provider-discovery.test.ts | 19 |
| task-10-provider-discovery-protocol.test.ts | 28 |
| task-10-provider-discovery-security.test.ts | 12 |
| task-10-provider-discovery-cancellation.test.ts | 9 |
| **合计** | **68** |

全量：36 文件 / 872 测试（804 + 68）。

## 受控变异（10 项执行，全部检出）

| # | 变异 | 检出 |
|---|------|------|
| 1 | Anthropic endpoint 改为 `/models` | 是 |
| 2 | OpenAI endpoint 改为 `/v1/models` | 是 |
| 3 | 交换 Anthropic / OpenAI 认证头 | 是 |
| 4 | GET 请求加入 body | 是 |
| 5 | 非 2xx 时读取 body | 是 |
| 6 | 忽略 credentialRef 缺失 | 是 |
| 7 | 重复 model id 继续成功 | 是 |
| 8 | 删除响应体大小限制 | 是 |
| 9 | 删除预取消检查 | 是 |
| 10 | 不向 HttpClient 传递 AbortSignal | 是 |
| 12 | 把原始响应写入异常 | 是 |

未执行 #11（自动 retry）：本包无重试路径，注入该变异需要新增业务逻辑，超出小修范围。恢复后 Task 10 聚焦测试 68/68 通过。

## 网络与凭据

- 无真实外部网络；测试全部使用注入 fake HttpClient
- `globalThis.fetch` 调用次数断言为 0
- `CredentialStore.set` / `delete` 调用次数为 0
- Registry `registerProvider` / `updateProvider` 调用次数为 0
- secret 不进入返回值、错误消息、URL

## 未实现

- CLI / Desktop / Tauri / Web UI
- Health cache / Model list cache
- 自动更新 Provider.models / Route
- 真实 Provider 调用 / API Key 验证
- Retry / Failover
- 数据库 / 文件持久化 / OS Keychain

## 已知问题

- Task 8 遗留：`security-scan.mjs` 对 `*_SYNTHETIC_SECRET` 的放行仍在；本任务未修改该文件，也未扩大放行。
- 测试 fixture 使用中性值 `fixture-credential-value`，避免触发扫描规则。
- 测试全绿不代表不存在其他缺陷。
