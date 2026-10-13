# @mira/life

`WakeWriter` 在已有 `DurableWriter` 之上提供持久批次消费和原子输入/最终回复关联。`WakeLoop.drain` 合并全部待唤醒请求，串行延续同一 Mira；运行中新到的请求进入下一批，事件本身不启动模型。

`createRuntime` 每轮提供新的适配器，权威始终在持久存储中。共享同一所有权 signal 的 writer（包括代理包装）的并发 drain 被拒绝，跨进程通过持久化适配器的专用连接锁保护。错误后批次仍可从数据库恢复。

可选 `beforeComplete(run, signal)` 在 Runtime 验证已保存的最终回复后、完成标记之前执行，收到重新加载的完整 run。回调失败保留活动 run；恢复再次验证最终回复并重试回调，不再调用模型或追加同一输入。回调前后均核对 writer 所有权和调用方取消。

`MemoryCheckpointWriter` 是独立的可选 `WakeWriter` 扩展，契约在 `src/memory-lifecycle.ts`。组装层按 `prepareMemoryCheckpoint` → Memory Git 幂等快照 → `finishMemoryCheckpoint` → Wake 完成执行。待处理 checkpoint 与最终 `commit | null` receipt 各自不可变；`null` 表示已确认无变化，缺少 receipt 才表示仍待恢复。恢复 payload 只保存适配器输入，不把 Memory 内容再存成第二份数据库权威。`preparedAt` 是意图时间，不是文件捕获时间。观察到的快照变更不等于全部由该 Wake 或 agent 创作，不能虚构逐文件来源。

PostgreSQL 与 Git 不能原子提交。Git 适配器须按 Mira/run 保存可恢复的确定结果，receipt 写入失败后才能重取同一结果，而不捕获后来文件变化或产生第二个提交；已有待处理 checkpoint 时持久化适配器禁止先完成 Wake。

`src/history.ts` 的 `HistoryReader` 契约提供固定 Mira 范围的只读历史搜索、时间顺序分页与精确读取；原始 Event、Runtime envelope、工具 intent/outcome 和 Wake 关联保持分离。分页只返回原始记录引用及时间，不返回 payload 或创建第二份消息库；最新一页按时间升序展示，使用绑定 Mira/种类的 opaque before cursor 继续读取旧页。检索不启动认知，不修改 Memory，原始 Runtime payload 仍由对应 Runtime 解读。

`renderWakeBatch` 使用精简文本，而非完整 Event/Wake 请求信封 JSON。普通 Web 消息（`source=user`、`type=web.message`、仅 `{text}`、固定本地 Web 原因）仅附来源与原始时间，正文不转义、不裁剪。其它用户事件保留类型、原因、事件 ID；有额外字段或非用户来源的 payload 完整保留为 JSON，不只摘取 `text`。合并批次仍包含所有请求，外部内容不构成用户授权。

超过 `maxInlineBytes`（默认 65,536）的同一精简输入通过 `writeOverflowInput` 写成普通文本，模型获得路径和概要，按需用普通文件工具读取。阈值按 UTF-8 字节计算，不拆成多轮。相同版本恢复前从不可变批次重建丢失文件，字节和路径不变；已有文件内容冲突仍失败且不覆盖。文件不自动删除。没有消息优先级、专用分页服务或心理状态机。

旧版已持久化输入/overflow、尚未生成 final 的活动 Wake 不承诺跨这次布局修改恢复：运行时会拒绝与已存输入不一致的渲染，普通文件也拒绝同一 run 的内容变化。未加入兼容解析、迁移或数据重置；发布前处理方式见 [升级注意](../../docs/development/local-web.md#wake-输入布局升级注意)。

接口见 `src/index.ts` 和 `src/loop.ts`，语义见 [ADR 0002](../../docs/adr/0002-coalesced-wake-loop.md)。验证为根目录 `pnpm check` 及 `pnpm check:all`。

`DurableOperationError` 是无数据库/Pi 依赖的小型错误标签，用私有实例字段识别 event-content-conflict 与 persistence-write-failure；普通无类别错误仍可保留原有语义。标签不是外部工具 outcome，也不创建新记录。恢复诊断由 Runtime 的现有 observation 承载，见 [ADR 0015](../../docs/adr/0015-safe-tool-recovery-diagnostics.md)。

History references use one global canonical UUID across events, context, tools and Wake runs. `HistoryReader.read({id})` returns kind with the original. `WakeRequest.eventId` is the event History UUID; nested `event.id` and `wake.id` keep their external/idempotency meanings. Non-Web input labels both distinctly; the ordinary Web text header stays concise.

`RunHistoryReader` optionally extends the read-only history contract for management projections. `findEventRun(externalEventId)` resolves a source receipt to its exact event History UUID and claimed Wake, if any. `readRun({id,before?,limit?})` joins existing immutable membership and Memory checkpoint/receipt metadata, plus paginated context/tool references within the Wake's durable version interval. It does not interpret runtime payloads, create a second log, or mutate the writer. A missing checkpoint, pending receipt, and `commit: null` no-change receipt remain distinct.
