# Tests

共享规则见 [根 AGENTS.md](../AGENTS.md)。本文路径相对于 `tests/`。

## 入口

- `foundation/design-sources.test.mts` 锁定三份新原文和 v0.4 存档的字节数/SHA-256，核对来源 manifest
- `foundation/boundaries.test.mts` 是当前实际测试入口
- `foundation/toolchain.test.mts` 通过当前 pnpm 验证配置和不支持的 Node 版本被拒绝；用 `pnpm test` 运行以传入准确包管理器入口
- `unit/model-connections.test.mts` 与 `unit/model-discovery.test.mts` 使用真实 Pi adapter + 注入 fetch／合成 SSE 验证协议与发现，绝不执行 live 模型调用
- `unit/` 为核心/离线运行时测试；`integration/` 与 `recovery/` 为真实数据库/进程测试；`e2e/` 仍是占位
- `scripts/run-tests.mts` 显式发现对应目录的 `*.test.mts`，剥离凭据并设置临时 HOME；新增目录要同步测试发现

## 运行与隔离

从仓库根运行 `pnpm test` 或 `pnpm check`。离线测试不需要服务或模型；`pnpm test:integration` 必须配置本地独立 `mira_test` PostgreSQL。CI 通过 `pnpm check:all` 跑真实数据库。使用独立临时目录，`finally` 清理，不使用用户 Memory 或生产数据库。

Prompt 测试检查原始模板 hash、单次转义、实际请求上下文、当前上下文追加更新与恢复/压缩、能力更新同代一致、静默 Wake，以及 Memory 冻结快照不重读。

ADR 0007 回归直接工具调用与模型普通澄清，保留 schema/参数、intent 先于执行、来源/去重/恢复/CAS 边界；不重新引入 authorize stub、合成批准证据或额外授权模型调用。

边界规则必须有允许和拒绝反例。恢复测试覆盖中断、重启、重复事件、并发写入、过期版本和远端结果不明。不要用 mock 宣称模型、数据库或工具副作用真实可用。

引入需要 PostgreSQL/模型的测试时明确服务版本、启动命令、环境变量、费用授权、隔离策略、跳过条件和 CI 是否实际执行。不能将被跳过的测试记为通过。
