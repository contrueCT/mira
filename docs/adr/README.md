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

- [0013 Web 默认持久扩展宿主](0013-default-web-extension-host.md)：Accepted，2026-10-07，默认空配置与 artifact store、显式配置优先、重启沿用保存状态；不改正常对话输出

- [0014 扩展管理直接等待应用](0014-awaited-extension-management.md)：Accepted，2026-10-07，统一返回实际管理结果、实际执行租约与旧 activation 明确拒绝

- [0015 安全的工具恢复诊断](0015-safe-tool-recovery-diagnostics.md)：Accepted，2026-10-07，现有 unknown operation 的白名单可选诊断、写入故障的临时状态提示及扩展契约测试；不添加日志表或自动重放

- [0016 自动压缩与 Memory 原子刷新](0016-automatic-compaction-memory-refresh.md)：Accepted，2026-10-08，默认输入预算触发、完整 Pi SDK、单次溢出恢复、成功压缩原子刷新 Memory/system/摘要/尾部；取代 0006 的压缩不读取 Memory 约束；2026-10-11 批准 Mira 连续摘要、公开 hook 单次请求及摘要前冻结同份 Memory，六例 native 质量探针已完成并保留许可措辞/来源 ID 局限，生产 provider 验收未执行

## 后续范围

不提前引入部署、付费模型调用、第三方账户、新凭据或不必要的框架。阶段临近时给出具体方案、取舍和验证结果。

- [0017 External SDK 与本地接入](0017-external-sdk-local-ingress.md)：Accepted，2026-10-13；Timeline 通知、本机默认关闭、普通 Shell 管理私有凭据，保持原有 Event/Wake 与来源边界。

- [0018 Dreaming 主动整理 Memory](0018-dreaming-memory-housekeeping.md)：Accepted，2026-10-13；新有效经历、空闲 30 分钟及三次成功压缩或超过 24 小时的合取条件，触发原子消费游标，复用普通 Wake/工具/Git 和现有恢复。

- [0019 扩展 ContextProvider](0019-extension-context-providers.md)：Accepted，2026-10-13；有来源和字节预算的自然请求采样，复用既有 system 快照与扩展生命周期，不额外 Wake。

- [0020 设置管理界面](0020-settings-management.md)：Accepted，2026-10-13；现有设置内展示真实 Memory 总览、普通自然语言请求、扩展生命周期与按 Wake 的安全历史投影，主聊天布局不变。

- [0021 聊天附件](0021-chat-attachments.md)：用户批准双向文件/图片/视频、左侧加号/拖拽/粘贴及原生视频；统一不可变引用，Google Gemini 原生视频映射，PDF/Word由模型工具解析。

- [0022 持久单次延迟投递](0022-durable-single-shot-delivery.md)：Accepted，2026-10-14；系统提供UTC原子Event/Wake投递、CAS取消/改期与重启补扫，扩展拥有提醒业务/时区/DST/错过策略。
- [0024 运行中用户插话](0024-live-user-input.md)：Accepted。请求级让出、单工具边界、冻结原始输入与持久补充关联、终态原子仲裁；长工具延迟保留。
- [0023 公开技能与按需工具](0023-on-demand-public-skills.md)：Accepted，2026-10-14；复用公开 OpenAI 文档/转写和 agent-browser 技能，Tavily 直接 CLI，按需用户态依赖，保持普通 read/bash 与主模型判断。
- [0025 Task-scoped subagents](0025-task-scoped-subagents.md): Accepted scope, 2026-10-14; asynchronous bounded Pi workers with isolated PostgreSQL transcripts, durable parent result Wake, explicit followup/cancellation and fresh/frozen projected context. No second Mira Life or main-chat entry point.

- [0026: Observable delegated work and global skills](0026-subagent-observation-and-global-skills.md) — approved scope, implementation under verification.

