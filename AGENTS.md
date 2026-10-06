# Mira 开发指引

## 如何读取

本文件适用于整个仓库。修改某个范围前，读取下表对应的局部 `AGENTS.md`；路径相对于各文件所在目录。局部规则补充共享规则，不能放宽授权、安全或架构限制。保持每份指引尽量少于 100 行，长说明链接到 `docs/`，不要在所有包复制同一段规则。

结构参考 [HugeGraph 根指引](https://github.com/hugegraph/hugegraph/blob/89cd937cb2cea4f08730195d158721ff27065271/AGENTS.md)及其模块分层做法，只借鉴范围、入口、真实命令和陷阱组织，不套用 Java/Maven 约束。

## 当前状态与关系

当前实现包含连续上下文、合并 Wake、普通 Memory 与完整 Mira v0.2 Prompt、通用 Pi 工具、Memory Git、只读历史查询与 Cordis 手工/生成扩展生命周期，见 [ADR 0005](docs/adr/0005-generated-extension-lifecycle.md) 和 [扩展宿主](packages/extension-host/README.md)。Server 有假 provider CLI、Pi 离线模型目录、自定义发现与显式 model/streamFn transport；新增 Fastify/React 本地 Web、持续 Timeline 与模型设置；真实模型联通尚未验收，详见 [ADR 0009](docs/adr/0009-local-web-client.md)。

- `apps/server` 组装核心与适配器；`apps/web` 提供单条 Timeline
- `life` / `context` 保持独立，不导入 Pi、Cordis、数据库或 Web 框架
- 核心拥有契约，`runtime-pi`、`persistence`、`workspace` 等适配器实现契约
- 扩展只使用 `extension-sdk`；Cordis 处理生命周期，不是安全沙箱
- 生成扩展测试/导入/执行按已确认的宿主 OS 身份运行，无产品隔离；默认生成流程不修改核心/授权/历史/security，目录只是约定
- stage 不执行代码，内容 SHA 包含本地依赖；版本/config 先保存后 apply，rollback 是显式新激活，不是原子撤销
- 用户数据、Memory 的独立 Git、生成扩展、日志、凭据均在源码仓库之外；不再配置、创建或自动读取独立 SemanticState
- 普通文件变化不通知上下文、不 Wake、不重注入；仅真正初始上下文加载 MEMORY.md；正常恢复/重启沿用持久 bootstrap 快照
- Pi 通用文件/search/bash 工具无应用工作目录限制，无产品隔离环境要求；cwd 不是沙箱，OS 权限与自然语言意图判断仍有效
- 实际允许依赖和出口以 `scripts/boundaries.json` 与各包 `package.json` 为准；新增时最小开放

## 按需指引

| 范围 | 指引 |
| --- | --- |
| Web | [apps/web/AGENTS.md](apps/web/AGENTS.md) |
| Server | [apps/server/AGENTS.md](apps/server/AGENTS.md) |
| Life | [packages/life/AGENTS.md](packages/life/AGENTS.md) |
| Context | [packages/context/AGENTS.md](packages/context/AGENTS.md) |
| Cognition | [packages/cognition/AGENTS.md](packages/cognition/AGENTS.md) |
| Pi | [packages/runtime-pi/AGENTS.md](packages/runtime-pi/AGENTS.md) |
| Authorization | [packages/authorization/AGENTS.md](packages/authorization/AGENTS.md) |
| Persistence | [packages/persistence/AGENTS.md](packages/persistence/AGENTS.md) |
| Workspace | [packages/workspace/AGENTS.md](packages/workspace/AGENTS.md) |
| Extension SDK | [packages/extension-sdk/AGENTS.md](packages/extension-sdk/AGENTS.md) |
| Extension Host | [packages/extension-host/AGENTS.md](packages/extension-host/AGENTS.md) |
| External SDK | [packages/external-sdk/AGENTS.md](packages/external-sdk/AGENTS.md) |
| Tests | [tests/AGENTS.md](tests/AGENTS.md) |
| Scripts/CI | [scripts/AGENTS.md](scripts/AGENTS.md) |
| GitHub Actions | [.github/AGENTS.md](.github/AGENTS.md) |
| Docs | [docs/AGENTS.md](docs/AGENTS.md) |

## 常用命令（仓库根目录）

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

`check` 包括类型、包边界、基础/离线测试和工具构建；`test:integration` 要求显式隔离数据库，`check:all` 包含真实 PostgreSQL 验证。测试使用假 provider 或注入 fetch 的合成协议响应，不调用真实模型。测试数量以实际输出为准，命令和隔离要求见 [toolchain.md](docs/development/toolchain.md)。`build` 构建检查工具及 Vite 页面；`pnpm start` 启动本地 Web，`test:e2e` 为独立浏览器 fixture 验证。

## 共享约束

- 先读 [最新设计 v0.5](docs/design/architecture-v0.5.md)、[Prompt 集成 ADR 0006](docs/adr/0006-memory-only-system-prompt.md)、[主模型判断 ADR 0007](docs/adr/0007-model-owned-action-decisions.md)、[架构](docs/architecture.md)和 [验收](docs/acceptance/foundation.md)
- 一个持续 Mira；Wake 继续上下文，Event 不等于 Wake；不加入 New Chat 或会话领域
- Compaction 与 Dreaming 分开；先验证 Pi 恢复/工具/压缩，再实现主循环
- 跨进程单写者、版本检查、增量工具记录；未知结果真实呈现给模型，不自动重放、不全局阻断认知
- 主模型依据用户对话、上下文和自然语言 Prompt 决定调用或澄清；无 authorize 回调、allowed/evidence/denial 决策或替代引擎/额外模型调用。authorizationContext 仅为事实语境；schema、不可变 intent/outcome、来源、去重、真实身份/OS 权限和数据完整性仍是硬边界
- 超限唤醒保存普通文本文件并告知路径；复用普通文件工具，不构建专用消息读取/分页服务
- 早期开发只维护当前 v0.5/v0.2 设计，不保留旧 State/Prompt 配置、别名或迁移层；继续保护当前持久上下文、历史、恢复/压缩与 Memory Git 完整性，不引入用户数据清理/重置
- 重要技术选择与范围变化先向用户确认，状态记录在 `docs/adr/`；不能把建议当批准
- 每轮实现及修复都使用全新、独立 `gpt-6.1-sol` / `max` 审查，不继承实现对话
- 提交前执行适用检查，区分通过、失败、阻塞、未执行；模拟通过不代表真实联通
- 后续代码经草稿 PR 提交；未经用户确认不合并、不绕过保护、不部署
- 行为、配置、命令、依赖、公开接口变化与对应文档/本指引在同一 PR 更新
- 不输出或提交用户秘密；不自动引入付费调用、账户、凭据或权限扩张
