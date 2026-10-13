# ADR 0018：Dreaming 主动整理 Memory

状态：Accepted，2026-10-13。用户要求实现 v0.5 的 Dreaming，并明确增加频率条件：有新经历、连续空闲 30 分钟，且成功压缩至少三次或距上次触发超过 24 小时。首次启用时建立时间基线；无新内容不空跑。

## 范围与用户体验

依据 Architecture v0.5 §10、§24–28，Dreaming 是特殊 Wake，继续同一个 Mira、相同工具和相同主认知循环。`memory.dreaming` 的 system Event 携带普通整理指令；模型用现有 read/write/edit/bash、history_search/history_read 自行判断是否需要修订普通 Memory 文件。允许不改任何文件，不建立 Memory API、打分/衰减/合并引擎、固定目录或独立 Semantic State。

整理指令要求先读当前文件、核实不确定事实、保留长期有用理解，不抄录对话、不把一次选择固定成长期偏好、不保存秘密或把提议当决定。通常安静完成，不向 Timeline 发布维护公告；模型判断有必要回应用户时，仍使用普通回复。没有新增页面、工具 chip 或通知渠道。

普通 Memory Git checkpoint/receipt 与 History-Id lineage 复用既有 Wake 完成钩子。Dreaming 不强制 compaction，不重新注入 system Memory。初始空上下文与成功压缩才读当前 MEMORY.md；普通回合、文件变动和重启继续使用最新持久快照，见 ADR 0016。

## 精确触发条件

本地 Web 服务配置 Memory 时默认启用，条件全部成立才入队：

1. 自上次触发边界以来，有新的、明确请求 Wake 的 user、extension 或 external 经历。
2. 真实服务端时钟记录的连续空闲至少 30 分钟，且没有活动或待处理 Wake。
3. 自上次触发边界以来成功持久化的上下文 checkpoint 至少 3 次，或距上次触发严格超过 24 小时。

首次启用以当前时刻、已有 receipt 最大顺序及 context version 建立基线，不把启用前的整段历史补跑一遍。启用后到达的用户/扩展/外部 Wake 才构成新经历。失败的压缩候选不计数，成功 checkpoint 才计数。明确的手动成功压缩也计数；触发器不解析 Pi 私有 payload。

Event 不等于 Wake。仅记录的事件和 External SDK 的 Timeline notification 不构成新经历，也不重置空闲计时；Dreaming 自身的 system Wake 不递归计作新经历。不使用调用方可回填或伪造的 occurredAt 判断空闲。

每次实际接收新 Wake，以及首次成功完成 Wake，更新服务端空闲起点。重复 receipt 或重复 completion 不重置。因而长工具执行、Git 快照和恢复期间不会被算作空闲；下一轮等待从完成后开始。停机不产生整理调用；重启保留基线，恢复待处理工作后重新检查，错过的时间不产生多轮补跑。

## 持久化和失败

`dreaming_progress` 每个 Mira 一行，只保存技术触发游标：时间基线、空闲起点、已消费 receipt 顺序和 checkpoint version。它不是语义记忆或通用日程平台。成功 checkpoint 数量从现有追加记录按版本查询，不另维护可能与 checkpoint 分叉的累加器。

同一个 fenced writer 事务检查条件、写普通 Event/Wake、推进触发基线。触发时消费条件，失败恢复同一 Wake：

- 入库前失败或事务回滚不消费经历、次数或时间条件。
- Event/Wake 与基线同事务提交；并发检查只有一个入队。COMMIT 响应丢失后，权威数据库决定结果，不能假称撤销。
- 入队后模型、工具或 Git 失败，保留同一个未完成 Wake；timer 不清除错误、不自动热重试、不创建替代 Dreaming。由既有启动恢复或新的明确输入继续原队列。
- 成功完成不再次重置「上次触发」，也不宣称触发就完成整理。期间新到的有效经历留给下次。
- 已有 final/Git receipt 的恢复不再请求模型、不重复提交 Git。未知工具结果不自动重放，既有恢复保障不变。

服务只有一个可取消 timer，按数据库返回的下次条件时间安排；没有新经历时不轮询。没有 Memory、没有已配置模型、关闭中、写者失效、配置更新或 error 状态都不自动触发。停机等待已在途的触发检查，避免关闭 writer 后仍有后台写入。

## 用户输入优先与串行边界

检查时已有用户或外部待处理 Wake，整理延期。若触发与新输入先后入库但尚未 claim，既有队列可合并同一批，指令要求先回应用户。已经 claim 的 Wake，包括崩溃恢复中的旧 Wake，不抢占或改写输入；新输入在下一批处理。不能把这项提示词优先级描述为运行中强制抢占。

## 配置与验证

程序化 `WebServiceOptions.dreaming` 可传 `enabled`、`idleMs`、`intervalMs`、`minCompactions`；缺省是上述用户确认值。参数必须为正整数，生产默认没有新增 CLI/env/UI 设置。无 Memory 的组装及短命 `runDemo` 不启动后台 timer。

验证入口：`tests/unit/dreaming.test.mts`（默认策略和 timer）、`tests/integration/dreaming.test.mts`（真实 PG 条件/事务/恢复）、`tests/recovery/dreaming-service.test.mts`（真实服务、普通文件/History 工具、Git、连续上下文及失败恢复）。使用合成 provider 的链路测试不代表生产模型理解质量；原生模型合成场景探针另行记录，不称 live-provider 端到端。

本地禁止 socket 时遵守既有仓库规则，不通过其他协议绕过；真实 PostgreSQL/恢复门禁使用获准 CI。具体通过/失败/未执行以本次提交的验证记录为准，不把设计要求写成已通过结果。
