# ADR 0007：主模型决定动作，移除独立授权门禁

状态：Accepted，2026-10-06。用户批准移除 `PiRuntimeOptions.authorize` 布尔执行门禁。该决定取代 ADR 0001/0002 的独立授权回调及对应执行前置条件，也取代 ADR 0006 中“Prompt 不能代替 authorize hook”的表述；其它持久化、恢复、Prompt、Memory 和宿主 OS 边界不变。

## 决策归属

主模型在持续上下文中看到用户对话、事实、既有自然语言指令和完整 Mira Prompt，直接决定调用工具或先向用户澄清。不再先产生一个工具调用，再交给独立 `authorize` 回调返回 `allowed`、`evidence` 或拒绝/延后理由。没有替代授权引擎、额外模型调用、批准 UI、固定风险分类或同参重试否决。

这进一步明确原始 v0.5 §37–39 的实现方式。原始设计文档及实际 v0.2 Prompt 模板均保持原始字节；以本 ADR 说明后续决定，不改写原文。

`miraPrompt.authorizationContext` 和 `CURRENT_AUTHORIZATION_CONTEXT` 保留为事实性的 Prompt 语境。它们可呈现用户已经表达的指令与相关事实，不能合成“已批准”证明。第三方网页、工具结果、Memory 和扩展说明不能冒充用户授意。模型输出本身也不是用户已同意的证明。澄清是主模型的普通回复；没有对应工具调用就没有工具 intent，也不制造“授权拒绝”恢复记录。

## 执行与来源

主模型实际发出工具调用后，runtime 继续执行技术 schema/参数验证、调用来源和唯一 ID 检查，并在副作用前持久化不可变 intent。工具必须接收 intent 中相同的已验证参数；原始 requested arguments 独立保留。静态工具、普通文件/Shell、扩展及扩展管理工具使用同一路径。

删除 `ToolIntent.authorization`，不添加替代 `executionContext` 或决策字段。已有 `assistantRecordId` 关联真实、不可变的 assistant 工具调用及同条叙述，持久化工具记录的 context version 定位当时权威上下文；这些事实与原始历史、恢复说明共同保留来源。不要把模板常量、provider 合成脚本或 runtime 自动构造的文本保存为用户授权证据。

该字段原本位于 intent JSON，未对应独立 SQL 列；本次不增加数据库迁移、旧设计兼容转换、数据删除或重置。持久历史仍按原样保存，不为了移除执行门禁改写用户数据。

## 保留的机械边界

- 技术 schema 验证、参数规范化、注册工具代际一致性和不支持的 `prepareArguments` 拒绝
- assistant 调用先落库、intent 先于副作用、outcome 先于 transcript result，已保存结果按原值恢复
- 同一 call ID 不重复执行；新的同参调用由主模型结合用户意图和已知结果判断
- CAS、跨进程 writer 所有权、失效停止、取消和不可变记录约束
- 已发出但未取得确定结果的操作如实显示为 unknown，不伪造失败、不自动重放；缺少 intent 的已记录调用显示 not-started
- 原始历史与来源、未决事实跨重启和压缩保留，Memory bootstrap 冻结快照和 Memory Git lineage 不变
- 真实身份、宿主 OS 账户权限与凭据保护；无新增产品隔离环境，cwd 和 Cordis 仍不是沙箱

技术检查可以拒绝无效或过期执行；它们不承担用户意图分类。移除回调不意味着已发送的外部效果可撤回，也不构成 exactly-once 承诺。

## 包与验证范围

`packages/authorization` 可保留为空的语境职责占位，但没有待补的授权 gate、Consent Resolver 或独立模型判断服务。server 假 provider 继续只用于确定性演示，不再注入永远通过的合成授权回调。

验收检查主模型直接调用和普通澄清两条路径，以及无回调下的 schema、不可变参数、intent/outcome、重复 ID、失败/取消、所有权、重启、压缩和扩展工具一致性。所有模型测试仍为假 provider；它们验证执行契约，不能证明真实模型的自然语言判断质量。实际命令、通过/失败和 PostgreSQL CI 以本次确切提交的验证记录为准。
