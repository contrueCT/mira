# ADR 0048：用量统计与余额不足暂停

状态：Accepted，2026-10-31。用户确认设计稿 `mira-fixes-design/usage-*`、`balance-notice-*` 与答复：余额暂停后由用户的新消息直接重发请求（不做 DeepSeek `/user/balance` 预检）；统计按唤醒而非按会话；不显示费用、不设上限、聊天里不逐条显示用量。2026-10-31 追加反馈：提示改为“Mira 的所有动作都已停下，发一条消息就会继续”，删除“工具调用没有确认结果”一句，卡片与对话列左右对齐；前端不显示内部状态。

## 决定

### 用量（只读）

- `GET /api/usage?range=today|7d|30d&tz=<IANA>`：时区由浏览器提供并用 `Intl` 校验；按本地日分桶。返回合计、上一等长区间、每日（today/7d 为 7 天，30d 为 30 天）、按来源（主对话/子任务/上下文压缩/Dreaming）、用量最多的 5 个唤醒、最多 10 个模型。只有 token 与请求数，不含费用字段。
- 统计源是已持久化的上下文记录：每条 assistant 消息是一次**最终**请求（重试中失败的尝试不入库，不计数）；`stopReason` 为 error/aborted 的消息只计次数与失败数，不计 token。压缩 checkpoint 携带的 usage 计入“上下文压缩”。子任务按 `subagents.parent_mira_id` 汇总子流。合计 = input + output + cacheRead + cacheWrite。
- 存储不解释 Runtime 载荷：`@mira/life` 定义 `UsageProjection`，`@mira/runtime-pi` 导出 `PI_USAGE_PROJECTION`（JSON 路径），`@mira/persistence` 的 `PostgresUsageReader` 用 `#>` 通用聚合，只读快照、10 s 语句超时。迁移 `1760000000011_usage-indexes` 增加 `(mira_id, occurredAt)` 与 `(mira_id, claimed_version)` 索引。
- 记录归属唤醒：`claimed_version` 小于记录版本的最近一个 Wake；该 Wake 含 `memory.dreaming` 事件时计为 Dreaming。
- 界面：设置 → “用量”（位于“运行记录”之后）；手机上设置标签横向滚动，不再挤压文字。

### 余额不足暂停

- 分类只看结构化信号：HTTP 402，或 `error.code`/`error.type` ∈ {`insufficient_quota`, `insufficient_balance`, `billing_hard_limit_reached`}。命中即清除重试原因——OpenAI 的 429 `insufficient_quota` 不再重试 5 次。不匹配消息文本。
- 主 Wake 的模型请求以余额失败结束时，写入不唤醒的系统事件 `model.balance-paused`（ID `["balance-paused", runId, n]`，载荷含 status、requestId、provider、model），服务进入 `paused` 状态而不是 `error`；Wake 保持 running，不完成、不重放。
- 暂停期间所有非用户来源都不启动认知：重启恢复、定时投递、扩展/外部唤醒、子任务完成回调、设置保存后的补踢、Dreaming。它们的事件照常持久入队。
- 只有**新插入**的用户消息恢复：先写 `model.balance-resumed`（同 runId、n），再启动 drain；消息按 ADR 0024 作为插话附着到同一 Wake，排队事件随后处理。重复提交（duplicate 回执）不恢复。
- 再次 402 写 n+1 的暂停事件，再次暂停；没有任何自动重试循环。
- 重启时从 History 重建：最新 Wake 仍 running 且 paused 事件多于 resumed 事件即为暂停。
- 结果不明的工具调用按既有恢复语义保持“未知”，暂停与恢复都不改写它（只在测试里验证，界面不再提及）。
- 界面：聊天里一张与对话列左右对齐的暖色卡片“模型余额不足，Mira 已暂停”，正文说明 Mira 的所有动作都已停下、充值后发一条消息就会继续，附 HTTP 状态与 request ID 便于向服务商查询；头部状态只显示“余额不足，已暂停”。用量页顶部同样提示。

## 不做

不查询供应商余额接口；不估算或显示费用；不设用量上限或告警；子任务自己的模型请求遇到 402 只让该子任务失败，不暂停主 Mira。

## 已知限制

- 用量只覆盖已写入上下文的请求：在 Pi 写入前就失败的请求（例如传输层 402 之外的早期错误）或失败的压缩请求不计数。
- Wake 归属按版本区间近似；同一区间内的插话与主请求合并统计。
- 时间用记录的 `occurredAt`（ISO 文本）比较，依赖 Pi 写入 UTC `toISOString()` 格式。
