# Mira 开发指引

## 如何读取

本文件适用于整个仓库。修改某个范围前，读取下表对应的局部 `AGENTS.md`；路径相对于各文件所在目录。局部规则补充共享规则，不能放宽授权、安全或架构限制。保持每份指引尽量少于 100 行，长说明链接到 `docs/`，不要在所有包复制同一段规则。

结构参考 [HugeGraph 根指引](https://github.com/hugegraph/hugegraph/blob/89cd937cb2cea4f08730195d158721ff27065271/AGENTS.md)及其模块分层做法，只借鉴范围、入口、真实命令和陷阱组织，不套用 Java/Maven 约束。

## 当前状态与关系

当前实现包含连续上下文、合并 Wake、普通 Memory 与完整 Mira v0.2 Prompt、通用 Pi 工具、Memory Git、只读历史查询与 Cordis 手工/生成扩展生命周期，见 [ADR 0005](docs/adr/0005-generated-extension-lifecycle.md) 和 [扩展宿主](packages/extension-host/README.md)。Server 有假 provider CLI、Pi 离线模型目录、自定义发现与显式 model/streamFn transport；新增 Fastify/React 本地 Web、持续 Timeline、普通文件 Skills 与直接 API Key 设置；密钥仅在源码外的私有文件保存，公开接口不回填。真实模型联通尚未验收，详见 [ADR 0009](docs/adr/0009-local-web-client.md)。

- `apps/server` 组装核心与适配器；`apps/web` 提供单条 Timeline
- `life` / `context` 保持独立，不导入 Pi、Cordis、数据库或 Web 框架
- 核心拥有契约，`runtime-pi`、`persistence`、`workspace` 等适配器实现契约
- 扩展只使用 `extension-sdk`；Cordis 处理生命周期，不是安全沙箱
- 生成扩展测试/导入/执行按已确认的宿主 OS 身份运行，无产品隔离；默认生成流程不修改核心/授权/历史/security，目录只是约定
- stage 不执行代码，内容 SHA 包含本地依赖；版本/config 先保存后 apply，rollback 是显式新激活，不是原子撤销
- 管理操作直接等待应用并返回实际状态；仅保护执行中的扩展调用，旧 activation 的未执行 sibling 返回明确 stale，不按同名切换新实现，见 ADR 0014
- Web 默认初始化持久空扩展配置及 artifact store，提供管理工具；保留已有文件与显式 `MIRA_EXTENSIONS` 优先级，不自动安装/激活新扩展，见 ADR 0013
- 用户数据、Memory 的独立 Git、生成扩展、日志、凭据均在源码仓库之外；不再配置、创建或自动读取独立 SemanticState
- 普通文件变化不通知上下文、不 Wake、不重注入；初始上下文读取 Memory；压缩摘要前读取一次当前 MEMORY.md，摘要和最终 system/摘要/尾部使用同份冻结快照，同一 fenced CAS checkpoint 原子发布；正常恢复/重启沿用最新持久快照，见 ADR 0016
- Pi 通用文件/search/bash 工具无应用工作目录限制，无产品隔离环境要求；cwd 不是沙箱，OS 权限与自然语言意图判断仍有效
- [ADR 0018](docs/adr/0018-dreaming-memory-housekeeping.md)：Web Memory 默认启用 Dreaming，持久触发条件为新有效经历、空闲 30 分钟、三次成功压缩或超过 24 小时；触发时原子消费游标，失败恢复同一 Wake，不自动热重试，不强制压缩或刷新 Memory。
- [ADR 0017](docs/adr/0017-external-sdk-local-ingress.md)：External SDK 通过本机默认关闭的入口发 Event/Wake/Timeline notice；普通 Shell CLI 管理私有身份/凭据，配置逐次认证生效。认证绑定来源，不构成模型动作审批；通知不 Wake，不接外部推送渠道
- [ADR 0019](docs/adr/0019-extension-context-providers.md)：扩展 ContextProvider 与工具捕获同一代，在自然模型请求采样有来源/预算的观察，复用现有 system 持久快照；失败/取消/旧代不复用旧数据，不额外 Wake 或改变 Memory 加载。
- [ADR 0020](docs/adr/0020-settings-management.md)：既有设置窗口内增加 Memory 总览/自然语言请求、扩展管理及按 Wake 的只读历史；主聊天不加入口，接收与完成分开，不回填配置或原始诊断，不新增日志。
- [ADR 0021](docs/adr/0021-chat-attachments.md)：聊天共用不可变附件存储与引用，正文/有序附件原子绑定既有 Event/Wake；send_attachment 仅显式已知发布投影。图片原生输入，视频统一普通文件，只有模型显式 read 后内置 Google Gemini 的 MP4/WebM 才通过公开 payload hook 原生理解；PDF/Word只给工具引用，历史不存媒体 base64。
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
- Mira 连续上下文摘要使用 `packages/runtime-pi/prompts/mira-compaction-v0.1.md`，公开 `session_before_compact` hook 单次处理 initial/update/split_turn；hook 失败不得回退到 Pi coding-summary，实际模型质量 native probes 与离线机制测试分开报告
- Compaction 与 Dreaming 分开；自动压缩默认开启，在工具批次全部落库后的自然请求边界检查预算；保留 Pi 完整 SDK、未知结果与合法工具配对，溢出最多恢复重试一次，见 [ADR 0016](docs/adr/0016-automatic-compaction-memory-refresh.md)
- 跨进程单写者、版本检查、增量工具记录；未知结果真实呈现给模型，不自动重放、不全局阻断认知
- [ADR 0015](docs/adr/0015-safe-tool-recovery-diagnostics.md)：可选 phase/category 诊断仅写现有 unknown operation，固定白名单文字；无原异常/headers/参数片段，无新日志表。写入/finishTool/fencing 失败仍致命，临时 Web notice 不承诺诊断落库
- 主模型依据用户对话、上下文和自然语言 Prompt 决定调用或澄清；无 authorize 回调、allowed/evidence/denial 决策或替代引擎/额外模型调用。authorizationContext 仅为事实语境；schema、不可变 intent/outcome、来源、去重、真实身份/OS 权限和数据完整性仍是硬边界
- 超限唤醒保存普通文本文件并告知路径；复用普通文件工具，不构建专用消息读取/分页服务
- [ADR 0012](docs/adr/0012-global-history-identities.md)：四类 History 采用全局 UUID 薄身份表；read 只接收 ID，外部事件/工具协议标识分离；Memory commit 保存直接 History-Id。新空库/数据目录启动，不添加旧库检测、映射、兼容或清理
- [ADR 0011](docs/adr/0011-conversation-context-and-skills.md)：正常聊天不展示工具活动；Wake 精简正文但保留业务 payload；Pi Skills 只扫描源码 skills/ 与 Mira home skills/，每自然请求更新目录、正文按需 read，不额外 Wake
- 用户批准的 v0.2 纯文本聊天修订保留其他原文；来源 manifest 同时记录原始与当前 SHA，不可把修订伪称原始附件字节
- 早期开发只维护当前 v0.5/v0.2 设计，不保留旧 State/Prompt 配置、别名或迁移层；继续保护当前持久上下文、历史、恢复/压缩与 Memory Git 完整性，不引入用户数据清理/重置
- 重要技术选择与范围变化先向用户确认，状态记录在 `docs/adr/`；不能把建议当批准
- 每轮实现及修复都使用全新、独立 `gpt-6.1-sol` / `max` 审查，不继承实现对话
- 提交前执行适用检查，区分通过、失败、阻塞、未执行；模拟通过不代表真实联通
- 后续代码经草稿 PR 提交；未经用户确认不合并、不绕过保护、不部署
- 行为、配置、命令、依赖、公开接口变化与对应文档/本指引在同一 PR 更新
- 不输出或提交用户秘密；不自动引入付费调用、账户、凭据或权限扩张
