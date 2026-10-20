# ADR 0016：自动压缩与 Memory 原子刷新

状态：Accepted，2026-10-08。用户批准默认自动压缩，并要求每次成功压缩重新读取当前 MEMORY.md，将刷新后的 system、摘要及保留尾部原子 checkpoint。本文取代 [ADR 0006](0006-memory-only-system-prompt.md) 中“仅初始化加载、压缩不重读 Memory”的旧约束；[ADR 0007](0007-model-owned-action-decisions.md) 的模型动作判断及 [ADR 0011](0011-conversation-context-and-skills.md) 的自然请求 Skills 目录边界不变。

## 设计来源与范围

Architecture v0.5 §8–11 将压缩交给 Runtime，§17 要求上下文初始化或重建注入 MEMORY.md。原始 [v0.5](../design/architecture-v0.5.md)、Prompt 设计及来源 manifest 的锁定字节不修改。本 ADR 和[当前架构说明](../architecture.md)记录批准后的解释与实现边界。

Compaction 继续同一个认知流，不是 Dreaming，不修改 Memory 文件，也不引入 Memory 写入 API、watcher、额外 Wake、新框架、旧 loader 别名或兼容层。测试不调用付费模型。

## 默认预算与触发边界

Runtime 的 `autoCompaction` 配置包含：

- `enabled: true`
- `threshold: 0.8`，按可用输入预算计算
- `reserveTokens: min(model.maxTokens, max(512, floor(contextWindow * 0.1)), contextWindow - 1)`
- `keepRecentTokens: min(20000, floor(contextWindow * 0.2))`

输入预算为 `contextWindow - reserveTokens`；reserve 同时限制实际输出，不能只从输入预算中扣掉却允许 provider 输出更多。无效模型限额或配置明确失败。Server Demo 与 Web 直接使用 runtime 默认配置；程序化 `DemoOptions` / `WebServiceOptions.autoCompaction` 可透传配置，没有新增 CLI/env/UI 开关。

估算直接复用 Pi 公开 token estimator，并计入协议开销、当前完整 system、消息和本次真实工具声明/schema。它仍是保守启发式估算，不承诺与供应商 tokenizer 一致。

检查位于安全的 `prepareRequest`，使用已发布的工具代际和已准备的 Prompt/Skills，前一工具批次及其结果必须全部落库。存在可压缩旧历史且达到输入预算阈值时，使用既有完整公开 Pi SDK 压缩路径。不得复制私有 helper 或替换为自制摘要/切尾算法。

自动候选必须严格降低本次请求估算，并在刷新 Memory 后仍可容纳于输入预算；否则不提交 checkpoint。不可压缩的大 system/工具 schema/尾部不会被静默丢弃。禁用自动压缩后仍可显式 `compact()`，仍执行预算与结构校验。

## Memory 与 checkpoint

`miraPrompt.loadMemory(signal)` 取代 `loadInitialMemory`，不保留别名：

1. 真正空的 version-zero 上下文加载一次 Memory，先保存初始快照。
2. 普通请求、Wake、文件编辑和重启不触发 Memory loader，也不自动 Wake。重启恢复最新已提交的快照。
3. 自动或显式压缩在摘要请求前读取当前 MEMORY.md 一次，冻结候选快照；摘要和最终 checkpoint 使用这一份快照，不在摘要成功后再次读取。使用已保存的 Prompt 渲染输入刷新 Memory 部分，保留其余 system section 和本次已准备的 Skills 目录。读取时序依 2026-10-11 的批准调整，见下节。
4. 新 Memory/system、摘要及合法近期尾部在同一 fenced CAS checkpoint 中提交。原始历史追加保留，不在压缩前另发 Memory 更新。

压缩已带 Memory 的持久上下文时必须提供 `miraPrompt`。初始记录与 checkpoint 保存 `miraMemoryConfigured`，区分未配置 Memory 与已配置但内容为空；已配置流压缩时缺少 `loadMemory` 必须在摘要请求前拒绝，不能清空或静默沿用旧快照。未配置流可以在成功 checkpoint 中首次启用 loader，之后不能静默降级。完整 Memory/Prompt 快照链在恢复修复写入前校验。读取、摘要、预算、取消、所有权或 CAS 失败均不能部分发布刷新。COMMIT 已发出但响应丢失仍需权威数据库恢复，不能声称已撤销。正常请求的具名 Prompt 更新仍走原来的追加历史路径；压缩不是重建新 Mira。

