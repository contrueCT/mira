# ADR 0051：子任务的有界文件工具、真正的取消、停滞唤醒与余额暂停

状态：Accepted，2026-10-31。补充 ADR 0025/0026/0037/0049。依据用户决定：用户只和 Mira 说话，界面不显示子任务的内部状态；子任务的观测只给模型；不伪造结果；合法的长时间工作不被终止。

## 背景

子任务在同一进程里各自运行 Pi 循环，不受主 Wake 的前台时限约束。它的文件工具没有时限（读 FIFO、挂住的网络路径会一直等）；取消只发出 abort，不理会 abort 的工具会一直占着并发槽位，让设置保存、重置和服务关闭一直等；取消也不关闭子任务开的终端和浏览器，而这两类名额是全局共享的。主 agent 也无从知道某个子任务多久没有动静；子任务遇到余额不足只记为一般失败。

## 决定

### 文件工具时限（`apps/server/src/file-tool-limits.ts`）

- 只包装子任务的 read/write/edit/grep/find/ls：每次调用 5 分钟。到时 abort，结果是 `{"status":"unknown"}`；write/edit 说明“文件是否改动未知，重试前先读”，只读工具说明“本工具不改任何东西”。
- 调用前先 `stat`：FIFO、socket、字符/块设备直接拒绝并提示用 `exec_command`。
- 不设单个工具的总时限，也不设每轮总时长或步数上限。bash（600 s）、终端（yield ≤10 s）、浏览器（35 s/45 s）保持原有限制。

### 取消要真正收尾（`subagents.ts`、`terminals.ts`、`browser-manager.ts`）

- `subagent_cancel` 照旧先把 queued/running 记为 cancelled、当前工具记为 unknown 并写入唤醒结果；然后 `closeOwner(child.streamId)`：只关闭 owner 与该子任务 stream 完全相等的终端和浏览器。主 agent（`writer.miraId`）、其他子任务、前缀相同的 owner 都不会匹配；用户正在接管的浏览器保留（`keptUnderUserControl`）。
- 取消后最多等 5 s。工作仍未停下就把槽位移出 `#active` 放进“已放弃”集合：不再计入并发、`hasActiveWork`（设置/探测 busy）、重置 busy 和 `close()` 等待。被放弃的工作仍带着 abort 信号，不能再写结果，结果保持 unknown。它仍持有该子任务的 stream writer，所以对它的后续指令会排队，等它真正停下后才开始。
- `close()` 对每个子任务最多等 10 s。

### 只给模型的观测

- 运行时状态（ADR 0049）对每个运行中的子任务给一行：`- 标题 (id) · running X · idle Y`，总预算 1 KiB，超出写“…and N more”。
- `subagent_status` / `subagent_wait` 的结果增加 `lastActivityAt` 与 `currentFor {kind,name,ms}`。为保持输出小，只有最新一轮带最近 8 条活动；更早的轮次只给状态、结果和 `omittedEvents` 计数。
- 活动来源：运行时的模型/工具事件、`report_progress`、每个流式模型事件、该子任务终端的输出。只要有活动就重置空闲时间，长时间但有输出的工作不会被视为停滞。
- 空闲满 15 分钟写一次会唤醒主 agent 的 `subagent.stalled` 事件（ID `["subagent-stalled", turnId, episode]`；再次有活动后再停滞才算新一次）。payload 含子任务、标题、开始时间、最后活动时间、空闲分钟数和当前活动。由 Mira 决定 send、cancel 还是继续等。时间线不投影这个事件。

### 余额

- 子任务的 transport 接上 `onFailure`，按终止消息识别余额拒绝。子任务这一轮记为 failed，结果写明余额不足（HTTP 状态、request id），并说明 Mira 暂停到用户充值后发消息。
- 该结果照常唤醒 Mira；Mira 自己的请求收到同样的拒绝，进入 ADR 0048 的暂停（暂停证据始终来自真实的服务商响应）。从子任务被拒到用户发消息之间，以及暂停期间，`subagent_spawn`/`subagent_send` 返回 `paused`；已记录的 spawn 调用仍返回原回执。

## 不做

不在界面显示子任务的耗时、空闲或停滞；不自动重跑或替 Mira 取消；`subagent_send` 不中断正在运行的工具（要立即停止就用 `subagent_cancel`）；工具声明和系统提示不变（v0.4），新语义写在结果与事件的 note 里。

## 已知限制

- 被放弃的工作仍占着一个 PG 连接和该子任务的 stream writer，直到它真正结束；Node 线程池里卡住的 fs 调用无法取消。
- 停滞检测在进程内；重启后运行中的子任务照旧记为 interrupted（ADR 0025）。
- 浏览器命令本身不产生中间活动；单条命令 ≤35 s，不影响 15 分钟判断。
- 子任务被拒后，Mira 的下一次请求才产生真正的暂停；这次请求被拒不计费。
