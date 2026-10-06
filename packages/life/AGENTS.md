# Life 核心

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 定义 Event/Wake receipt、工具 intent/outcome 与 DurableWriter 契约。`src/loop.ts` 实现持久批次的串行 drain；全部积累 Wake 合并一轮，新增 Wake 留到下一轮。
- `src/memory-lifecycle.ts` 定义可选 Memory checkpoint/receipt 扩展；`beforeComplete` 在已验证 final 后执行，失败后保持原 run 恢复，不重调模型。PG/Git 不宣称原子事务。
- 本目录负责事件、Wake 队列与唯一主认知循环。

## 本地约束与跨包陷阱

- 禁止导入 Pi、Cordis、数据库、Web 框架或 Node 平台模块
- Life Event 不等于 Wake；先持久化事实，再明确请求认知
- 跨进程单写者、版本冲突、增量工具持久化和结果不明的恢复都必须测试
- 外部结果不明真实告知模型，不自动重放；模型可依用户意图决定查询、提问或重试，不设置风险硬门禁
- 超限输入写普通文本文件并提供路径，不拆成逐消息轮次，不新增专用读取服务

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。契约测试见 `tests/unit/`，真实写入与恢复验收见 `tests/integration/`、`tests/recovery/`。
