# ADR 0004：手工可信扩展与同轮工具更新

> 后续变更：独立 authorize 回调、执行前授权 gate 及合成授权证据由 [ADR 0007](0007-model-owned-action-decisions.md) 取代。主模型直接依据对话/Prompt 决定调用或澄清；下文保留当时决定与阶段事实，技术校验、持久 intent/outcome、来源及恢复约束不变。

> 后续变更：独立 SemanticState 及其配置/自动引导已由 [ADR 0006](0006-memory-only-system-prompt.md) 取代；下文保留当时决定与阶段事实。普通工具/生成代码的宿主 OS 执行边界、Memory Git、无通知/重注入等未被撤销。

状态：Accepted，2026-10-05。用户批准原始设计第 95 节的手工 Cordis 阶段，官方 RC 版本与 Node `--expose-internals`，以及当前工具批次结束后的同轮生效方向。另批准限定范围的 Bundler 类型解析和普通配置文件持久化。原始设计文件保持不变。

## 范围与依赖

固定官方 `cordis@4.0.0-rc.10`、`@cordisjs/plugin-loader@1.0.0-rc.7`、`@cordisjs/plugin-hmr@1.1.0` 与 `@cordisjs/plugin-timer@1.1.3`。Timer peer 范围包含本 Cordis 版本。无需原生 addon，不运行依赖安装脚本。SDK 不暴露 Cordis、Pi、数据库或核心内部类型。宿主把配置内本地可信模块交给 Cordis，后者拥有依赖、生命周期、服务与热重载。

没有生成代码激活、npm 市场、自动安装依赖、新注册数据库、权限按钮、风险类别硬门禁或产品执行沙箱。OS 权限与自然语言意图判断继续适用；普通文件/Shell 工具保持既有行为。

## 同轮发布与恢复

显式管理工具只操作已手工配置的扩展 ID，返回 accepted；不能等待所属工具批次结束，否则会自锁。Pi 的 `prepareNextTurnWithContext` 在整批工具及持久订阅结束之后、下一次工具声明之前等待挂起操作并取得完整注册快照。第一请求单独准备一次。声明、schema、dispatcher 使用同一代工具；授权和 intent/outcome 不另开执行路径。

旧批次持有资源租约。原生 service/timer disposer 必须收集到同一个有序 Cordis effect，先等待批次完成再清理；一个独立异步 disposer 不能阻止 Cordis 同时清理其他资源。SDK 工具、listener、异步 cleanup 使用同一边界。Provider 先撤下服务并等待依赖消费者的异步清理，再释放共享资源；宿主记录代际完成屏障，覆盖 Cordis 全量停机先移除注册项的情况。结束或失败时释放最后租约，但不重开已持久化的最终回复。

每次 activation 使用实例 UUID，并进入工具描述，沿用既有 Pi declaration delta 持久化；即便 schema 相同也不隐藏代码代际变化。UUID 不是源码哈希。重启以实际配置和文件重建 registry，再记录正常声明变化；历史不能恢复函数或凭据，也不会自动重放已接受或结果不明的管理调用。

## 事件、服务与配置

事件来源和扩展身份由宿主/组装层绑定；`emitEvent` 不创建 Wake。显式 `requestWake` 复用已有事件/receipt 原子接收、去重、合并与恢复。内存事件总线不等于持久 Life Event。服务依赖由 SDK 的 requires 映射到 Cordis；失去服务时消费者暂停、恢复后重新 apply，旧批次保留原有服务代际。

CLI 从同一份普通 JSON 配置加载。enable/disable/configure 在边界先写 desired configuration，再 apply；receipt 分开记录保存状态和运行状态。保存失败不修改运行配置。保存成功但 apply 失败保留新 desired config 和真实失败状态，重启仍读取它，不宣称回滚。原子临时文件替换之前比对已知文件内容，发现外部编辑则拒绝覆盖；外部编辑器不参与锁，因此这不是跨进程文件 CAS。没有 PostgreSQL/文件/代码原子事务。纯程序化无配置文件的实例明确是临时状态。

## 官方 HMR 的实测限制

真实 Node 24 测试覆盖入口源码、传递 ESM 和 ESM-imported CJS。嵌套 CommonJS require 依赖不在官方 loader graph 中，不能承诺该种依赖变更自动重载。源码 watcher 是异步的；显式配置激活在下一自然模型请求前等待，文件编辑本身不提供同样的同步屏障。

import/validation 失败可保留旧实例；apply 失败发生于旧代清理之后，不能保证恢复旧代。registry 状态与诊断必须反映实际结果。官方框架依赖变更可能调用 loader.exit() 退出进程；未 vendoring、篡改或抑制它。测试要求 teardown 后完成标记，防止退出码零伪装成通过。

HMR 不引入 Memory/State 变更通知、重注入或自动 Wake。

## TypeScript 兼容

Cordis RC 的 .d.ts 使用无扩展名相对 ESM export，NodeNext 无法识别其导出；skipLibCheck 不能恢复丢失的类型。`tsconfig.extensions.json` 仅针对宿主及其直接测试使用 ESNext/Bundler，仍完整检查库声明；已有 Pi/server 消费项目使用相同解析，保留已批准的 Pi declaration skipLibCheck。核心与 SDK 保持严格 NodeNext，源代码继续显式 .ts ESM。没有新增打包器或改变 Node 运行方式，以真实运行测试验证解析假设。
