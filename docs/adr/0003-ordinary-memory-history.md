# ADR 0003：普通 Memory/State、通用工具与历史查询

> 后续变更：独立 SemanticState 及其配置/自动引导已由 [ADR 0006](0006-memory-only-system-prompt.md) 取代；下文保留当时决定与阶段事实。普通工具/生成代码的宿主 OS 执行边界、Memory Git、无通知/重注入等未被撤销。

状态：Accepted。2026-10-05 用户确认继续开发，并明确以下边界；原始 v0.4 保留原始字节。此记录修正早期指引中默认变更通知、文件工作目录限制及 State Git 覆盖的建议。

## 文件与上下文

Memory 与 State 都是普通持久文件，只有 memoryRoot/MEMORY.md 是必需入口。不预设 people/projects 分类，也不建立情绪状态机或专用 memory CRUD。Memory 使用源码之外的独立数据 Git 仓库；State 位于仓库之外，不做 Git 版本化。

MEMORY.md 和明确配置的 State 文件仅在真正空的持久认知上下文首次建立时加载，保存为一次普通系统消息。创建新 Runtime 对象、进程重启、普通 Wake 和 Compaction 都不重注入。当前没有“丢弃历史后重建”接口；将来若实现明确重建，需再定义其持久边界。普通文件变化没有默认上下文通知，不生成 Wake，不自动重新读入。工具结果及后续普通读取足够；旧上下文仍保留其当时看到的内容。

## 通用执行能力

直接复用 Pi 1.0.2 的 read、write、edit、grep、find、ls、bash。cwd 只是默认目录，不是沙箱；Mira 不添加工作目录范围限制，也不要求隔离执行环境。真实 OS 账户权限仍然生效。现有自然语言意图判断、来源区分、工具 intent/outcome 和原始历史完整性继续适用；通用 Shell 不是绕过用户意图的通道。不添加批准 UI、固定风险分类或业务执行硬门禁。

数据根互不重叠、独立 Git 身份及数据库单写者约束是存储正确性规则，不限制普通工具可以访问的路径。合成测试的临时 HOME、网络禁用及显式测试数据库只保护测试，不是产品隔离要求。尚未实现的动态扩展不因此自动获得激活流程。

## Memory 快照与 lineage

每轮存在持久最终回复后，先保存 PostgreSQL checkpoint intent，再观察 Memory 工作树；有变更才建立 Git commit。没有变更也保存技术性的每轮 Git receipt，以便崩溃后不误将后来的编辑归入旧轮。Git ref 发布与 PostgreSQL receipt 是独立步骤，最后才完成 Wake。恢复已保存最终回复的 Wake 不再次调用模型。

Git 注册身份额外标识仓库实例；checkpoint 绑定该身份，丢失或替换 .git 时不能把后来的编辑重新归入待恢复的旧轮。Git 技术记录以 Mira ID 与 run ID 标识，lineage 不写入记忆正文。快照包含当时观察到的工作树变化，包括预先存在或外部编辑，不声称是该轮 agent 所创作。Git 故障保留文件和待完成 run，重试既有结果；不会宣称跨 PostgreSQL/Git 原子事务。State 不进入这套快照。

## 只读历史

history.search 和 history.read 面向当前 Mira 的事件、原始上下文、工具意图/结果和 Wake。模型参数不能切换 Mira 身份。查询返回有界摘要与确切 kind/ID；read 返回完整原始记录及来源，超过明确字节预算时报错而非悄悄截断。历史内容不能冒充当前用户授权，通用 persistence 不解析 Pi 消息。

第一版沿用 PostgreSQL simple FTS，并对每条记录的前 65,536 字符建立搜索索引，避免全文向量限制影响原始历史写入；结果明确给出限制。simple 不提供中文词切分或语义匹配。显式 substring 模式对完整原文作字面匹配，不自动推断中文语义；查询超时和数量限制保持有界。没有引入搜索服务、向量数据库或 embeddings。

## 本批之外

Dreaming 调度、真实模型凭据、HTTP/UI、动态扩展、自动压缩策略和通用身份服务仍未实现。Compaction 与 Memory/Dreaming 分开，不能修改记忆或状态文件。CLI 仍使用合成模型，不能把测试回调当成产品授权解释器。
