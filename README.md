# Mira

一个持续存在、保持连续工作上下文、拥有长期语义记忆，并逐步扩展自身能力的个人智能体。

> Wake continues the same Mira.

## 当前状态

当前增量包含 PostgreSQL 持久上下文、合并唤醒、单认知循环、Pi 执行/压缩、普通 Memory/State、Memory-only Git 快照、通用文件/Shell、只读历史查询、Cordis 手工/生成扩展生命周期与同轮工具更新，以及假 provider CLI 演示。没有 HTTP 服务、Web 页面、通用授权解析器或真实模型联通验收；未实现目录仍仅代表职责边界。

- [原始设计 v0.4](docs/design/original-v0.4.md)
- [架构边界](docs/architecture.md)
- [开发约束](docs/development/rules.md)
- [工具链与验证命令](docs/development/toolchain.md)
- [分阶段验收](docs/acceptance/foundation.md)
- [决策记录](docs/adr/README.md)
- [连续上下文与恢复验收](docs/acceptance/durable-context.md)
- [合并唤醒设计](docs/adr/0002-coalesced-wake-loop.md)
- [普通 Memory/State 与历史查询](docs/adr/0003-ordinary-memory-history.md)
- [手工可信扩展与同轮更新](docs/adr/0004-manual-trusted-extensions.md)
- [扩展验收与官方 HMR 限制](docs/acceptance/manual-extensions.md)
- [生成扩展生命周期与执行边界](docs/adr/0005-generated-extension-lifecycle.md)
- [生成扩展验收](docs/acceptance/generated-extensions.md)
- [最小假模型演示](apps/server/README.md)

基础设施优先保证连续性、真实历史、授权和故障恢复。模型负责理解和行为；不建立数值情绪系统、不把每次 Wake 变成新会话。

## 目录

| 路径 | 职责 |
| --- | --- |
| `apps/web` | Timeline、Memory、Extensions、Settings |
| `apps/server` | API、认证、启动与依赖组装 |
| `packages/life` | 事件、Wake 队列、单主认知循环 |
| `packages/context` | Working Context、时间渲染、版本 |
| `packages/cognition` | Runtime 接口与规范化消息 |
| `packages/runtime-pi` | Pi 适配与压缩集成 |
| `packages/authorization` | 授权证据与执行边界 |
| `packages/persistence` | PostgreSQL、迁移、事务与历史检索 |
| `packages/workspace` | 普通记忆/状态文件、Memory-only Git |
| `packages/extension-sdk` | 扩展的公开契约 |
| `packages/extension-host` | Cordis 生命周期与注册 |
| `packages/external-sdk` | 外部程序事件/Wake API |
| `tests` | 集成、恢复、端到端验收 |
| `docs` | 原始设计、决策、开发规则、验收 |

用户记忆、状态、生成扩展、数据库、运行日志和凭据必须放在源码仓库之外。不要把源码仓库当作 Mira 的持久工作空间。

## 基础验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

这些命令验证工具链、包边界与离线模型测试。真实 PostgreSQL 测试另运行 `pnpm test:integration`，要求显式 `MIRA_TEST_DATABASE_URL`；CI 执行 `pnpm check:all`。具体隔离要求见验收文档。
