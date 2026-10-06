# ADR 0011：简洁对话上下文与普通文件 Skills

状态：Accepted，2026-10-06。用户批准移除对话页工具活动、精简 Wake 正文、直接复用 Pi Skills，并补充要求普通聊天不用 Markdown。History 全局 ID 的讨论另行决策，不在本批更改 History 契约或 Memory Git 引用。

## 对话展示与上下文

正常 Web 对话只显示用户/Mira 文本、处理状态及实际错误，不展示工具活动 chip，也不再通过 Timeline API 查询和返回无用的工具展示字段。工具仍正常执行，原始 assistant 调用、结果配对、intent/outcome 与历史全部保留。

单个普通 Web 用户消息只在文本前呈现来源和原始时间；不附带固定唤醒理由、调度 UUID、重复 JSON 外壳。其他事件保留来源、类型、时间、事件 ID、原因和完整业务 payload。没有额外模型摘要、字段猜测或丢弃。多个请求仍按原始批次顺序一起进入一次 Wake；超限时用同一完整表示写普通文件，由普通 read 按需读取，不新增消息分页/解析服务。

原始 Life History 与模型正文分别承担事实保存和认知呈现职责。精简不删除原始数据库记录，也不删除必要的供应商工具协议 JSON。

正在执行的旧版本 Wake 可能已经保存不同的正文或溢出文件。升级前应让旧版本完成当前 Wake/checkpoint，再正常停止。新版本继续严格检查已保存正文和文件一致性，不提供旧渲染器、兼容解析、历史重写或数据重置。

## Skills

直接复用已固定的 Pi 1.0.2 `loadSkills`、`formatSkillsForPrompt`。只发现当前源码的 `skills/` 与 `${MIRA_HOME}/skills`（默认 `~/.mira/skills`）；内置目录先加载，同名保留首个并报告诊断。不开启 Pi 默认目录发现，不扫描 `.pi`、`.agents` 祖先目录或包资源。

每次自然模型请求前刷新元数据，同一请求使用同一份目录。只将名称、描述、真实 SKILL.md 路径及按需读取说明附到已渲染的同一个 Mira system section，仍先持久化/CAS 再调用模型。正文通过已有 read 工具读取，不默认注入，不进入 MEMORY.md，不增加文件 watcher 或额外 Wake。

官方 formatter 已转义元数据，不能再经过 Mira 占位符二次转义。其输出附在完整 Prompt 之后；现有最新 section 投影及确切 system 压缩校验继续使用。压缩不另行扫描磁盘技能。模型读取技能不授予新的用户权限，技能不能覆盖真实 OS 或持久化边界。

没有新 SkillManager、专用读取工具、AgentSession 生命周期或 `/skill:` 命令。`disable-model-invocation` 隐藏目录项；用户仍可明确要求读取某个普通文件。

## 内置扩展作者技能

`skills/mira-extension-authoring` 改编 DeepSeek Harness 官方内置 `cordis-plugin-development` 的设计/实现分支、交付与验证工作流（固定上游提交及完整 MIT 通知保留在技能目录），替换 DSH 专属 profile/UI/直接 Cordis 接口为当前 Mira SDK。技能提供入口、完整 SDK/生命周期/开发流程参考及可测试的 watcher 范例。相对引用定位当前源码中的 SDK、模板和脚本，不复制 SDK、模板或旧版本副本到用户目录。指南覆盖当前真实能力，不把设计中的未来接口写成可调用 API。

## Prompt 来源

用户明确要求普通聊天不用 Markdown，因此在实际 `mira-system-v0.2.md` 的 conversation_style 中新增一个段落。限制只针对聊天，不禁止生成文件、文档、代码或技能采用适合的格式。其他原始内容、13 个示例和占位符均不改动。

`docs/design/sources.json` 同时记录原始来源字节/SHA 与当前批准修订的字节/SHA；运行时及测试校验当前修订。Architecture v0.5、Prompt Design v0.1 与 v0.4 存档原文不变，本 ADR 说明后续决定。

## 验收

覆盖工具 UI/API 投影移除与正常处理/错误显示、桌面/窄屏；完整多事件/异常 payload/溢出文件恢复；技能新建/修改/移除、缺失/冲突/隐藏与转义；真实请求目录、按需读取、重启/压缩/Memory 冻结和 CAS/所有权失败。指南示例使用离线合成数据，不接触真实服务。

完整检查采用独立审查、`pnpm check:all`（隔离 PostgreSQL）和 Chromium `pnpm test:e2e`。具体提交的执行结果另行记录；测试目标不代表已运行或真实模型自然度验收。