## 溢出与执行事实

明确的 provider context overflow 每个 run 最多允许一次压缩后恢复重试；输入已落库时不得重复追加。普通网络/认证/取消/数据库错误不伪装成上下文溢出；第二次溢出、不能缩小或不能容纳时终止，不无限重试。

恢复从持久记录继续，不重放已执行工具。工具合法配对、不可变 intent/outcome、全局 History UUID、未知结果及其安全诊断保持原有边界；摘要文字不能覆盖真实未知操作事实。摘要请求继续使用受限 disposable SDK、显式注入 stream、无凭据发现或网络回退。

## 验证要求

离线覆盖默认值/无效配置、阈值两侧、实际输出 reserve、完整 system 与工具 schema 开销、大尾部/不能缩小、工具批次后的同轮压缩、溢出一次成功恢复与第二次失败、非溢出错误、取消/所有权/CAS、Memory 读取失败及无部分发布、最新快照重启和未知操作不重放。真实 PostgreSQL 覆盖原子持久化与恢复；模拟 provider 不代表真实模型质量或 paid-provider 验收。

执行结果以本次实际检查输出为准；本文记录批准的边界与验收要求，不将未执行测试写成通过。


## 2026-10-11 批准调整：Mira 连续上下文摘要

状态：Accepted。本次批准替换 Pi 默认 coding-summary 提示词，使用独立的 [Mira 压缩提示词 v0.1](../../packages/runtime-pi/prompts/mira-compaction-v0.1.md) 规范资产。主提示词和三种模式短指令按已确认文本保存，不改写锁定的 Architecture v0.5、Prompt 设计或 Mira 人格 v0.2 源文件。摘要延续同一个 Mira 的当前交流、共同经历及未完工作；闲聊不强制变成任务，不建立情绪分数、关系状态或心理档案，不把人格示例当用户经历。

### 公开 SDK 接线与单次请求

- 通过 Pi 公开 `session_before_compact` hook 返回自定义摘要。Pi 仍拥有 preparation、切点、合法近期尾部、checkpoint 结构和投影；不复制私有 helper，不建立另一套切尾算法。
- 每次压缩只发出一次统一摘要模型请求。`initial` 根据本次范围生成摘要；`update` 将旧摘要和新增范围重写为当前有效摘要；`split_turn` 处理轮内切点，同时包含旧摘要时应用递归修订规则，不另发分轮摘要调用或补造结尾。
- hook 错误、取消、缺失或无效返回都必须 fail closed。不能依赖 Pi 捕获 hook 异常来停止，不能静默回退到默认 coding-summary 提示词或第二条模型调用路径。摘要须正常结束且正文非空；机械校验不证明内容质量。
- 使用原有注入的完整 model/streamFn 和一次性内存 SDK；不注册工具、不发现凭据、不新增 auth/network fallback。仍保留未注册临时 provider 别名与显式传输边界。

### 三种模式的已批准原文

主提示词使用上面的规范资产，短指令由 [compaction-prompt.ts](../../packages/runtime-pi/src/compaction-prompt.ts) 选择，每次只附加一条：

- `initial`：根据本次待压缩范围生成摘要，不假定存在更早的摘要或经历。保留原文仅作理解边界的参考。
- `update`：把旧摘要与新纳入压缩的内容合成一份当前摘要，按新证据修订和删减；不在旧摘要后不断追加小结。
- `split_turn`：本次范围在同一轮中途结束。准确保留这一轮的触发要求、已完成步骤、尚未知的结果及与保留尾部相接的指代；不要补出结尾或提前回答。若存在旧摘要，同时按递归规则处理。

### 快照、人格参考与数据边界

本调整明确取代 2026-10-08 的“摘要成功后读取 Memory”时序。候选在摘要前只读取一次 Memory，冻结后提供给摘要模型；最终 fenced CAS checkpoint 使用同一份不可变快照刷新 system。摘要期间 MEMORY.md 再次变化不触发第二次读取、不混入本次 checkpoint，下次获准的压缩才重新取样。读取或摘要失败、取消、预算/所有权/CAS 失败均不发布候选 Memory，也不改变已持久化的快照。

