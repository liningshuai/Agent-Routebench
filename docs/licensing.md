# 许可证边界

## 本项目自有代码

Agent Workbench 自有代码的目标许可证是 **Apache License 2.0**，见根目录
[LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。

## 与 CC Switch 的边界

- 当前不复制 CC Switch 源代码。
- 当前不继承 CC Switch 的 MIT 源码边界。
- CC Switch 不作为本项目的运行时依赖、npm/pnpm 依赖、Git submodule、
  数据库依赖、配置来源或 Provider 管理服务。
- 公开行为、文档描述和架构思想可以作为设计参考，但不能直接复制受限源码。

## 与其他项目的关系

- Claude Code 与 ZCode 不作为本项目的源码依赖。
- 本项目不声称兼容 Claude Code、Codex、ZCode 或 CC Switch 的私有协议。
- 如果未来需要借鉴其他项目的源码，必须在引入前单独完成许可证与版权审查，
  并在本文件中记录结论。

## 发布前检查

公开发布前必须生成完整的第三方依赖许可证清单，
并确认所有运行时与开发依赖的许可证与本项目兼容。
