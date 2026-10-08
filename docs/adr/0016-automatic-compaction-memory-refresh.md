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
3. 自动或显式压缩的 SDK 摘要成功后，读取当前 MEMORY.md；使用已保存的 Prompt 渲染输入刷新 Memory 部分，保留其余 system section 和本次已准备的 Skills 目录。
4. 新 Memory/system、摘要及合法近期尾部在同一 fenced CAS checkpoint 中提交。原始历史追加保留，不在压缩前另发 Memory 更新。

压缩已带 Memory 的持久上下文时必须提供 `miraPrompt`。初始记录与 checkpoint 保存 `miraMemoryConfigured`，区分未配置 Memory 与已配置但内容为空；已配置流压缩时缺少 `loadMemory` 必须在摘要请求前拒绝，不能清空或静默沿用旧快照。未配置流可以在成功 checkpoint 中首次启用 loader，之后不能静默降级。完整 Memory/Prompt 快照链在恢复修复写入前校验。读取、摘要、预算、取消、所有权或 CAS 失败均不能部分发布刷新。COMMIT 已发出但响应丢失仍需权威数据库恢复，不能声称已撤销。正常请求的具名 Prompt 更新仍走原来的追加历史路径；压缩不是重建新 Mira。

## 溢出与执行事实

明确的 provider context overflow 每个 run 最多允许一次压缩后恢复重试；输入已落库时不得重复追加。普通网络/认证/取消/数据库错误不伪装成上下文溢出；第二次溢出、不能缩小或不能容纳时终止，不无限重试。

恢复从持久记录继续，不重放已执行工具。工具合法配对、不可变 intent/outcome、全局 History UUID、未知结果及其安全诊断保持原有边界；摘要文字不能覆盖真实未知操作事实。摘要请求继续使用受限 disposable SDK、显式注入 stream、无凭据发现或网络回退。

## 验证要求

离线覆盖默认值/无效配置、阈值两侧、实际输出 reserve、完整 system 与工具 schema 开销、大尾部/不能缩小、工具批次后的同轮压缩、溢出一次成功恢复与第二次失败、非溢出错误、取消/所有权/CAS、Memory 读取失败及无部分发布、最新快照重启和未知操作不重放。真实 PostgreSQL 覆盖原子持久化与恢复；模拟 provider 不代表真实模型质量或 paid-provider 验收。

执行结果以本次实际检查输出为准；本文记录批准的边界与验收要求，不将未执行测试写成通过。
