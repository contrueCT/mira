# ADR 0052：子任务的结构化回报、能力与附件、批量唤醒和关闭

状态：Accepted，2026-10-31。补充 ADR 0025/0026/0037/0051。依据用户决定：界面不显示子任务、后台工作或内部状态；工具名只用 `[a-zA-Z0-9_-]`；取消和关闭只收尾该子任务自己的终端和浏览器；主提示和子任务提示都只做最少的追加。

## 背景

子任务结束时只有一段自由文本，Mira 要从中猜结论和下一步；子任务需要决定时也只能写在文本里。子任务拿不到扩展工具和用户发来的附件。多个并行子任务各自唤醒一次 Mira。`subagent_cancel` 之后子任务的终端、浏览器和内存状态一直留到服务关闭，没有办法真正结束一个子任务。

## 决定

### `task_report`（P0）

- 子任务专用工具 `task_report {summary, question?}`：summary ≤600 字符，产出和路径写在 summary 里；question ≤2000 字符。没有 status 枚举，也没有 artifacts/checks 字段。
- 有 question 时这一轮照常结束，转录保留；Mira 被唤醒一次，看到 summary 和 question，用 `subagent_send` 回答（需要用户决定时先问用户）。没有 question 就表示这项工作完成。
- 回报取自持久转录：本轮最新 user 消息之后、最新一次成功的 `task_report` 结果（`details.report`）。之后再消费的 followup 会让旧回报失效，不需要内存状态。
- 有回报时 `subagent.result` payload 依次是 `summary`、`question`、`awaiting`（提示用 subagent_send），`result` 只有 `{fullResultPath, finalRecordId}`，完整回复写入溢出文件。没有调用 `task_report` 时保留原来的原始文本，只在内部记 `reported:false`，不做任何推断。
- `subagent_status` 列表每个子任务一行：`id · "标题" · 状态 · group "x" · has pending question · closed`。

### 能力与附件（P1）

- `subagent_spawn.capabilities`：扩展 ID（`extension_inspect` 的 `extensions[].id`，最多 16 个）。子任务每次模型请求都拿到这些扩展当前的工具声明；过期 activation 照旧由 host 拒绝（ADR 0014）。
- `ExtensionTool.mainOnly` 的工具不会给子任务；飞书的 `feishu_connect`、`feishu_send_message` 标为 mainOnly。扩展管理工具从不给子任务。只包含 mainOnly 工具的扩展、不存在的扩展会让 spawn 返回 invalid。
- 子任务调用的扩展工具在 `runDelegated`（AsyncLocalStorage）里执行，期间 `schedules.create/replace/cancel` 一律拒绝，提示改为回报 Mira。
- `subagent_spawn.attachments`：聊天附件 ID（最多 10 个），按引用交给子任务，冻结在 spec 里；第一轮输入列出引用，图片在模型支持时原生可见（与主 Wake 同一套 hydrate）。只在 spawn 时传，send 不带附件。

### 批量唤醒

- `subagent_spawn.group`（≤64 字符）。同组成员结束时各自写持久结果，但只有最后一个结束时唤醒 Mira 一次，payload 带 `group {name, members, omitted}`：每个成员的最新一轮、summary/question 或最多 1500 字节的原始文本摘录，最多列最新 32 个。较早结束的成员写不唤醒的事件，`group {name, pending:true}`。不需要迁移：组名在冻结 spec 里。

### `subagent_close`

- 新的独立工具。`subagent_cancel` 只停当前这一轮，子任务仍可 `subagent_send` 继续；`subagent_close` 是完全收尾，不可再继续。由 Mira 决定，提示只说明何时用哪个。
- 关闭：中止当前运行；把未结束的轮次记为 cancelled（不唤醒）；写入只追加表 `subagent_closures`（迁移 `1760000000013`，幂等，按 `(parent_mira_id, call_id)` 唯一）；`closeOwner(streamId)` 只关闭 owner 与该子任务 stream 完全相等的终端和浏览器，并丢掉它们已结束的句柄（主 agent 的从不匹配）；运行停下后 PG writer 在 finally 释放；清掉该子任务在所有 Map/Set 里的状态。未在 5 s 内停下的工作按 ADR 0051 放弃，停下时清理且不重启。
- 已关闭的子任务 `subagent_send` 返回 `closed` 错误；`subagent_status` 仍能读到全部历史和结果。
- 安全网：服务关闭时清空所有状态（终端和浏览器本来就全部关闭）；已结束且空闲 4 小时的子任务释放终端、浏览器和内存（`releaseIdle`），这不是持久关闭，之后仍可 send。

### 关闭前的内存占用（实现前核查）

- `#cancelled` 只增不减（很小）。
- 子任务结束后它的终端和浏览器会话一直开着，直到服务关闭；这是主要的占用，句柄缓存有上限（浏览器 64、终端 `terminalLimits.retained`）。
- PG writer 每次运行获取、finally 关闭，两轮之间不占连接；被放弃的工作在停下前持有自己的 writer。
- 监听器集合会自行清理，每轮的运行时对象会被回收。

### 提示

主提示 v0.5（v0.4 的 SHA 继续可验证）只改标题并在 `</delegation>` 前加一段：

```
Workers end with task_report: a short summary, or a question you answer with subagent_send (ask the user when it needs their decision). Pass the capabilities and attachments a worker needs; give a batch one group to be woken once. When you no longer need a worker, close it with subagent_close; subagent_cancel only stops its current turn.
```

子任务系统提示只在 “Child ID:” 前加一句：

```
When done, call task_report with a short summary (outcome, paths, checks); if you need a decision to continue, include a question and end the turn.
```

`subagent_spawn`/`subagent_status` 的原描述不变，只在末尾追加一段；`subagent_spawn` 只增加可选参数。

## 不做

不在界面显示子任务、回报、问题或分组；不推断未回报结果的状态；子任务不能直接联系用户、改日程或管理扩展；不提供单独的“子任务模型”设置。

## 已知限制

- 同组成员如果在其余成员 spawn 之前就结束，会单独唤醒；工具描述要求一次性 spawn 整组。
- 组名可以复用，roster 只列最新 32 个成员。
- 附件只在 spawn 时传入。
- 4 小时空闲释放不是持久关闭。
- 日程拒绝只在 host 的 delegated 调用作用域内生效；扩展把工作推迟到调用结束之后再改日程不受限制。
- 原生行为录制（`docs/acceptance/reply-native-behavior.md`）早于本 ADR 的声明和提示变化，需要重新付费录制；回放只去掉 `subagent_close`、新增参数和追加的描述后比对。本次没有运行付费评测。

## 验证

`tests/unit/subagent-capabilities.test.mts`（工具名正则、mainOnly 过滤、delegated 日程拒绝、payload 形状）；`tests/recovery/subagent-reports.test.mts`（真实 PG/服务：能力、图片附件、问题与回答、分组单次唤醒、未回报原文、关闭后拒绝 send、多次 spawn/close 后 Map、监听器、PG 连接回到基线，空闲释放可恢复）。
