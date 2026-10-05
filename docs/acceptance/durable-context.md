# 连续上下文与恢复验收

范围由 [ADR 0001](../adr/0001-durable-context.md) 确认。以下区分离线验证、真实数据库验证和未覆盖范围；草稿 PR 的合入仍需用户确认。

## 本批范围

- 核心拥有版本化 JSON envelope 和持久化契约，Pi 类型不进入核心
- PostgreSQL history/context/checkpoint、Event 与可选 Wake receipt、工具 intent/outcome
- 专用持锁连接、epoch fencing、context CAS、失效停止
- 顺序工具执行，未知结果不重放，已保存结果恢复为上下文
- 同一 Mira 进程重启后继续；一次性 SDK 完整压缩与重复压缩

## 验证入口

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
MIRA_TEST_DATABASE_URL='postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test' pnpm test:integration
```

连接串示例只适用于隔离测试服务。集成测试要求显式变量和本地 `mira_test` 数据库；每组使用独立测试 schema 并清理。未设置时命令失败，不静默跳过。禁止指向生产或用户数据。

模型调用均使用假 provider。测试脚本清除继承的模型凭据、代理配置和真实 HOME，并安装 HTTP/fetch 拦截器。该拦截器是测试误调用保护，不是未知代码沙箱。

## 执行记录

2026-10-05 本地验证：

- 固定 pnpm 11.28.4 的 frozen-lockfile 安装通过；安装生命周期脚本关闭
- `pnpm check` 通过：两套严格源代码类型检查、包边界、56 项离线测试（0 跳过）和工具构建
- PostgreSQL 18.6 单进程真实引擎通过迁移 up/down、约束、持久化重启及 advisory-lock 表示检查；此项不替代驱动/多进程验证
- 原始设计 SHA-256 保持 `fbd116b05b50c3e604a36da96e21d6d5e254e5b67ec689b3a80d7750872c6e15`；相对文档链接、`git diff --check` 通过
- 独立审查发现的 checkpoint 边界、system 状态、空摘要、工具声明/约束、凭据发现和模型完成身份问题已修复并补回归；修复后的全新独立审查无可操作发现，真实 PostgreSQL CI 已通过（见下文）

真实数据库套件包含 13 项持久化测试及 12 项运行时恢复测试。当前云环境禁止本地 Unix socket，这 25 项没有在本地运行；它们已在官方 PostgreSQL 18.6 CI 服务中全部执行并通过，0 失败、0 跳过。

[CI 37279528537](https://github.com/contrueCT/mira/actions/runs/37279528537) 于 2026-10-05 完整通过，核验的实现提交为 `25293f1354a755d9ce88e74e32c18bc954769c79`。远端日志同时确认 56 项离线测试和 25 项真实数据库/进程测试。首次 CI 的安装脚本阻断已通过显式 `--ignore-scripts` 修复，未扩大依赖构建权限。最终 PR head 的检查状态以 [草稿 PR #2](https://github.com/contrueCT/mira/pull/2) 为准；后续验收记录更新不改变实现代码。

## 未覆盖

真实模型的摘要质量、供应商真实签名回放、生产数据库断电恢复、远端服务幂等、生产吞吐、自动调度或事件合并、API/UI、语义记忆、完整授权解析、扩展执行均未验收。没有 exactly-once 承诺。


## 压缩认证隔离补充

用户于 2026-10-05 批准临时 provider 别名隔离，避免 SDK 自动读取环境凭据。新的离线子进程回归对 OpenAI、Anthropic、Bedrock、Vertex 使用合成环境，确认摘要请求仍收到原始 model，未得到自动解析的 apiKey/headers/env，没有认证文件访问，原始记录/recent tail 不变，checkpoint 不包含内部别名。没有使用真实密钥或模型调用。此修复及后续完成身份校验已包含在上述精确实现提交和完整 CI 中；修复后的全新独立审查已确认该隔离路径及完成身份边界，无可操作发现。
