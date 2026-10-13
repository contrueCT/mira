# ADR 0019：扩展 ContextProvider 的自然请求快照

状态：Accepted，2026-10-13。用户批准以 Extension 能力实现 ContextProviders，沿用现有动态工具、Skills、持久上下文和管理生命周期；不创建独立心理状态、授权 gate、沙箱或额外 Wake。v0.5 §30 列出的能力通过本 ADR 定义实际接口。

## SDK 与来源

扩展在 `apply` 内调用 `registerContextProvider({ id, provide({ signal }) })`。`provide` 返回 `{ text: string }` 或 `null`，用于只读观察，不能把自动采样作为新的工具副作用执行通道。需要动作时仍由主模型选择普通工具，经既有 intent/outcome 路径执行。可信同进程代码可使用宿主 OS 能力；此接口约定不是安全隔离。

Provider ID 使用 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`，在同一配置扩展内唯一，不同扩展可用相同 ID。宿主绑定 `extensionId`、`activation`、`providerId` 与可选生成版本 `digest`，不接受扩展返回的来源字段。为使来源与失败状态也有确定上限，贡献 Provider 的配置扩展 ID 最长 128 字符，全宿主最多同时注册 32 个 Provider；超限或重名使该激活失败并清理其已注册资源。

## 请求与持久化

宿主的 `prepareCapabilities()` 等待已知生命周期操作，在同一同步快照内捕获工具和 Provider 声明。Server 的 `prepareTools` 保存该份 Provider 列表，Runtime 的 `loadContextProviders` 在同一次自然 `prepareRequest` 内调用 `sampleContextProviders`。每个注册项顺序采样一次，不在 prepare/recover/compact 中自动采样，不根据文件变化触发采样。

Runtime 验证来源、唯一 ID 与大小，将 JSON 来源/状态/正文作为观察数据附入现有 `OTHER_ENVIRONMENT_CONTEXT`。明确说明这些数据不是新指令或用户授权；现有单次转义阻止动态文本闭合模板边界或二次展开占位符。完整渲染与来源内容进入原有 `miraPrompt.values`，通过相同 writer 所有权与版本 CAS 先持久化，再交给实际模型请求。不添加另一份当前上下文状态、表或后台刷新引擎。

同一次请求保持冻结观察。成功压缩沿用该份观察及 Skills，仅按 ADR 0016 刷新 Memory；普通恢复先恢复确切持久快照，下一自然模型请求再采样。空注册表移除旧观察；相同数据不会单独制造重复 system revision。原始历史保持不变，不把旧来源伪装成当前新观察。

## 失败、限额与取消

- 正常数据为 `ok`，附完整 text；`null` 或空字符串为 `empty`
- callback 异常或无效返回为 `failed`；不复制原异常、堆栈、秘密或无效值，不沿用上次成功正文
- 每项完整 JSON 来源/状态/正文最多 16,384 UTF-8 字节，超过返回 `too-large`，不截断
- 整个 JSON 数组最多 65,536 UTF-8 字节；预留所有来源与失败状态，按注册顺序无法容纳正文的项返回 `budget-exceeded`。仍对捕获的每个 Provider 采样一次，避免隐含的数据缓存/优先级机制
- 以上是模板转义前的 JSON 预算；Runtime 最终模型预算仍计入完整转义后 system、工具及消息，无法容纳时不发请求
- 取消立即中断请求准备，不持久化部分采样结果，不发模型请求，不将取消显示成 Provider 普通失败。宿主仍等待实际 callback 结束才释放资源租约；忽略 AbortSignal 的同进程代码不能被强制终止，可能延迟卸载/关闭
- 宿主列表加载故障、Runtime 来源/大小验证失败、writer 所有权失效、CAS 或持久化失败继续阻止模型请求；它们不能降级成正常观察缺失

## 生命周期与 HMR

捕获声明不持有整批租约。真正调用 `provide` 前同步检查原 activation、运行状态及注册身份，随后才取得现有执行租约。已开始的采样可完成并返回其原来源；卸载/替换后尚未开始的同批 sibling 返回 `stale`，不能执行已清理闭包，也不能按同名转投新实现。结果体现该次请求实际采样状态，不承诺工具和观察是外部世界的原子快照。

Provider 使用与工具相同的 cleanup、依赖服务、timer/listener 次序。下一自然请求捕获新代；真实文件 HMR 的异步到达、导入失败保留旧代与 apply 失败不原子回滚等限制继续按 ADR 0014 和宿主 README 处理。没有第二套 HMR 或后台采样器。

## 管理与验证

`ExtensionStatus.contextProviders` 返回注册 ID，管理页读取现有宿主事实。采样的 failed/too-large/budget-exceeded 在宿主当前进程诊断中显示固定错误；同项下次正常或 empty 采样清除，卸载清除，旧代迟到结果不覆盖新代。管理页继续固定脱敏投影，不展示原异常；该健康提示不是新增持久历史，stale/取消不伪称当前 Provider 失败。管理 HTTP 的过期操作防护使用宿主私有 desired/runtime/activation/capability/最近 receipt 的不透明 SHA-256 revision；`requestChange` 可接收 `expectedRevision`，在生命周期串行队列中排空已知 HMR 后比较，冲突不保存或 apply。原有模型管理工具可继续使用两参数请求，不增加模型授权判断。

确定性测试覆盖 SDK→真实 Cordis Host→Pi 实际 stream 请求、同轮管理和旧工具 sibling、空/失败/越界/来源伪造、重复 ID、取消与资源持有、实际官方 HMR 子进程、恢复/确切快照/压缩、Memory 不额外读取、CAS/所有权与提交响应丢失。离线机制检查使用合成 provider 与内存 writer；不能称为真实 PostgreSQL、浏览器或生产模型验收。这些门禁由本次提交的 CI/验证记录分别报告。
