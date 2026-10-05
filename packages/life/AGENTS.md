# Life 核心

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 定义 Event/Wake receipt、工具 intent/outcome 与 DurableWriter 契约。调度/合并/队列尚未实现。
- 本目录负责事件、Wake 队列与唯一主认知循环。

## 本地约束与跨包陷阱

- 禁止导入 Pi、Cordis、数据库、Web 框架或 Node 平台模块
- Life Event 不等于 Wake；先持久化事实，再明确请求认知
- 跨进程单写者、版本冲突、增量工具持久化和结果不明的恢复都必须测试
- 副作用结果不明时禁止盲目重试；outbox 本身不提供外部 exactly-once

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。契约测试见 `tests/unit/`，真实写入与恢复验收见 `tests/integration/`、`tests/recovery/`。
