# Extension SDK

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- exports 为空，不声称已有可开发扩展的 API。
- 本目录负责扩展唯一的 Mira 公共契约入口。

## 本地约束与跨包陷阱

- 保持平台独立，不导入核心内部、Pi、Cordis、数据库或 Node 平台模块
- 只暴露注册工具、事件、Wake 等批准能力；不得暴露直接改历史/上下文的通道
- 新增公共 export 需兼容性考虑及消费者测试，避免映射整个内部类型树

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。当前没有此包专属测试或启动命令；实现时同时补充真实命令与适用验收，不能填入未实现命令。
