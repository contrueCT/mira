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

- [0003 普通 Memory/State 与历史查询](0003-ordinary-memory-history.md)：Accepted，SemanticState 部分由 0006 取代；早期验证见 [历史阶段验收](../acceptance/memory-history.md)

- [0004 手工可信扩展与同轮更新](0004-manual-trusted-extensions.md)：Accepted，范围与限制见 [验收](../acceptance/manual-extensions.md)

- [0005 生成扩展生命周期](0005-generated-extension-lifecycle.md)：Accepted，宿主执行边界与普通文件版本，见 [验收](../acceptance/generated-extensions.md)

- [0006 Memory-only 与完整 Mira Prompt](0006-memory-only-system-prompt.md)：Accepted，v0.5、Prompt v0.2、当前设计不保留旧兼容层及持久恢复边界

- [0007 主模型决定动作，移除独立授权门禁](0007-model-owned-action-decisions.md)：Accepted，2026-10-06，移除 authorize 和合成证据，保留事实 Prompt 语境、执行来源与技术完整性

- [0008 Pi 目录与显式自定义连接](0008-model-catalog-and-connections.md)：Accepted，2026-10-06，完整离线 chat 目录、逐模型协议、三种自定义协议、独立 API Key、模型发现与 transport 组装

- [0009 本地 Web 界面](0009-local-web-client.md)：Accepted，2026-10-06，React/Vite/CSS、Fastify、本地启动、持续 Timeline 与模型设置

- [0010 Web 直接填写 API Key](0010-web-api-key-storage.md)：Accepted，2026-10-06，密码式输入、后端本地明文权限保护、严格脱敏响应与目标绑定

- [0011 简洁对话上下文与普通文件 Skills](0011-conversation-context-and-skills.md)：Accepted，2026-10-06，隐藏工具活动、精简 Wake、Pi 元数据目录与按需读取、扩展作者技能、普通聊天纯文本

- [0012 全局 History UUID](0012-global-history-identities.md)：Accepted，2026-10-06，统一身份薄表、ID-only 读取、原始来源标识分离、Memory 明文引用与新空数据环境

## 后续范围

不提前引入部署、付费模型调用、第三方账户、新凭据或不必要的框架。阶段临近时给出具体方案、取舍和验证结果。
