# 文件工作空间

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 仅实现 `writeWakeInput`，将调用方提供的完整合并 Wake 输入写为可重建普通文本；不提供专用读取/分段 API
- Memory/State、文件工具、Git 快照和变更通知尚未实现，不借本批扩展为通用工作空间子系统
- 测试使用源码及 HOME 外的独立临时目录，测试夹具结束后清理；生产写入函数不自动删除文件

## 本地约束与跨包陷阱

- 数据 Git 与源码 Git 必须分离，禁止把用户记忆或凭据提交到此仓库
- 保留普通文件读写语义，不重新包装 memory.read/write/search
- 路径穿越、符号链接、并发变更及崩溃中断必须测试
- PostgreSQL 保持事件及批次成员权威；临时文件消失可按稳定 run ID 和完整规范内容重建，同 ID 内容冲突必须保留旧文件并报错
- 不截断溢出正文、不拆成多次 Wake；路径、数量及来源概览由核心渲染，普通文件读取由 Runtime 提供
- 发布使用私有临时文件、同步和原子目录重命名；不能改成会覆盖已发布文件的直接文件重命名
- 文件变化不能静默脱离已有 Working Context；快照与 lineage 不污染记忆正文

## 验证

从仓库根运行 `pnpm check`。`tests/unit/wake-spool.test.mts` 覆盖此包完整输入、恢复、并发、冲突及路径安全，无服务或模型调用。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例；本包不依赖其他 Mira 包或第三方库。
