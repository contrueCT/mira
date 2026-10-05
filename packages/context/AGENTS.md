# Working Context

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 定义版本化 JSON envelope、快照与纯 JSON 校验；不解释 Pi payload。
- 本目录负责连续上下文、版本与时间提示渲染。

## 本地约束与跨包陷阱

- 禁止导入 Pi、Cordis、数据库、Web 框架或 Node 平台模块
- Wake 结束不清空上下文；保留原始消息和合法工具调用/结果结构
- 只保存绝对时间等事实；elapsed time 和跨日提示由渲染推导
- 压缩与长期语义记忆分开，不在本包实现压缩算法或心理状态机

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。契约测试见 `tests/unit/`，真实写入与恢复验收见 `tests/integration/`、`tests/recovery/`。
