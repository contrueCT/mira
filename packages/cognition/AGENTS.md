# Cognition 契约

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 导出最小 CognitionRuntime/CognitionTurn；Pi 与数据库类型不进入契约。
- 本目录负责核心拥有的 Runtime 接口与规范化可持久化消息。

## 本地约束与跨包陷阱

- 不把 Pi 的 SDK 类型直接变成核心公开接口
- 明确消息版本、供应商必要字段与可恢复性，不能只保存渲染后文本
- Runtime 适配器实现本包契约；不在此包处理数据库、Wake 调度或授权绕过

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。执行验收由 life 离线循环测试及 runtime-pi 恢复测试覆盖。
