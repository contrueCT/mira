# ADR 0047：记忆重置与从头开始（新的连续生命）

状态：Accepted，2026-10-30。用户确认设计稿 `reset-desktop` / `reset-phone` / `memory-tab-desktop` 与 D10–D16：两种范围都提供，“从头开始”为默认推荐；旧生命只能经命令行恢复；只归档不硬删；忙碌时允许“停止工作并重置”并如实说明；默认保留人设，可选同时恢复默认人设。

## 与既有决定的关系

- **有意推翻 ADR 0006 的一句话**：0006 规定“不引入清理、删除或重置用户数据的脚本或 API”。本 ADR 为用户本人显式发起的重置引入受控 API 与命令行，但不改变 0006 的其余约束：持久上下文、原始 History、Continuation State、队列、恢复记录和 Memory Git 的 repositoryId/checkpoint/ref/receipt/lineage 完整性约束全部保留。重置**不删除、不改写**任何已有行或 Git 对象：A 只追加 Git 提交；B 新建一个 `mira_id`，旧生命的数据库行原样保留，Memory 仓库整体移动到归档目录。
- **修订 ADR 0020 的“没有强制刷新、压缩”**：0020 规定 runtime 的冻结 Memory 快照只在初始化或成功压缩时更新。范围 A 清空记忆后，若冻结快照仍含旧记忆，下一次 Wake 开始时做**一次**压缩以发布新快照（`memory-refresh.json` 标记，按 lifeId 绑定，成功后删除）；没有更早历史可压缩时保持待定，直到下一次自然压缩。这是唯一的例外，不引入 watcher、额外 Wake 或常驻刷新。Memory 页仍只读磁盘，修改记忆仍走普通消息（0020 不变）。
- **不是 New Chat**：没有“新对话”或会话切换。Mira 仍是一个连续存在；B 是用户要求它“从头认识你”，开始的是新的连续生命，而不是并行会话。

## 决定

- **范围 A：只清空长期记忆**。在 Memory 仓库中先把未提交改动做成 `preserve` 提交，再删除所有已跟踪文件、清空 `MEMORY.md`，做 `clear` 提交（trailer `Mira-Reset-Id` / `Mira-Reset-Phase`，update-ref 比较交换，可幂等续做）。被忽略的文件不动。聊天、工作上下文、队列、定时任务、人设保留。Timeline 写入一条不唤醒的 `memory.reset` 通知：“长期记忆已清空 · 旧内容保存在 Memory Git 提交 xxxxxxx，可回退”。
- **范围 B：从头开始**（默认、推荐）。迁移 `1760000000010_mira-lives` 新增 `mira_lives`（slot/generation/reset_id/归档信息）与 `mira_active_life`（每个 slot 一个活动生命）。重置在一个可串行化事务中：按 reset_id 幂等、对活动生命做比较交换、用写入锁与 epoch 栅栏挡住旧 writer、插入新的 `mira_owners` 行（`<slot>~g<N>`）、标记旧生命归档、取消旧生命未投递的 `scheduled_deliveries`。旧生命未领取的唤醒留在原处，不会再被领取。旧 Memory 仓库移动到 `MIRA_HOME/archive/<lifeId>-<UTC 时间>/`（附 `life.json`）。人设、模型、扩展、访问密码和附件文件保留。
- **进程内重启**：两种范围都在同一进程内停止当前 `LocalWebService`（取消当前 Wake、子任务、终端和浏览器），执行重置后以活动生命重新打开。HTTP 层通过 `MiraLifeHost` 的委托 backend 保持监听；重置期间其他 API 返回 503。
- **崩溃安全日志**：`MIRA_HOME/reset-journal.json`（原子写 + fsync）记录 prepared → cleared | switched → archived。启动时先恢复日志：数据库尚未切换的 B 回滚；A 与已切换的 B 一律前滚，然后才打开服务。
- **预检 + 令牌 + 执行 + 状态**：`POST /api/memory/reset/preview {scope}` 返回影响清单（记忆文件数/字节、压缩次数、消息数、待处理唤醒/定时任务、是否忙碌、归档位置）和 2 分钟一次性令牌，令牌绑定范围、lifeId 与人设 revision。`POST /api/memory/reset {scope, token, confirm: "重置", stopRunning, resetPersona?}` 返回 202 与 resetId；忙碌而未选择停止返回 409 busy，令牌过期或情况变化返回 409 conflict。`GET /api/memory/reset/:id` 返回 stopping / archiving / starting / completed / failed。`/api/status` 增加 `lifeId`。
- **人设**：默认保留。勾选“同时恢复默认人设”时，在新生命启动后以 `savePersona(null)` 写入（仅当 revision 未变），因此新生命里会有一条人设通知。
- **界面**：设置 → Memory 页底部“重置记忆”危险区；第二层原生 `<dialog role="alertdialog">`，默认焦点在“取消”，Esc 取消；两个范围卡片（“从头开始”带“推荐”且默认选中）、影响清单（归档/清空为红色，保留为绿色）、忙碌提示、可选恢复默认人设、输入“重置”才可确认、底部显示归档位置。确认后只轮询状态，不重发。B 完成后清除本标签页属于旧生命的 sessionStorage（待确认信封、Memory 请求、已关闭错误 ID）并重新加载；其他已打开的标签页在下一次状态轮询发现 lifeId 变化时同样清理并重新加载。文案使用当前人设名字。
- **恢复**：`pnpm life list` / `pnpm life restore <lifeId>` 在服务停止时把指定旧生命设为活动生命，并把当前 Memory 仓库与归档互换；同样经过日志。网页不列出旧生命。

## 不做

不硬删除任何数据；不提供“遗忘某一条/某一段”；网页不提供旧生命列表或恢复；不清理归档目录；不中断后撤销已经开始的外部操作。

## 已知限制

- 范围 A 在“停止工作并重置”后会重启同一生命，被中断的 Wake 按既有恢复语义继续执行——对话框如实说明“清空记忆后会接着处理这个未完成的任务”。
- 旧生命的附件文件仍在共享附件目录中，不随归档移动。
- 范围 A 的冻结快照刷新依赖压缩；没有更早历史时会等到下一次自然压缩。

## 验证

- `tests/unit/memory-reset.test.mts`、`tests/unit/memory-refresh.test.mts`：Git preserve/clear 提交、幂等续做；runtime 一次性刷新。
- `tests/integration/lives.test.mts`（PostgreSQL）：迁移 up/down（存在新生命时拒绝 down）、栅栏、CAS、幂等、恢复。
- `tests/recovery/memory-reset-service.test.mts`：B 端到端（归档、取消定时任务、保留/恢复人设、新 repositoryId、CLI 往返）、忙碌/停止/过期令牌、A 的提交/通知/刷新、每一步崩溃注入后的回滚或前滚。
- `apps/web/tests/memory-reset.test.ts`：确认词、影响清单、忙碌文案、lifeId 变化时清理存储。
- `pnpm test:memory-reset:e2e`（真实浏览器 + PostgreSQL + 生产 HTTP/生命宿主）：桌面与 390px 窄屏分别执行 A 和忙碌中的 B，以及其他标签页自动刷新。
