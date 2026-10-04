# Web 界面

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- 只有 README.md 与 package.json，尚无界面或启动入口。
- 本目录负责Timeline、Memory、Extensions、Settings；Web 框架尚未选定。

## 本地约束与跨包陷阱

- 不增加 New Chat、会话列表或每次 Wake 创建新人物的产品概念
- Life Timeline 与 Runtime Trace 分开；内部工具诊断不直接当作人生事件
- 修改 UI 后覆盖返回、取消、重复点击和中断恢复，并检查加载/空态/错误态

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。当前没有此包专属测试或启动命令；实现时同时补充真实命令与适用验收，不能填入未实现命令。