- [0030 Task-scoped child compaction](0030-task-scoped-compaction.md): Approved scope, 2026-10-14; existing durable compaction on independent worker transcripts, task-only summary instructions, no main Memory or Dreaming count changes.
- [0027 模型默认推理强度](0027-configured-reasoning-levels.md)：Accepted scope，2026-10-14；配置偏好、Pi 能力适配、主/child/Dreaming 显式注入与独立最低档压缩，总输出 cap 不扩大。

- [0028: Unified tool output budget](0028-tool-output-budget.md): Accepted scope, 2026-10-14; bounded model text with complete durable outcomes and ordinary-file references, restart reconstruction, and revision-bound History text pages above 1 MiB.

- [0029: Bounded model-request retries](0029-bounded-model-request-retries.md): Accepted scope, 2026-10-14; at most three transport attempts before a complete assistant message is published, explicit transient evidence, cancellation and temporary status, without whole-Wake/tool replay.

- [0031 子任务详情仅保留在运行记录](0031-child-details-in-settings.md)：Accepted scope，2026-10-14；移除主聊天任务卡片与专用 Timeline 投影，保留设置中的独立 child/run 活动详情与后端执行。

- [0033 可选网页访问密码](0033-web-password-access.md)：已授权实现，独立草稿 PR 验证；不含正式部署。
- [0032 — Persistent terminal processes](0032-persistent-terminal-processes.md): approved cross-turn processes, service-scoped lifecycle, explicit PTY/input/close, no restart replay or UI.

- [0034：受管浏览器与界面内接管](0034-managed-browser-handoff.md) — 已批准，实现/验收中。
- [0038 Delegation-first prompt](0038-delegation-first-prompt.md): approved 2026-10-15; responsive main Mira, substantial independent work delegated, explicit published-template identity and safe next-request upgrade with frozen Memory preserved.
- [0044 Task communication prompt](0044-task-communication-prompt.md): approved 2026-10-17; brief execution acknowledgement and meaningful updates at natural model opportunities, existing Timeline delivery verified, published identities and frozen Memory preserved.
- [0037: Live subagent results](0037-live-subagent-results.md): accepted single-tool boundary delivery, preserving sourced results and the sole main loop.

- [0039 — Parent-to-child live followups](0039-live-child-followups.md): accepted scope; implementation under verification. Separate task inbox and child transcript boundary, no main Wake ownership.
- [0035 扩展私有凭据与声明式设置](0035-extension-private-settings.md)：Accepted，2026-10-15；手工/生成扩展共用安装命名空间、私有凭据、纯文本字段/动作/状态与本地授权二维码。
- [0036 飞书本人单聊扩展](0036-feishu-owner-channel.md)：已批准普通 Cordis 扩展，使用通用设置/凭据和既有安装生命周期；固定官方 SDK、显式本人绑定、持久收件与未知投递保护，真实租户联通未执行。

- [0040 MCP 普通扩展消费者](0040-mcp-extension-consumer.md)：Accepted，2026-10-15；独立安装复用既有生命周期，通用动态工具集/已知错误契约，官方 MCP SDK、显式本地协议、私有 OAuth 和无隐式工具重放。
- [0041 自定义模型发现与推理格式](0041-custom-model-discovery-and-reasoning-format.md)：明确目录元数据预填、手动兜底与 Pi Chat Completions 格式选择；不推断未知代理、不静默丢弃已配置强度。

- [0043：紧凑时间线与双向指定消息回复](0043-message-replies-timeline.md)：2026-10-16 授权实现；稳定 History 引用、有界服务端快照、主 Mira 显式发布及紧凑浅色聊天 UI。

- [0044 关闭单次运行错误提示](0044-dismissible-runtime-errors.md)：Accepted，按错误 ID 隐藏横幅，保留异常状态，新错误重新显示。

- [0045 允许可写祖先目录](0045-writable-spool-ancestors.md)：Accepted，移除祖先目录写位拒绝，保留结果目录/文件的私有权限及不可变发布。
