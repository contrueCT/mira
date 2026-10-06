# GitHub 工作流

共享规则见 [根 AGENTS.md](../AGENTS.md)，工具链专项规则见 [scripts/AGENTS.md](../scripts/AGENTS.md)。本文路径相对于 `.github/`。

当前只有 `workflows/ci.yml`，运行类型、依赖、离线测试、PostgreSQL 18.6 集成/恢复测试与工具构建，新增 Web 构建、Chromium 合成交互与截图 artifact；没有真实模型、部署或发布流程。修改后执行根 `pnpm check` 并核对远端 PR 确切 head 的 CI。

保持只读权限、Action 完整 SHA 固定和 `persist-credentials: false`。不要自动添加 `pull_request_target`、secret 暴露、自动合并或部署。未获允许的权限、凭据及发布行为先向用户确认。
