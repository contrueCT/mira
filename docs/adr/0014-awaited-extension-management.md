# ADR 0014：扩展管理直接等待应用

状态：Accepted，2026-10-07。用户确认参照 DSH 的管理操作，让工具等待实际应用结果，替换 ADR 0004/0005 的 accepted 队列与整批资源租约。没有旧模式或兼容开关。

## 原因与上游对照

DSH 官方 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` 的
[plugin_manager](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/src/tools.ts)
等待 manager 操作返回；[manager](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/src/index.ts)
在 live profile 等待 reload，返回 application 与 warnings。其
[agent-loop](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/agent-loop/src/tool-calls.ts)
在启动尚未执行的调用前重新检查实时工具状态。

Pi 支持等待异步 execute，Mira 已明确配置串行工具执行。原先的限制来自 Mira 自己的整批 lease：管理调用若等待卸载，disposer 又等待当前批次结束，会自锁。返回 accepted 避开自锁，却把完成检查推给下一批，也容易被误解为等待下一条用户消息。

## 当前契约

- requestChange 统一串行等待配置保存、旧代清理与新代应用，返回 applied/failed、persistence 和该次操作完成时的 runtime 快照；非法请求由工具呈现 rejected
- 配置保存会让出执行，因此保存后再次排空 Loader 已开始的生命周期任务；最后一次空任务检查与 runtime 变更同步衔接，避免 HMR 按旧 fiber/config 重建刚停用或重配的实例。只使用公开 Loader API，不修改 Cordis 私有方法
- receipt 和 runtime 在同一管理串行边界内捕获；日志保存的是当次结果，之后的管理/HMR 或重启仍可能改变当前状态
- 仅实际执行的扩展工具保护本 activation 的资源，管理工具不持有这种租约。进入卸载后拒绝新的旧代执行，已开始的执行释放后才清理资源
- 同一模型响应后面的调用仍按原声明校验参数。如果 activation 已被移除或替换，返回明确 stale、executed:false 的普通错误工具结果；不执行已清理闭包，不偷偷换同名新代码，不把未执行伪称结果不明
- 下一自然模型请求仍经 Pi prepare hook 获取完整新声明；不额外调用模型，不等待用户消息，也不重新打开已完成 Wake
- 对保存、应用、依赖 waiting、清理失败分别报告真实结果。saved 不代表 active；active 不代表未来定时任务已经发生
- durable intent 在 effect 前、不可变 outcome、writer fencing、未知副作用恢复和自然语言执行判断不变；不新增审批门禁

DSH 的 profile bundles、审批机制和配置格式不移植。Mira 保留独立 extension SDK、disabled install、内容绑定版本、非原子保存/apply 与显式 rollback。

## 验证边界

离线测试覆盖同请求 install/activate/inspect/invoke/disable、同批旧 activation 的明确拒绝、reload/remove/configure、实际在途调用与依赖资源清理。真实 PostgreSQL 与 Chromium 仍由 exact-head CI 验证；离线合成 provider 不代表部署模型表现。独立冷启动工具使用评估单独记录其模型、输入、首次调用与失败，不能替代运行时测试。
