# ADR 0024：运行中的用户插话与单工具边界

状态：Accepted，2026-10-14。用户批准保留当前工具执行，等这一个工具返回后插入新消息，不等整批工具或整轮结束；长工具仍会带来延迟。主模型看到新消息后判断是否停止、继续或改变方向。本文更新 ADR 0016 的安全工具边界描述，不改变未知结果、完整公开 Pi SDK 压缩与附件显式读取约束。

## 用户与运行语义

- Web 继续使用普通发送入口，无停止/暂停按钮、关键词裁判、外置意图判断或暂停队列。HTTP receipt 表示消息已持久接收，不表示主模型已经读到。
- 新 Web 用户消息先持久保存完整 Event/Wake 与附件次序。已有非终态 Wake 时关联该 Wake 的补充输入；没有活动 Wake 或 final 已提交时留给下一批。普通 `receive`、外部来源与 Dreaming 行为不变。
- 原始 Wake 的请求集合、输入文本和 input link 永远冻结。补充输入用独立 append-only 关联保存归属和消费 record link，按数据库 receipt order 消费，与来源时间无关。可重建的大输入文件使用每条补充 Event 的独立 History UUID。
- 模型正在生成时，新输入的提交通知使当前模型请求让出，丢弃未提交的旧 completion，重新从权威历史请求模型；不是向既有 HTTP 请求插入 token。通知只是提示，持久 pending 查询弥补注册时差与重启。
- 工具的 intent 已提交即进入当前单工具边界，工具不因插话取消。其真实 outcome 和 transcript 完整落库后，新消息先进入模型。每个后续工具 intent 在同一 fenced 事务检查 pending 输入，旧批次剩余调用不能抢先开始。
- 未启动 siblings 由原有 recovery observation 如实标记 not-started；已知结果原样恢复，unknown 不伪造失败、不自动重放。只有主模型在新上下文里明确选出的新调用可执行。

## 持久化与恢复

`LiveInputWriter` 是 WakeWriter 的附加能力。`receiveLiveInput` 原子保存 Event/Wake、既有 run membership 及 `wake_live_inputs`；重复 HTTP 核对完整内容，不重新归属、不重复插入、不触发第二次通知。普通 API 形状没有改变。

`appendLiveInput` 使用同一独占 writer、epoch 与 context CAS，一次提交正文及消费关联，核对 receipt 顺序并保留幂等证据。`tryBeginWakeTool` 原子仲裁 pending 输入与下一工具开始；`tryAppendWakeFinal` 原子仲裁 pending 输入与终态提交。输入先赢时 final 不发布，模型重读；final 先赢时新消息进入下一 Wake，不能追加到已冻结终态。原始记录不重写，不引入第二主认知写者。

重启先恢复已知 outcome/未知事实与合法工具配对，再校验已消费输入正文、附件顺序及链接，并消费 pending 输入，之后才发自然模型请求。服务关闭、writer 丢失和真实持久化失败仍终止运行；插话使用单次 attempt 的让出状态，不污染生命周期 AbortController。当前工具的 signal 只受正常服务关闭/所有权丢失影响。

## 压缩、附件与范围

压缩仍在安全请求边界通过公开 SDK 完成；旧批次若被插话截断，先以真实 not-started observation 收束合法投影。摘要期间新输入留在持久队列，不修改冻结摘要候选或 Memory；checkpoint 原子提交后、下一自然请求前消费新输入。不会把用户插话伪装成摘要失败或服务故障。

补充输入沿用普通 Wake 渲染、不可变附件元数据、请求局部图片 hydration 与 overflow 文件。视频仍必须模型显式 read，不能因为运行中插入而宣称已经看过视频；PDF/Word 仍使用普通文件引用。

不升级 Pi 1.0.2，不复制或 fork 其 agent loop。Pi 原生 steer 在整批工具之后才读队列，因此这里使用公开 Agent abort、现有 awaited hooks、执行 latch 与 durable attempt 恢复，实现在每个单工具之前的边界。没有新的模型/授权引擎、永久 Pi session 或 UI 控制面。

## 验证边界

- `tests/unit/live-input.test.mts`：受控真实 Pi stream/工具门闩，生成中插入、首工具后插入、首工具前竞争、duplicate、final 竞争、unknown 恢复、附件顺序与摘要期间插入。
- `tests/recovery/live-input.test.mts` / worker：真实 PostgreSQL receipt/顺序/CAS/final 仲裁，独立进程在 receipt、消费记录、已知 outcome 和未知 effect 边界退出，检查重启先读新输入与不重复副作用。
- `pnpm test:live-input:e2e`：真实浏览器、HTTP、PG、runtime 和实际 bash 门闩；普通发送、请求取消、单工具结果、旧 sibling 未执行、duplicate、重启及桌面/窄屏截图。仅 provider 返回受控，无真实模型 API 费用。

真实数据库与浏览器必须在 CI 执行；本地未启动服务或 socket 限制不能算通过。具体通过/失败以确切 commit 的 CI 和验收记录为准。
