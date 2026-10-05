# packages/workspace

仓库外普通文件与 Memory Git 快照适配器。不构建专用 Memory 读写 API、固定分类、状态机、文件变更通知、自动上下文回注或自动唤醒。

## Memory / State 配置

`setupMemoryWorkspace({ memoryRoot, stateRoot, sourceDirectory, signal? })` 验证并返回规范化的绝对路径及稳定随机 `repositoryId`，后者只保存在 `.git` 注册文件。Memory、State 与源码目录必须互不包含；符号链接别名按真实路径检查。Memory 使用根目录自己的 `.git`，不能借用源码仓库或 linked worktree；State 必须位于 Git 仓库之外，不初始化 Git。

只在缺失时创建空白 `memoryRoot/MEMORY.md`。其余文件和目录由 Mira 用普通文件工具自行组织，不创建 Memory README、预设 taxonomy 或 State 文件。已有正文原样保留。这些约束只保证数据存储分离，不限制通用 shell 的工作目录、读写范围或命令能力。

`loadMemoryBootstrap({ memoryRoot, stateRoot, stateFiles?, signal? })` 返回 `{ memory: { path, content }, state: [{ path, content }] }`。它只读取 `MEMORY.md` 和显式配置的 State 相对路径，允许嵌套普通文件；不扫描目录、不推断 State 文档、不自动创建缺失文件。配置文件缺失时报错。此函数由 runtime 仅在真正首次初始化上下文时调用，正常 Wake、恢复、压缩与文件变化均不重新读取或回注。

## Wake 末尾 Memory 快照

`snapshotMemory({ memoryRoot, miraId, runId, expectedRepositoryId?, signal? })` 返回 `{ miraId, runId, commitId, changed, recovered, changedPaths }`。需要先完成上述 setup。采用普通 `git add -A`、`write-tree`、`commit-tree`、`update-ref`，遵循 `.gitignore`，支持增加、修改与删除。它操作数据仓库的正常 index，因此会把已有暂存状态更新为当前工作树；运行由调用方单写者串行化。Git 命令通过 `execFile` 执行，不使用 shell 拼接，不运行 hooks，不访问远端，不使用全局 Git 配置。

- 只有树内容变化才创建提交；State 改动不产生 Memory 提交
- `changedPaths` 只是相对上一 Git 版本观察到的差异，包括 Wake 前已存在的人工作业，不声称变更由 agent 创作
- 每个 Mira/run 键的技术回执位于 `.git` 的 `refs/mira/wake-snapshots/<SHA256>`；变更回执指向提交，无变更回执指向树，`commitId` 为 `null`
- 重试先恢复同键回执，因此后来的编辑不会被误归给原运行；变更提交包含编码后的 Mira/run trailer，不在 Memory 或 State 正文插入来源字段
- HEAD 与回执使用带旧值检查的 Git ref transaction 发布。Git 多 ref 文件不提供跨断电原子性；HEAD 已持久化而回执缺失时，校验完整身份 trailer 后恢复该提交的回执；回执先持久化时，只在 HEAD 仍恰好为该提交的父提交（首提交对应 unborn HEAD）时以 CAS 补齐 HEAD。已有后续历史且包含此提交时保持不动，其余分叉证据报错，不强制覆盖 HEAD
- 调用方把 setup 返回的 `repositoryId` 一起保存进待完成数据库 checkpoint，恢复时传回 `expectedRepositoryId`。如果 `.git` 丢失后重建或替换，注册身份改变，快照在读取运行回执或暂存新内容前拒绝继续，不能把后来的内容冒充旧运行的快照
- PostgreSQL lineage 由调用方另行关联；Git 成功不等于数据库成功，不声称二者原子提交。同一键重试用于恢复 Git 完成、数据库关联未完成的情况
- 普通文件逐个进入 Git index，不是整个文件系统的原子快照。并发外部修改、Git 锁、权限、损坏或取消等错误真实上抛，不假装成功，不自动移除他人的锁

技术注册信息和回执只在 `.git`，没有额外记忆正文、固定 State 架构、文件 watcher 或自动唤醒。Git 是 Memory 历史；PostgreSQL 是运行与 lineage 权威。State 不保留版本历史。

## 超限 Wake 输入

另导出 `writeWakeInput({ rootDirectory, sourceDirectory, runId, content })`，返回普通 UTF-8 文本文件的 `{ path, bytes }`。`content` 是调用方从 PostgreSQL 规范记录序列化的完整合并 Wake 输入；本包不筛选事件、不截断内容、不决定批次成员，也不保存第二份权威运行状态。

### 使用与恢复

- `rootDirectory` 与 `sourceDirectory` 必须显式配置为绝对路径；文件根目录必须在源码和用户 HOME 之外，由当前用户独占（目录 `0700`）
- 同一稳定 `runId` 对应同一路径，完整内容保存在 `SHA256(runId)/batch.txt`，普通文件工具即可读取；没有专用读取、分段、分页或 Memory API
- 模型内联预算、路径/数量/来源提示由调用方处理；预算溢出不在这里拆分 Wake 或丢弃正文
- 每次恢复都从 PostgreSQL 重新提供相同 `runId` 与完整内容；文件缺失时重建，现存相同内容直接复用
- 现存内容不同、路径符号链接、硬链接或非私有目录会拒绝操作，保留旧内容；文件内容不会被静默覆盖或“修复”

### 发布与安全边界

先以排他方式写入私有临时目录中的文件，设置 `0400` 并同步，再重命名文件和整个临时目录。已发布目录非空，目录重命名不能覆盖其中的旧输入；并发请求只允许复用字节完全相同的文件。根目录每个路径组件均检查符号链接和其他用户写权限，运行 ID 只参与哈希，不直接成为路径。

这是宿主进程的受控文件写入，不是隔离同 UID 任意恶意代码的安全沙箱。使用支持 `O_NOFOLLOW`、目录同步与原子重命名的本地文件系统。不得把它暴露为模型任意写文件接口。内容必须是有效 Unicode，避免 UTF-8 编码替换不完整代理项；常规 JSON 序列化满足此要求。

没有自动清理。已读、未读和旧运行文件全部保留；进程中断或并发竞争留下的 `.pending-*` 临时目录也不会自动删除。清理策略需另行决定，不能因下一次 Wake 启动就删除旧输入。

## 验证

从仓库根运行 `pnpm check`。`tests/unit/wake-spool.test.mts` 覆盖完整溢出输入、普通文件读取、重启/缺失重建、并发不可变发布、冲突保留、路径/链接防护和不自动清理。`tests/unit/memory-workspace.test.mts` 覆盖独立 Memory/State 配置、限定 bootstrap、Git 差异与无变更回执、重启恢复、身份范围、异常文件名、路径分离、锁失败和取消。均为独立临时目录离线测试，无数据库或模型调用。
