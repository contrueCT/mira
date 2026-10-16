# 指定消息回复与时间线验收

## 范围

对应 [ADR 0043](../adr/0043-message-replies-timeline.md)。保留单条浅色聊天界面，新增稀疏时间分隔、气泡外时间/来源、用户引用 Mira 与 Mira 显式引用用户。引用是服务端验证的 History 身份和有界原文快照，不是第三方发送许可。

## 测试入口

- `pnpm check`：严格类型、包边界、离线/组件测试和生产构建
- `pnpm test:integration`：真实 PostgreSQL 的输入、来源隔离、双向工具发布、恢复/重试与压缩回归
- `pnpm test:e2e`：既有合成 UI fixture，包括键盘/触屏、取消、分页查找、未知引用兜底
- `pnpm test:replies:e2e`：真实 Chromium → HTTP → PostgreSQL → Wake/runtime → `send_reply`，只有 provider 响应为确定性合成

新真实浏览器套件使用自然的合成出游对话及通用测试来源，覆盖正文和图片引用、取消/换目标、精确 canonical ID、唯一工具发布、丢失 HTTP 回执后的核对、重复/冲突、来源快照、重启及桌面/窄屏布局。它没有使用用户提供的私人聊天截图或真实账户信息。

截图由上述套件写入 `test-results/replies-real/`，作为 CI artifact 保留而不提交源码。真实模型是否自然选择正确的回复对象与正文属于额外质量验收，本套件不声称已验证。

## 执行记录

实现阶段本地 Web 66 项单元测试、Web 类型与生产构建通过；后台 replies/attachments/web-http 的 34 项聚焦测试通过。本地没有显式隔离 PostgreSQL 配置，浏览器受到执行器 socket 限制，因此这些本地检查不计为真实数据库或屏幕验收。冻结最终代码后的完整检查、独立审查及远端 CI 结果以 PR 的确切提交为准，未通过前不表示可合入。
