# ADR 0006：Memory-only 与完整 Mira System Prompt

状态：Accepted。2026-10-05 用户要求按 v0.5 移除独立 SemanticState，并集成提供的完整 v0.2 System Prompt；再次确认普通工具与生成代码都不增加产品隔离环境。本文取代 ADR 0003 的 State 配置/引导决定，并补充 ADR 0004/0005，未撤销其它已确认边界。

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

完整文本使用 Pi 公开具名 system section `mira.system.v0.2` 更新语义；不能每个 Wake 再叠加一个完整人格 Prompt。section 创建/变化先经过现有 fenced writer、版本 CAS 和追加持久记录，再发出模型请求。初始流和已有流都安装，不只依赖空上下文 initialContext 回调。

动态 CURRENT_TIME 在真实请求边界取值；能力说明来自该请求同一份已准备工具注册表。工具批次完成后，下一自然请求才发布新的工具/说明；停用或更新不留下过期指导。不为刷新 Prompt 另起 Wake、额外模型调用或不同人格。持久 Memory bootstrap 快照用于后续渲染，普通恢复不重新访问 MEMORY.md；正常工具读取仍可得到用户明确需要的当前文件内容。

动态授权上下文是证据，不授予权限、不代替 authorize hook 或 schema 验证。演示固定合成授权仍只是测试组装，没有通用自然语言 consent resolver。model ID、temperature、thinking、token budget 和凭据保持 Runtime/provider 设置，本次源文未授权改变采样默认值。

## 兼容与迁移

不存在需要删除的 SemanticState SQL 表。不改写已应用迁移、不 DROP 数据、不重置上下文版本。旧 State 文件逐字节保留，不移动、不删除、不自动提升到 Memory；旧配置只给出弃用/忽略提示，不访问对应目录。

已有流使用追加的 `miraPromptState` version 1 元数据保存安装与迁移证据，复用可识别旧 bootstrap 的 Memory 初始内容；无旧 bootstrap 时为空，不在升级时重新读文件。旧格式分隔符未经转义，迁移保守地在第一个 File 标记前停止 Memory 提取，避免吸收 State；模糊头部需显式核对。旧 bootstrap 中的 State 是历史记录；若不再进入有效投影，必须通过明确版本化、追加式投影迁移记录完成，原始记录、工具声明、工具配对及原始历史继续保留。已有流不得因安装 Prompt 再读 Memory 文件。追加后崩溃重启与重复安装必须幂等；不得重放工具副作用。压缩保留确切有效 system，沿用既有 checkpoint 一致性检查。

## 验证与范围

[验收目标](../acceptance/foundation.md)要求检查源字节、单次转义替换、真实 streamFn 请求上下文、已有流/重启/压缩、能力更新、CAS/崩溃窗口、Memory 不重读、旧 State 不触碰及静默 Wake。

所有模型验证仍是确定性假 provider；真实 PostgreSQL 验证与离线测试分开报告。本决定和历史阶段 CI 成功不等于本次增量验证已完成。对话自然度、人格连续性和主动性 A/B 属于后续真实模型评估；本次不宣称 live-provider 成功。没有 HTTP/UI、真实模型凭据、自主生成质量或部署承诺。
