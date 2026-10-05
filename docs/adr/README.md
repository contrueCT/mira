# 决策记录

ADR 状态使用 `Proposed`、`Accepted`、`Superseded`。用户确认前不把建议标记为 Accepted。

## 已确认

- 项目名 Mira，私有 GitHub 仓库 `contrueCT/mira`
- TypeScript monorepo 及 [包边界](../architecture.md)
- 小步开发，重要选择先确认，每轮实现/修复独立审查
- 先基础结构与验证，再做 Pi 可行性实验，之后进入连续认知主循环
- Node.js 24 LTS、pnpm workspace、strict TypeScript ESM、Node 内置 test runner、GitHub Actions
- 文档与仓库说明先作为 main 初始提交，后续代码通过草稿 PR；合并仍需用户确认

- [ADR 0001：连续上下文与恢复](0001-durable-context.md)：数据库驱动/迁移、单写者、权威 envelope、Pi 主循环与压缩方式、顺序工具与待核对恢复

- [ADR 0002：合并唤醒与持续判断](0002-coalesced-wake-loop.md)：原子批次、恢复证据、模型可见不确定性、自然语言意图、普通文本溢出

## 待确认

| 决策 | 当前建议 / 需要验证 | 开始依赖它的工作前确认 |
| --- | --- | --- |
| Web/API/Schema | React/Next、Fastify/Hono、Zod/TypeBox 等尚未选定 | 服务端与 UI 实现 |
| 生成扩展隔离 | Cordis 不提供安全隔离；方案待单独确认 | 激活生成代码 |

不提前引入部署、付费模型调用、第三方账户、新凭据或不必要的框架。阶段临近时给出具体方案、取舍和验证结果。
