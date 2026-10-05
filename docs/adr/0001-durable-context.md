# ADR 0001：连续上下文与恢复

状态：Accepted。用户于 2026-10-05 确认。实现与验证结果另见[验收记录](../acceptance/durable-context.md)。

## 已确认的选择

- PostgreSQL 是唯一权威，使用 `pg` 和 `node-pg-migrate`，不引入 ORM
- 每个 Mira 使用一条专用连接持有 session advisory lock；接管递增 epoch，上下文写入同时检查 version。所有受保护写入使用持锁的原连接，连接失效后执行器停止
- 外层保存 Mira 的版本化记录，payload 原样保存 Pi 结构化 JSON。只有 `runtime-pi` 解读 Pi 数据；未知版本拒绝恢复，升级须显式迁移
- Pi agent-core 执行主循环；完整压缩使用一次性的 coding-agent 内存实例。复用公开 API，不复制私有准备逻辑，不产生第二份 JSONL 历史
- 首版工具顺序执行。授权先于 intent，intent 先于副作用，outcome 增量持久化。未决结果要求核对，不自动重放
- 本批实现历史、上下文、工具记录、进程恢复和压缩。Event 与可选 Wake receipt 原子接收，但排队、合并、调度、API、UI、Memory、扩展和完整授权解析留待后续

## 边界与代价

专用连接贯穿所有权生命周期；数据库事务只覆盖短暂读写，不跨越模型调用或外部工具执行。单写者保护的是 Mira 的状态写入，不能让已经发出的外部操作撤回或获得 exactly-once 保证。连接失效与工具执行之间仍可能有不可消除的外部结果未知窗口。

Pi `beforeToolCall` / `afterToolCall` 会把异常变成工具结果，`prompt()` 也可能在内部持久化错误后 resolve。执行器必须显式停止、逐个检查模型和工具入口、检查最终状态；不能把 hook 抛错或 prompt 返回当作可靠性保证。

压缩基于权威快照生成候选，取消或 version 冲突不发布。SDK 只操作一次性内存副本；成功 checkpoint 与原始记录一起保留。压缩不维护语义记忆。

## 验证方式

模型使用确定性假 provider，不提供真实凭据、不产生模型费用。PostgreSQL 验证必须使用真实隔离数据库；本地测试计划为官方 PostgreSQL 工具、私有 Unix socket、关闭 TCP、合成数据。CI 使用官方 PostgreSQL 服务。

本次云环境已能编译 PostgreSQL 18.6，但运行时禁止 Unix socket 创建，本地多进程数据库测试因此阻塞；对应验收由 CI 的真实数据库完成后再报告结果。不能把离线模拟、SQL 单进程检查或未执行的测试算作数据库验收通过。

## 依据

- [原始设计 v0.4](../design/original-v0.4.md)
- [Pi v1.0.2](https://github.com/earendil-works/pi/tree/cd32f7725fdbddbaecdff5b1e68491563394e0ca)
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [node-pg-migrate API](https://salsita.github.io/node-pg-migrate/api)

## 声明兼容补充

用户于 2026-10-05 确认：只在 Pi 消费项目跳过声明文件内部检查，Mira 源代码保持严格检查。具体原因、配置范围与 `.d.ts` 局限见[工具链](../development/toolchain.md#pi-声明文件兼容例外)。
