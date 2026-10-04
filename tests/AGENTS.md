# Tests

共享规则见 [根 AGENTS.md](../AGENTS.md)。本文路径相对于 `tests/`。

## 入口

- `foundation/boundaries.test.mts` 是当前实际测试入口
- `foundation/toolchain.test.mts` 通过当前 pnpm 验证配置和不支持的 Node 版本被拒绝；用 `pnpm test` 运行以传入准确包管理器入口
- `integration/`、`recovery/`、`e2e/` 只有职责说明，没有已实现测试
- 根 `package.json` 的 `test` 命令显式发现 `foundation/*.test.mts`；新增其他测试目录时同步更新测试发现，不能只放入文件

## 运行与隔离

从仓库根运行 `pnpm test` 或 `pnpm check`。当前测试不需要外部服务、网络、凭据或模型。使用独立临时目录，`finally` 清理，不使用用户 Memory/State 或生产数据库。

边界规则必须有允许和拒绝反例。恢复测试覆盖中断、重启、重复事件、并发写入、过期版本和远端结果不明。不要用 mock 宣称模型、数据库或工具副作用真实可用。

引入需要 PostgreSQL/模型的测试时明确服务版本、启动命令、环境变量、费用授权、隔离策略、跳过条件和 CI 是否实际执行。不能将被跳过的测试记为通过。
