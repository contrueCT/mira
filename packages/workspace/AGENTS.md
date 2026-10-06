# 文件工作空间

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 保留 `writeWakeInput` 普通溢出文本接口；`src/memory.ts` 实现 `setupMemoryWorkspace`、`loadMemoryBootstrap` 与 `snapshotMemory`
- 只强制 `MEMORY.md`；其余 Memory 是自由组织的普通文件；只维护当前 Memory-only 设计，不提供 State 配置或迁移兼容层
- 只在首次上下文初始化读取 `MEMORY.md`；不实现变更通知、自动回注、autoWake 或固定 taxonomy/FSM
- 测试使用源码及 HOME 外的独立临时目录，测试夹具结束后清理；生产写入函数不自动删除文件

## 本地约束与跨包陷阱

- 数据 Git 与源码 Git 必须分离，禁止把用户记忆或凭据提交到此仓库
- 保留普通文件读写语义，不重新包装 memory.read/write/search
- 路径穿越、符号链接、并发变更及崩溃中断必须测试
- PostgreSQL 保持事件及批次成员权威；临时文件消失可按稳定 run ID 和完整规范内容重建，同 ID 内容冲突必须保留旧文件并报错
- 不截断溢出正文、不拆成多次 Wake；路径、数量及来源概览由核心渲染，普通文件读取由 Runtime 提供
- 发布使用私有临时文件、同步和原子目录重命名；不能改成会覆盖已发布文件的直接文件重命名
- 不监控文件变化，也不为文件变化自动重建上下文；新决定覆盖原始设计的通知设想。快照与 lineage 不污染记忆正文
- Memory 快照包含当前普通工作树差异，也包括 Wake 前已有改动；不能把这些差异描述成 agent 作者证据
- `.git` 注册保存稳定随机仓库身份；待完成 checkpoint 必须持久化该身份并在快照恢复时校验，防止 Git 丢失或替换后把新内容归入旧运行
- 同 Mira/run 的 Git 回执可恢复变更与无变更结果；HEAD/trailer 恢复须校验完整身份；回执先落盘时只从精确父 HEAD 做 CAS 补齐，历史分叉报错。Git 与 PostgreSQL 分开提交，不宣称跨系统原子性
- 普通 Git index 与工作树语义保持一致；宿主单写者负责串行，保留外部锁并真实呈现 Git 错误/取消。目录分离不是 shell 工作目录沙箱

## 验证

从仓库根运行 `pnpm check`。`tests/unit/wake-spool.test.mts` 覆盖溢出输入、恢复、并发、冲突及路径安全；`tests/unit/memory-workspace.test.mts` 覆盖 Memory-only、bootstrap、Git 快照与失败恢复，无服务或模型调用。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例；本包不依赖其他 Mira 包或第三方库。
