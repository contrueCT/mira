# 文件工作空间

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- 尚无文件工具或 Git 快照实现。使用临时独立目录测试，结束后清理。
- 本目录负责源码仓库外的 Memory/State、Git 快照和变更通知。

## 本地约束与跨包陷阱

- 数据 Git 与源码 Git 必须分离，禁止把用户记忆或凭据提交到此仓库
- 保留普通文件读写语义，不重新包装 memory.read/write/search
- 路径穿越、符号链接、并发变更及崩溃中断必须测试
- 文件变化不能静默脱离已有 Working Context；快照与 lineage 不污染记忆正文

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。当前没有此包专属测试或启动命令；实现时同时补充真实命令与适用验收，不能填入未实现命令。
