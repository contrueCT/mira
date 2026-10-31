# Persistence 适配

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则不能放宽授权、安全或架构限制。

## 入口与状态

- `src/index.ts` 实现核心 `DurableWriter` / `WakeWriter` / `SchedulingWriter`，含合并 claim、原子输入/终止记录关联和完成；`src/migrate.ts` 提供显式 up/down
- `MemoryCheckpointWriter` 以分开的不可变 pending checkpoint 和 Git `commit | null` receipt 支持恢复；存在 pending 时必须先关联 receipt 再完成 Wake，不能把 Git 放进数据库事务
- `pg` 8.23.1、`node-pg-migrate` 9.0.0，无 ORM；`migrations/*.sql` 为迁移事实来源
- 语义、限制和示例见 `README.md`；公开出口以 `package.json` 为准

## 本地约束与跨包陷阱

- 只实现核心拥有的契约，不向核心泄漏 PostgreSQL/Pi 类型，不解释 Runtime payload
- 每个 Mira 的 writer 使用独占连接、session advisory lock 和 epoch；所有写事务必须在同一连接验证实际锁与 epoch
- registry 初始登记使用独立全局 session lock；lock key 由表唯一生成，禁止哈希碰撞或重复使用
- 连接丢失必须永久停止该 writer 并中止 signal；禁止在旧 writer 内透明重连
- `history_records` 的 UUID 主键拥有全局跨类型/Mira 身份；详情固定类型外键、身份预留与详情同事务。事件/provider ID 是独立去重/协议字段，不能替换为 History ID
- 当前初始 schema 用于新空库；不添加旧库检测、映射、兼容层或自动清理，见 ADR 0012
- append-only 历史、parent 链、版本 CAS 与工具首次 outcome 不可放宽
- intent 保留原始/验证参数与 assistantRecordId，工具行 context version 保留来源；不保存合成授权决策，不因移除 JSON 字段添加迁移或改写历史
- finishTool 仅在当前 context version 等于该 intent 的 beginTool version 时写入；先保存 outcome 再追加工具结果。上下文推进后的迟到 outcome 拒绝且不修改证据，不把这个完整性边界用作新调用的风险或授权判定
- 事务内不执行模型或外部工具；外部结果不明必须保留核对状态，不自动重试
- PersistenceError 保留 name/code/两参数 API；仅 receive 的 identity/content 冲突给可信标签。普通 invalid/version/duplicate 不冒充写入故障；实际 stopped writer/未知事务故障标记致命类别，不新增诊断表或解释 Pi payload
- 事件与可选 Wake 原子落库；无 Wake 的事件不得启动推理；重复 ID 必须核对全部记录
- claim 全部积累请求为一批，普通运行中新到请求留下一批；显式 receiveLiveInput 通过独立补充表归属非终态活动 run、原始请求不变（ADR 0024）；持久 child 终态通过内部同事务入口复用补充队列（ADR 0037），公开入口仍仅 user；关联不可变、每 Mira 仅一个活动 run
- 输入/终止回复与 run 关联同事务，最终回复后先完成再追加；Pi 语义由 Runtime 核对
- child 的 TaskInputWriter 使用独立 stream/CAS 与持久 input/final links；parent send 与 child input/tool-start/final 同锁 subagents 行，已接收且未 final 的 queued/running task 接收有序 inbox，final 后保留 queued turn。subagent_calls 统一调用去重与管理关联；取消/失败/重启终止未消费输入并保留证据，不使用主 Wake 表或自动重放。普通 checkpoint 保留独立提交边界，不在 child 锁内等待 parent RPC
- Dreaming 的初始化基线、空闲时间和消费游标持久化；条件检查、普通 Event/Wake 与触发基线同一 fenced 事务。只数已提交 checkpoint，来源时间不用于空闲，不新增语义状态或自动失败重试。
- 单次日程以 Mira/owner/key 唯一；pending 的 replace/cancel 用版本 CAS，入队与普通 Event/Wake 同一 fenced 事务。只处理组装层提供的当前有效 owner，不解释时区/重复规则、不建立独立租约。终态保留，cancel 不撤销已入队记录。
- `RunHistoryReader` 只连接既有 Event/Wake/Memory receipt 与版本区间内记录引用；不新增日志/表或解释 Runtime payload，cursor 绑定 Mira 和 Wake。
- SQL 迁移必须同时支持 up/down；down 有数据丢失风险，不得自动用于用户库

## 验证

从根目录运行 `pnpm check`。真实集成运行 `MIRA_TEST_DATABASE_URL=postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test pnpm test:integration`。测试仅接受显式 localhost `mira_test`，按唯一 schema 隔离与清理，禁止默认连接用户数据或生产库。CI PostgreSQL 18.6；未连通、跳过和实际通过必须区分。依赖或 exports 改动同步根边界规则和反例。
- `mira_lives` / `mira_active_life`（ADR 0047）：生命切换只走 `PostgresLives.startNewLife` / `restoreLife`（可串行化事务、CAS、写入锁栅栏、按 reset_id 幂等）；不得删除或改写旧生命的行。
- `usage.ts`（ADR 0048）：只读聚合，路径由调用方的 `UsageProjection` 提供，本包不解释 Runtime 载荷；新增来源或字段先改 `@mira/life` 契约。
- 后台作业（ADR 0049）：`pendingBackgroundJobs()` 依赖迁移 012 的部分索引，结果事件 ID 由 jobId 推导；`findEventReceipt`（ADR 0050）只读。