摘要主指令及对应模式短指令属于独立 system。当前生效、完整渲染的人格作为明确标记的 `persona_context` 参考数据，其中 `MEMORY_STATE` 使用占位说明，实际 Memory 只在独立 `memory_snapshot` 字段出现，避免重复注入。不能把完整人格行为指令无区分地作为摘要模型的新 system 任务；人格示例、旧摘要及被引用材料也不能升级成事实或授权。

单独的 JSON user 数据对象包含以下字段：

- `mode`：`initial`、`update` 或 `split_turn`
- `persona_context`、`memory_snapshot`：当前人格参考与本次冻结 Memory
- `previous_summary`：可空的旧摘要，不能假定缺失输入已经存在
- `source_messages`：本次压缩范围内的消息
- `retained_tail`：仍会保留为原文的衔接参考，不将尾部结果倒写为切点之前发生
- `boundary`：本次 Pi preparation 的压缩边界
- `summary_token_budget`：摘要输出限额
- `recovery_operations`：真实未决执行事实，不能由摘要文字替代

消息数据保留原角色、已有来源 entry ID 与时间戳，不补造 History ID；不传隐藏 thinking、供应商内部元数据或长篇推理。可靠 JSON 分隔和实际来源共同约束输入，数据中的伪造角色标签不授予指令优先级。来源消息、人格、Memory、旧摘要和工具输出都是摘要对象或理解参考，均不是新的执行指令。

继续保留授权的原范围及撤销/纠正，区分用户要求、Mira 提议、承诺和已观测结果。未知结果如实为未知，不自动重放；摘要不是原始证据。Memory 的旧认识被本轮纠正时记录纠正，不假称已写入 Memory。秘密不得进入摘要，必要私密经历仅作最小概括。

### 预算与验收层次

压缩模型请求的预算必须计入完整摘要 system、人格参考、Memory、JSON 数据及协议开销，并限制实际输出；不能只估 source 消息。最终请求仍计入完整生效 system、工具 schema、摘要与保留尾部。不可容纳时拒绝，不静默截断人格/Memory/参考数据；自动候选必须严格缩小并适配输入预算。既有 overflow 单次恢复、工具配对、unknown 事实补回、原历史及无重放保障不变。

确定性机制测试检查真实 hook 接线、三种模式、单次请求、数据形状/来源、旧摘要/轮内边界、同份 Memory、无隐藏推理、无工具/auth fallback、输出限额、fail-closed、CAS 与恢复。不论合成摘要写得多好，这些测试都不能证明真实模型会保留笑话、情绪变化、纠正、权限范围或未知结果。

2026-10-11 已完成六个合成场景的原生模型实际摘要与续答，并独立判读，见 [连续上下文质量记录](../acceptance/compaction-continuity.md)。包括未完胖猫闲聊、情绪缓和、技术与权限边界、递归轮内未知结果纠正，以及追加的明确撤回发送许可和尾部新送达结果。例 3 的未来实施许可措辞与例 4 丢失源 History ID 仍有局限，不能称为全部完美通过。未执行生产 provider/live/paid API，也未证明精确 token 预算、实际工具执行或多次压缩稳定性；机制测试、数据库 gate、完整 CI 与质量探针分别报告。本次不合并或部署。

## 修订（2026-10-20）：压力测量与摘要请求兜底

- 压力测量：中日韩文字按约 1 token/字估算（原先统一按 4 字符/token 会把中文低估约 4 倍），并以同一 provider/模型最近一次成功响应的 usage 为锚点，加上其后新增消息与 system 增长的估算；取锚点值与估算值中的较大者。
- 摘要请求放不下或 provider 报上下文溢出时，最多尝试 3 次逐级缩减：保留尾部改为摘录、裁短旧工具结果（8000/2000/500 字符）、丢弃最旧来源消息（至少保留 1 条）；缩减会以 `input_reductions` 字段如实写进请求，要求模型不要编造被省略的内容。正常大小的请求格式不变。
- 若系统提示（含 MEMORY.md，现最多注入 48 KiB）本身超出预算，仍按原规则失败并给出可追溯的错误。

