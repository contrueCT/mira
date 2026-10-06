# 架构边界

状态：边界已确认；连续上下文与持久化接口已形成，见 [ADR 0001](adr/0001-durable-context.md)。最新设计见 [v0.5](design/architecture-v0.5.md)，[Prompt 设计](design/system-prompt-design-v0.1.md)和 [ADR 0006](adr/0006-memory-only-system-prompt.md)说明 Prompt 集成；主模型动作判断按 [ADR 0007](adr/0007-model-owned-action-decisions.md)。原始 v0.4 仅作历史存档。原文保留原始字节，已确认补充约束在本文与 ADR 中明确记录。

## 依赖方向

1. `life`、`context` 不导入 Pi、Cordis、数据库或 Web 框架
2. 核心拥有所需能力的契约，适配器实现契约；核心不得反向依赖适配器
3. `apps/server` 是组装入口，负责连接核心、持久化、工作空间、Runtime 与扩展宿主
4. 扩展只依赖 `extension-sdk` 公开契约，不导入核心内部实现或直接接触历史数据库
5. 包必须显式声明公开 exports；禁止跨包相对路径、内部子路径和未声明依赖
6. 依赖检查覆盖静态导入、重导出和动态导入；不能只检查 package.json

初始包职责如下。具体允许依赖表将在接口形成时收窄，不能为了方便把所有包互相放行。

| 包 | 拥有的职责 | 不拥有的职责 |
| --- | --- | --- |
| life | 事件接收、Wake 编排、单写者 | 数据库实现、模型 SDK、压缩算法 |
| context | 连续上下文、版本、时间表示 | Pi 序列化、Memory 检索策略 |
| cognition | Runtime 接口、可持久化消息契约 | Mira 生命循环、数据库连接 |
| runtime-pi | Pi 转换、恢复、技术工具边界、压缩 | 独立授权判断、第二套权威历史 |
| authorization | 事实性授权语境占位 | 独立授权 gate/引擎、根据第三方文本授予权限 |
| persistence | PostgreSQL 事务、迁移、历史查询 | 心理状态、模型推理策略 |
| workspace | 普通文件、Memory Git 快照 | 自创 Memory API、来源元数据注入 |
| extension-sdk | 对扩展公开的稳定契约 | 核心内部状态访问 |
| extension-host | Cordis 注册、清理、生命周期 | 未知代码安全沙箱 |
| external-sdk | 外部事件、Wake 接口 | 直接写上下文或数据库 |

## 必须保持的语义

- 只有一个 Mira 和一条主 Cognitive Stream；没有 New Chat 或会话列表
- Wake 继续已有上下文。重启后恢复原始结构化消息、工具调用/结果、版本及 Runtime 信息
- Life Event 是事实，Wake 是认知调度。事件落库不等于必须调用模型
- Life History、Working Context、语义记忆和 Runtime Trace 分开保存与展示
- 时间戳是事实；经过多久、跨日等提示在渲染时推导
- Runtime Compaction 保留继续认知所需信息及合法工具边界，不自动写长期 Memory
- Dreaming 是维护语义记忆的特殊 Wake，不替代压缩
- 长期 Memory 使用普通文件；Memory Git 仓库与源码 Git 仓库独立。不存在独立 SemanticState，近期心理状态由 Working Context 及必要的普通压缩摘要承载

## 一致性与副作用

- 单写者必须跨进程成立，不能仅靠内存锁；使用专用连接上的 PostgreSQL session advisory lock、递增 epoch 与 context CAS
- 上下文更新使用版本检查，拒绝过期写入
- 事件、Wake 与需要原子提交的记录必须在明确事务边界内完成
- 工具调用 intent、原始/验证参数和 outcome 按执行边界增量持久化；assistantRecordId 与 context version 保留真实来源，不生成独立授权证明，不能只在 Wake 结束时保存
- 外部副作用与本地事务无法天然原子化。本批使用持久化 intent/outcome 和结果核对，外部 outbox/幂等投递暂不实现；执行结果不明时持久化真实恢复说明并继续认知，不自动重放；模型依自然语言意图与已知事实决定查询、提问或新调用
- 崩溃恢复必须区分未执行、确定成功、确定失败和结果不明；不能把网络超时当作失败并直接重发
- 工具 schema/参数验证、不可变 intent 持久化与 writer 所有权核对先于副作用；不设置独立 authorize 回调

## 扩展安全

Cordis 处理依赖、生命周期与资源清理，不是安全边界。用户已确认普通工具及 Shell 不要求产品隔离环境；OS 账户权限与自然语言意图判断仍有效。手工配置的可信本地扩展现由官方 Cordis 管理注册、服务依赖、激活、清理与 HMR；按 [ADR 0005](adr/0005-generated-extension-lifecycle.md)，已授权生成代码可用普通文件 stage/test/install/update/显式 rollback；测试、导入和执行均使用宿主 OS 身份且没有产品隔离。自动依赖安装与第三方市场仍不开放。宿主在当前工具批次完成后发布下一请求的工具代际，不把 HMR 当作原子回滚或权限沙箱。详见 [扩展宿主](../packages/extension-host/README.md)。

## 合并唤醒与判断

本增量遵循 [ADR 0002](adr/0002-coalesced-wake-loop.md)：所有待唤醒信息合并进入一轮，由模型决定处理顺序。超限使用普通文本文件与普通文件读取能力，不构造专用消息服务。主模型依据用户对话、上下文和自然语言 Prompt 决定调用工具或澄清，没有独立 allowed/evidence/denial 判断、替代引擎或额外模型调用，也不引入强制审批 UI 或风险分类硬门禁；真实身份、OS 账户权限、凭据保护和数据库一致性保持有效；不要求产品隔离环境，cwd 不是沙箱。

## 普通记忆与历史阶段

最新已确认约束见 [ADR 0006](adr/0006-memory-only-system-prompt.md)。只维护当前 v0.5/v0.2，移除 State 配置和自动引导，不保留旧格式解析或投影迁移；没有默认文件变更通知、自动 Wake 或重注入。Pi 原生通用文件和 shell 工具由组装层注册，历史查询固定 Mira 范围。Memory checkpoint、Git ref、PG receipt、Wake completion 分别可恢复，不宣称跨系统原子性。


## Mira Prompt 与动态请求边界

实际完整 v0.2 模板作为一个具名 Pi system section 进入真实请求上下文；未配置 Memory 也使用同一 Mira 身份。具名 section 更新会在 fenced writer/CAS 下先持久化，当前格式重启后延续同一 section，不按 Wake 叠加完整 Prompt。渲染只单次替换白名单占位符，转义动态文本边界，不递归解释 Memory/工具文字。

当前时间和可用能力在实际请求边界更新，工具说明来自该请求已准备的同一注册表；停用/更新不保留过时说明，不为说明刷新另起 Wake 或模型调用。Memory 部分始终使用该持续上下文保存的 bootstrap 快照，普通重启、Wake、压缩或文件编辑不重新读取 MEMORY.md。authorizationContext 只提供事实语境，不能伪造用户已批准；执行意图来自主模型实际调用，runtime 保留 schema/参数、不可变 intent/outcome、去重、来源与所有权检查。模型、采样、思考与 token 配置仍属于 Runtime/provider。

v0.5 §40 不引入额外产品隔离。用户再次确认普通工具和生成代码均按宿主 OS 身份运行；既有授权、凭据保护、OS 权限及数据完整性边界继续有效，无批准 UI 或固定风险硬门禁。
