# ADR 0059：工具执行前拒绝后继续认知

状态：Accepted，2026-11-15；已实现。用户要求参数超限等错误不停止 Mira 的行动，并将具体原因告诉 Mira。

## 行为

`exec_command.max_output_bytes=9000` 超过声明的 8192 上限时，Pi 会在 intent hook 前拒绝。旧 adapter 把没有 durable outcome 的 SDK 校验结果升级为整轮运行错误，Mira 无法得知原因并修正参数。

在公开 `tool_execution_start` 边界，adapter 使用本轮已发布并固定的工具定义、Pi 1.0.2 的公开参数校验 API 预检；保持 SDK 的 optional-null 归一化与类型转换。缺少工具或参数不符合 schema 时，当前 attempt 结束，沿用 `mira.recovery-observation.v1` 持久保存 `not-started` 和执行前诊断，再继续同一 Wake/task 的认知。用户插话仍在旧调用准备前优先消费。

```text
模型调用 → 固定定义 + 参数校验
                   |
                 拒绝 → not-started + 明确原因落库
                                      |
                               Mira 继续当前任务
                                      |
                             自行修正参数、选择新调用
```

已经完成的结果保持原样；原 batch 中尚未开始的后续调用保留 not-started，不自动重放。无效参数不会生成执行 intent、执行效果或伪造 toolResult；Mira 从恢复观察中获知确定未执行。工具 execute 抛错仍按 ADR 0015 保留 unknown，数据库、版本、writer fencing、结果落库或观察发布失败仍致命。

## 诊断与持久化

扩展 ADR 0015 的可选诊断：`phase=prepare`，类别为 `tool-not-found` 或 `invalid-arguments`，只允许关联无 intent 的 `not-started` 调用。原 execute/result 诊断继续只允许关联 unknown intent，原两键/96 字节限制不变。仍校验 call ID、assistant record、工具名、原始参数、batch 顺序和真实执行证据；已知结果不能带恢复诊断。

参数诊断可携带最多 8 个 schema 约束，字段仅为路径、固定校验关键词、有限数值边界或基本类型，例如 `/max_output_bytes / maximum / 8192`。新增诊断总长最多 2048 字节；路径仅投影声明属性及数组位置。Pi 仍决定参数是否有效；从其固定 1.0.2 公开校验拒绝 header 识别归一化后的失败，只投影能与当前声明核对的有限约束，不复制原异常文字或输入。未识别约束给固定 schema 拒绝说明；无法识别的校验器故障仍致命。依赖版本不变。

不复制 SDK 异常文本（其中含完整输入）、实际被拒绝的值、动态属性名、enum 内容、pattern、URL、headers 或堆栈。原始请求参数继续按原历史契约保存。重启和压缩保留诊断；提交前崩溃只保留能从权威记录证实的 not-started，不猜测丢失原因。不新增数据库表、日志系统、修复代理或自主重试策略。

## 验证

Node 24 下 `pnpm check` 通过（1426 项后端/基础测试、98 项网页测试，0 跳过，类型/边界/构建通过）；定向测试 183/183、真实 PostgreSQL 与服务/终端及既有诊断回归 10/10 通过。全新独立主代码复审无阻断。定向用例覆盖 9000/10000/12000 超限、缺少工具、修正后的新调用、同批顺序、插话优先、参数转换、诊断边界与敏感值、重启/压缩、发布失败。隔离 PostgreSQL 与真实服务验证同一 Wake 完成、真实终端仅执行修正调用、原历史不变和持久化故障不降级。合成模型测试不代表真实模型质量验收。

部署以服务器现有发布树叠加本次修复，保留 General、飞书和浏览器修复。新 prepare 诊断写入后，旧 reader 无法恢复该格式；自动回滚必须在候选确实停止后确认数据库没有 prepare 诊断，否则保留候选和全部数据，向前修复。停机后再次确认没有活动或排队工作，发布前备份私有目录与数据库。
