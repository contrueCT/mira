# ADR 0006：Memory-only 与完整 Mira System Prompt

> 后续变更：独立 authorize 回调、执行前授权 gate 及合成授权证据由 [ADR 0007](0007-model-owned-action-decisions.md) 取代。主模型直接依据对话/Prompt 决定调用或澄清；下文保留当时决定与阶段事实，技术校验、持久 intent/outcome、来源及恢复约束不变。

> 后续变更：2026-10-08 的 [ADR 0016](0016-automatic-compaction-memory-refresh.md) 明确取代本文“仅初始化加载、压缩不重新读取 Memory”的表述。当前行为是初始化读取，且每次成功压缩在一个 fenced CAS checkpoint 中原子保存重新读取的 Memory/system、摘要与尾部；普通请求/文件修改不加载，重启恢复最新快照。下文这些旧句保留为历史决定，不再是当前约束。

状态：Accepted（Memory 压缩刷新部分由 ADR 0016 取代）。2026-10-05 用户要求按 v0.5 移除独立 SemanticState，并集成提供的完整 v0.2 System Prompt；再次确认普通工具与生成代码都不增加产品隔离环境。2026-10-06 用户进一步确认项目仍处早期开发，只维护当前 v0.5/v0.2 设计，不保留旧设计兼容层。本文取代 ADR 0003 的 State 配置/引导决定，并补充 ADR 0004/0005，未撤销其它已确认边界。

## 原文与优先级

- [Architecture v0.5](../design/architecture-v0.5.md) 是最新设计
- [Prompt Design v0.1](../design/system-prompt-design-v0.1.md) 是设计说明，不代替实际模板
- [System Prompt v0.2](../../packages/runtime-pi/prompts/mira-system-v0.2.md) 是实际运行模板，保留所有原始正文、标题与 13 个示例
- [v0.4](../design/original-v0.4.md) 保持原字节作为历史存档；来源、大小及 SHA-256 见 [manifest](../design/sources.json)

源文保持原样。v0.5 §40 的 filesystem/network/secret scope、资源及进程限制描述不新增产品隔离要求：用户已重新确认普通工具及生成扩展的测试、导入和执行使用宿主 OS 身份。cwd、目录布局、Cordis 和生成版本快照都不是沙箱。自然语言授权、真实身份/OS 账户权限、秘密保护、工具 intent/outcome、单写者及数据完整性继续有效；不增加批准 UI、硬风险门禁或固定重试否决。

v0.5 §17 和 Prompt 中的初始化/重建不等于普通恢复。只有真正初始上下文读取 MEMORY.md；正常 Wake、重启、文件变化与 Compaction 不重新读取或自动回注。明确替换上下文的产品 API 仍未实现，不借本次升级重新创建 Mira。

## Memory-only

移除工作空间和 server 的 stateRoot/stateFiles、State 目录初始化及 State bootstrap。配置只需 memoryRoot；保留普通文件、自主组织、Memory 独立 Git、repositoryId、checkpoint/ref/receipt 和 lineage 恢复机制。不删除持久上下文、Continuation State、工具/扩展状态、队列或恢复记录。

近期情绪、关注和心理变化自然属于 Working Context；必要时由普通压缩摘要延续。真正形成长期认识时可用普通工具写 Memory，无心理状态 schema 或额外 engine。模板的 memory_state 标签表示长期 Memory，不能因为名称包含 state 而删除。

## 完整模板与请求边界

运行时使用单一规范模板资产。只允许 MEMORY_ROOT、MEMORY_STATE、CURRENT_TIME、EXTENSIONS_ROOT、OTHER_ENVIRONMENT_CONTEXT、DYNAMIC_TOOL_AND_EXTENSION_GUIDANCE、CURRENT_AUTHORIZATION_CONTEXT 七个键、八处替换。仅执行一轮白名单替换；输入中出现的占位符不会再次展开；动态值转义 XML-like 边界字符，不能关闭外层标签。未知模板占位符与缺失必需参数显式失败，不读取环境秘密来填充上下文。未配置根目录如实说明，不虚构路径。

完整文本使用 Pi 公开具名 system section `mira.system.v0.2` 更新语义；不能每个 Wake 再叠加一个完整人格 Prompt。section 创建/变化先经过现有 fenced writer、版本 CAS 和追加持久记录，再发出模型请求。初始安装和后续请求统一使用 `miraPrompt`，不保留独立的旧初始化入口。

动态 CURRENT_TIME 在真实请求边界取值；能力说明来自该请求同一份已准备工具注册表。工具批次完成后，下一自然请求才发布新的工具/说明；停用或更新不留下过期指导。不为刷新 Prompt 另起 Wake、额外模型调用或不同人格。持久 Memory bootstrap 快照用于后续渲染，普通恢复不重新访问 MEMORY.md；正常工具读取仍可得到用户明确需要的当前文件内容。

动态授权上下文是证据，不授予权限、不代替 authorize hook 或 schema 验证。演示固定合成授权仍只是测试组装，没有通用自然语言 consent resolver。model ID、temperature、thinking、token budget 和凭据保持 Runtime/provider 设置，本次源文未授权改变采样默认值。

## 当前设计与持久恢复

项目仍处早期开发，仅实现 Architecture v0.5 与 System Prompt v0.2。删除旧 State 配置、弃用提示、旧工具别名及旧 Prompt/bootstrap 兼容代码；不解析旧 Memory/State 拼接文本，不转换历史 checkpoint，不维护旧格式投影。原始设计和模板归档仅用于来源核验，不构成运行时兼容承诺。

真正空的 version-zero 上下文才调用 Memory loader，并将初始 Memory 内容保存为首条 system 记录的 `miraMemory` 冻结快照。后续请求、重启和压缩沿用该快照，不重新读文件。普通具名 system 更新仍走追加记录、fenced writer 与版本 CAS；崩溃恢复不得重复工具副作用，压缩继续校验确切有效 system 和合法工具配对。

本决定不引入清理、删除或重置用户数据的脚本或 API，也不削弱当前格式的持久上下文、原始历史、Continuation State、队列、恢复记录及 Memory Git 的 repositoryId/checkpoint/ref/receipt/lineage 完整性约束。数据库迁移与故障恢复机制继续服务当前实现，不承担旧 Prompt/State 格式升级。

## 验证与范围

[验收目标](../acceptance/foundation.md)要求检查源字节、单次转义替换、真实 streamFn 请求上下文、连续上下文/重启/压缩、能力更新、CAS/崩溃窗口、Memory 不重读及静默 Wake。

所有模型验证仍是确定性假 provider；真实 PostgreSQL 验证与离线测试分开报告。本决定和历史阶段 CI 成功不等于本次增量验证已完成。对话自然度、人格连续性和主动性 A/B 属于后续真实模型评估；本次不宣称 live-provider 成功。没有 HTTP/UI、真实模型凭据、自主生成质量或部署承诺。
