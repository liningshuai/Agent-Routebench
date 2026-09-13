# Task 27 验证报告

## 首轮实现

Task 27 首轮提交新增了 `ConfigManager`、`DesktopConfigApiClient`、Tauri 配置 command 契约和 Provider/Route 管理测试。首轮基线为 `e14e0ac1577f01f75360c3468a68e781011bc211`，实现提交为 `f08d9399d44a417a2553c3b3969c8ad7ec05ee30`。

首轮实现已经覆盖：Provider/Route 校验、fallback 关系、原子持久化、失败回滚、并发串行化、客户端响应校验和敏感字段隔离。

## 返工补齐内容

首轮留下的配置闭环缺口已在后续返工中补齐：

- Local Agent API 已接入 `/v1/config`、`/v1/providers` 和 `/v1/routes` 固定 CRUD 端点。
- Node Local Agent Host 已把同一文件 store 连接到 ConfigManager，并支持显式首启空配置。
- Tauri `ConfigBackend` 已由 `NodeSidecarBackend` 通过固定 loopback 路径实现，非 2xx 响应不读取 body。
- Desktop 设置页已通过 `DesktopConfigApiClient` 接入 Provider/Route 表单，响应和输入再次执行白名单校验。
- Tauri sidecar 启动时传入 app-scoped 配置文件路径；错误和敏感字段不会跨 HTTP/IPC/UI 边界泄露。

详细返工证据见 [Task 27 rework report](task-27-rework-report.md)。

## 仍然保持的边界

- `credentialRef` 只表示引用，配置文件、配置 API 和 UI 不保存或展示 secret。
- 未连接真实 Provider，Provider-facing HTTP 仍由调用方显式注入 fake client。
- 未实现 OS Keychain、安装包、托盘、自动更新和远程配置服务。
