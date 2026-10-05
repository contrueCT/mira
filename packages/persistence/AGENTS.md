# Persistence 适配

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则不能放宽授权、安全或架构限制。

## 入口与状态

- `src/index.ts` 实现核心 `DurableWriter` / `WakeWriter`，含合并 claim、原子输入/终止记录关联和完成；`src/migrate.ts` 提供显式 up/down
- `pg` 8.23.1、`node-pg-migrate` 9.0.0，无 ORM；`migrations/*.sql` 为迁移事实来源
- 语义、限制和示例见 `README.md`；公开出口以 `package.json` 为准

## 本地约束与跨包陷阱

- 只实现核心拥有的契约，不向核心泄漏 PostgreSQL/Pi 类型，不解释 Runtime payload
- 每个 Mira 的 writer 使用独占连接、session advisory lock 和 epoch；所有写事务必须在同一连接验证实际锁与 epoch
- registry 初始登记使用独立全局 session lock；lock key 由表唯一生成，禁止哈希碰撞或重复使用
- 连接丢失必须永久停止该 writer 并中止 signal；禁止在旧 writer 内透明重连
- append-only 历史、parent 链、版本 CAS 与工具首次 outcome 不可放宽
- 事务内不执行模型或外部工具；外部结果不明必须保留核对状态，不自动重试
- 事件与可选 Wake 原子落库；无 Wake 的事件不得启动推理；重复 ID 必须核对全部记录
- claim 全部积累请求为一批，运行中新到请求留下一批；关联不可变、每 Mira 仅一个活动 run
- 输入/终止回复与 run 关联同事务，最终回复后先完成再追加；Pi 语义由 Runtime 核对
- SQL 迁移必须同时支持 up/down；down 有数据丢失风险，不得自动用于用户库

## 验证

从根目录运行 `pnpm check`。真实集成运行 `MIRA_TEST_DATABASE_URL=postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test pnpm test:integration`。测试仅接受显式 localhost `mira_test`，按唯一 schema 隔离与清理，禁止默认连接用户数据或生产库。CI PostgreSQL 18.6；未连通、跳过和实际通过必须区分。依赖或 exports 改动同步根边界规则和反例。
