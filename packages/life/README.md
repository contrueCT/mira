# @mira/life

`WakeWriter` 在已有 `DurableWriter` 之上提供持久批次消费和原子输入/最终回复关联。`WakeLoop.drain` 合并全部待唤醒请求，串行延续同一 Mira；运行中新到的请求进入下一批，事件本身不启动模型。

`createRuntime` 每轮提供新的适配器，权威始终在持久存储中。共享同一所有权 signal 的 writer（包括代理包装）的并发 drain 被拒绝，跨进程通过持久化适配器的专用连接锁保护。错误后批次仍可从数据库恢复。

超过 `maxInlineBytes`（默认 65,536）的完整输入通过 `writeOverflowInput` 写成普通文本，模型获得路径和概要，按需用普通文件工具读取。文件不自动删除。没有消息优先级、专用分页服务或心理状态机。

接口见 `src/index.ts` 和 `src/loop.ts`，语义见 [ADR 0002](../../docs/adr/0002-coalesced-wake-loop.md)。验证为根目录 `pnpm check` 及 `pnpm check:all`。
