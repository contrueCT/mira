# 连续上下文与恢复验收

范围由 [ADR 0001](../adr/0001-durable-context.md) 确认。本记录随实际最终验证更新；草稿阶段不代表全部通过。

## 本批范围

- 核心拥有版本化 JSON envelope 和持久化契约，Pi 类型不进入核心
- PostgreSQL history/context/checkpoint、Event 与可选 Wake receipt、工具 intent/outcome
- 专用持锁连接、epoch fencing、context CAS、失效停止
- 顺序工具执行，未知结果不重放，已保存结果恢复为上下文
- 同一 Mira 进程重启后继续；一次性 SDK 完整压缩与重复压缩

## 验证入口

```sh
pnpm install --frozen-lockfile
pnpm check
MIRA_TEST_DATABASE_URL='postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test' pnpm test:integration
```

连接串示例只适用于隔离测试服务。集成测试要求显式变量和本地 `mira_test` 数据库；每组使用独立测试 schema 并清理。未设置时命令失败，不静默跳过。禁止指向生产或用户数据。

模型调用均使用假 provider。测试脚本清除继承的模型凭据、代理配置和真实 HOME，并安装 HTTP/fetch 拦截器。该拦截器是测试误调用保护，不是未知代码沙箱。

## 执行记录

2026-10-05 本地验证：

- 固定 pnpm 11.28.4 的 frozen-lockfile 安装通过；安装生命周期脚本关闭
- `pnpm check` 通过：两套严格源代码类型检查、包边界、50 项离线测试（0 跳过）和工具构建
- PostgreSQL 18.6 单进程真实引擎通过迁移 up/down、约束、持久化重启及 advisory-lock 表示检查；此项不替代驱动/多进程验证
- 原始设计 SHA-256 保持 `fbd116b05b50c3e604a36da96e21d6d5e254e5b67ec689b3a80d7750872c6e15`；相对文档链接、`git diff --check` 通过
- 前两轮独立审查发现的 checkpoint 边界、system 状态、空摘要、首次工具声明与约束字段问题已修复并补回归；最新独立审查与真实 PostgreSQL CI 结果待补

真实数据库套件包含 13 项持久化测试及 12 项运行时恢复测试。当前云环境禁止本地 Unix socket，尚未本地执行这 25 项；CI 将在精确 PR head 执行，不把未执行记录为通过。

## 未覆盖

真实模型的摘要质量、供应商真实签名回放、生产数据库断电恢复、远端服务幂等、生产吞吐、自动调度或事件合并、API/UI、语义记忆、完整授权解析、扩展执行均未验收。没有 exactly-once 承诺。
