# ADR 0049：前台工具时限、转入后台与有界等待

状态：Accepted，2026-10-31。依据设计稿 `mira-usage-unstuck-design/design.md` B 部分与用户决定：用户只和 Mira 说话，前端不显示任何内部状态（后台任务、子任务、耗时、工具超时）；运行状态只给模型看。

## 背景

一次唤醒只有一个活动 run。插话（ADR 0024）只在工具边界或模型请求前送达；一个卡住的工具（构建、网络等待、扩展调用）会让用户的新消息一直等。此外扩展上下文提供方、`extension_manage` 的等待和 Memory Git 快照没有时限。

## 决定

### 前台租约（`@mira/runtime-pi` `foreground` 选项）

- 只作用于主 Wake 的工具（子任务不受影响）。每次执行与一个租约赛跑：
  - **硬时限** 5 分钟；
  - **插话宽限**：有未送达的用户消息且该工具已运行 ≥ 20 s。
- 租约先到时**不终止**工具：工具改用脱离本次 attempt 的信号继续运行（只有服务关闭会取消它），运行时返回诚实回执作为该调用的已知结果：
  `{"status":"backgrounded","jobId","elapsedMs","note":"Still running; outcome unknown; it will arrive as a later event. Do not assume success or failure."}`，`isError: false`。随后插话在下一个边界照常送达。
- 不可转入后台：`send_reply`、`history_search`、`history_read`（服务端 `promotable`）。
- 工具真正结束后回调 `onSettled`：正常结果或“抛错”（抛错不证明失败，载荷写明这一点）。从不编造结果。

### 后台作业（服务端 `background-jobs.ts`，全部是追加事件）

- 转入后台时先写不唤醒的系统事件 `tool.background.started`（ID `["tool-background-started", jobId]`），成功后才返回回执。
- 结束时写唤醒事件 `tool.background.settled`（ID `["tool-background-result", jobId]`），载荷含真实结果文本（≤16 KiB，超出标注截断）。按 ADR 0048，余额暂停期间它只入队不启动认知。
- 启动时 `pendingBackgroundJobs()` 找出没有结果事件的 started 事件，写同 ID 的唤醒事件 `tool.background.lost`：结果未知、未重跑。同一 ID 保证 settled/lost 只有一个，重启多次也只记一次。
- 迁移 `1760000000012_background-jobs` 只加一个部分索引 `life_events(mira_id) WHERE type = 'tool.background.started'`，不建新表。

### 只给模型的运行状态

- 新送达的用户输入（插话，以及有后台作业或子任务在跑时的首条输入）末尾追加一段 `[Mira runtime status — system-sourced, not written by the user]`：Wake 开始时间与已过时长、“在安全边界送达，没有取消任何东西”、仍在后台的工具与时长、运行中的子任务数。≤4 KiB。
- 存在用户消息记录的 `miraRuntimeStatus` 字段里，正文是确定性输入 + `\n\n` + 状态。恢复时剥离该段再与重新渲染的输入逐字比较；字段被篡改或位置不符即阻止恢复。时间敏感的内容因此不会破坏确定性恢复。
- 时间线只投影事件里的用户原文，状态段永不渲染。

### 有界等待

- 扩展上下文提供方：每个 5 s（`contextProviderTimeoutMs` 可注入），超时记 `status: "timeout"`，迟到的结果丢弃；健康诊断同 failed。
- `extension_manage`：等待 60 s 后返回 `{"status":"pending"}`，变更继续应用，结果用 `extension_inspect` 查看。工具声明不变，说明放在返回的 `note` 里。
- Memory Git 快照（beforeComplete）：60 s 后中止本次完成尝试，Wake 保持 running，下次恢复重试。
- `exec_command` 新增 `notify_on_exit`：调用返回时进程仍在运行，则进程结束后写唤醒事件 `terminal.exited`（ID `["terminal-exit", sessionId]`，只含退出码与输出字节数）。显式 `terminal_close` 或服务关闭不通知；只对主流程生效。
- 上下文压缩不可被插话打断，也没有界面提示。合法等待（定时、子任务、长进程）照旧结束本次唤醒、靠事件恢复，看门狗不触碰它们。

## 不做

不提供停止按钮；不在聊天或头部显示后台任务、耗时或超时提示；不自动重跑丢失的工具；子任务内部的工具不转入后台。

## 已知限制

- 转入后台的工具与之后的工具可能并发（例如同一终端或浏览器），由工具自身的串行化保证。
- 服务关闭会取消后台工具，重启后记为 lost。
- 扩展宿主关闭仍会等待挂起的提供方回调结束（信任代码的资源租约不变）。
- `exec_command` 声明新增一个可选参数，系统提示升到 v0.4：原生行为证据（`docs/acceptance/reply-native-behavior.md`）需要重新录制，本次未运行付费探针。真实 PG 回放在计算声明摘要前只去掉 `notify_on_exit` 这一项，其余声明仍须逐字一致。
