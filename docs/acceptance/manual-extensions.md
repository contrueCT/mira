# 手工可信扩展验收

本批对应原始设计 §95 与 [ADR 0004](../adr/0004-manual-trusted-extensions.md)。没有真实模型调用、HTTP/UI、生成扩展、npm 安装或部署。

## 执行入口

- `pnpm check`：三个限定项目的类型检查、包边界、全部离线测试、工具构建
- `pnpm check:all`：额外执行显式独立 PostgreSQL 服务上的完整恢复测试
- `tests/unit/extension-host.test.mts`：SDK/host、依赖消失恢复、失败、异步清理、真实 HMR 批次租约
- `tests/unit/official-hmr.test.mts`：固定官方包的源码、传递依赖、CJS 限制和不同失败阶段
- `tests/unit/live-tools.test.mts`：Pi 同轮发布、完整批次、schema/dispatcher、intent 先于执行、取消和失败
- `tests/unit/extension-runtime.test.mts`：真实 host/server/Pi 组装的同轮激活与调用
- `tests/unit/extension-configuration.test.mts`：同文件保存、失败/外部编辑、重启、null 配置
- `tests/recovery/extensions.test.mts`：真实 PostgreSQL 的同 Wake 激活、精确证据、重启无重放、来源绑定、显式 Wake 合并去重

测试使用假 provider 和临时扩展文件，不把离线 MemoryWriter 当数据库验证。HMR 子进程实际携带 `--expose-internals`；不需要原生 addon 或网络。执行结果和最终提交 CI 以该 PR 的完整验证记录为准，尚未运行的数据库测试不能记为通过。
