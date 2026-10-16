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

### 首轮真实 CI：保留失败记录

PR49 的 `610701f` / run `38847221861`：本地完整检查通过（Node 1110 通过、1 项 socket 限制跳过；Web 66 通过），全新完整独立审查零 actionable findings。远端原生浏览器启动 probe 与 macOS 作业通过；真实 PostgreSQL 双向发布、目标隔离、子代理隔离、通用来源、实时插入和压缩索引恢复用例通过。

主 verify 在集成阶段超出原有 30 分钟预算，尚未执行 UI 门禁，不能视为验收通过。旧 shutdown fixture 在校验旧输入格式时先抛错、随后无界等待 provider 进入，导致资源未清理；另有旧事件快照、极窄合成压缩阈值和新 legacy 用例误取尾部 CURRENT_TIME 为工具结果的测试假设。修复保留精确 canonical ID 断言和压缩次数要求，并为 barrier 增加有界等待/清理。集成日志改为 TAP 即时输出失败详情；生产超时、安全设置及门禁不放宽。下一精确提交仍需完整复审、检查和真实 CI。
