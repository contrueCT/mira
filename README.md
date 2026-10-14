# Mira

一个持续存在、保持连续工作上下文、拥有长期语义记忆，并逐步扩展自身能力的个人智能体。

> Wake continues the same Mira.

## 当前状态

当前增量包含 PostgreSQL 持久上下文、合并唤醒、单认知循环、Pi 执行/压缩、普通 Memory、Memory-only Git 快照、通用文件/Shell、只读历史查询、Cordis 手工/生成扩展生命周期与同轮工具更新，以及假 provider CLI 演示、Pi 内置模型目录、显式自定义连接与模型列表发现。新增 Fastify 本地 HTTP 与 React/Vite 单 Timeline、模型设置和一条命令启动；尚未做真实模型联通验收。设置窗口已包含 Memory 总览与自然语言管理、扩展生命周期管理及按 Wake 的只读历史，详见 [设置管理](docs/adr/0020-settings-management.md)。

- [最新设计 v0.5](docs/design/architecture-v0.5.md)
- [System Prompt 设计 v0.1](docs/design/system-prompt-design-v0.1.md)与[实际模板 v0.2](packages/runtime-pi/prompts/mira-system-v0.2.md)
- [原始设计 v0.4（历史存档）](docs/design/original-v0.4.md)
- [架构边界](docs/architecture.md)
- [开发约束](docs/development/rules.md)
- [工具链与验证命令](docs/development/toolchain.md)
- [分阶段验收](docs/acceptance/foundation.md)
- [决策记录](docs/adr/README.md)
- [连续上下文与恢复验收](docs/acceptance/durable-context.md)
- [合并唤醒设计](docs/adr/0002-coalesced-wake-loop.md)
- [Memory-only 与实际 Prompt 集成](docs/adr/0006-memory-only-system-prompt.md)
- [主模型动作判断与执行边界](docs/adr/0007-model-owned-action-decisions.md)
- [手工可信扩展与同轮更新](docs/adr/0004-manual-trusted-extensions.md)
- [扩展验收与官方 HMR 限制](docs/acceptance/manual-extensions.md)
- [生成扩展生命周期与执行边界](docs/adr/0005-generated-extension-lifecycle.md)
- [生成扩展验收](docs/acceptance/generated-extensions.md)
- [最小假模型演示](apps/server/README.md)
- [安全的工具恢复诊断](docs/adr/0015-safe-tool-recovery-diagnostics.md)
- [自动压缩与 Memory 原子刷新](docs/adr/0016-automatic-compaction-memory-refresh.md)

项目仍处早期开发，只维护当前 Architecture v0.5 与 Prompt v0.2，不保留旧 State/Prompt 兼容层；原始设计存档仅作来源记录。当前格式的持久上下文、重启/压缩、原始历史和 Memory Git 完整性继续保证。

自动压缩默认在自然模型请求的输入预算达到 80% 时尝试，保留 Pi 完整 SDK 压缩与工具恢复语义。压缩前读取一次当前 MEMORY.md，摘要与最终 system/摘要/近期尾部原子 checkpoint 使用同一份冻结快照；普通请求和文件修改不重读、不 Wake，重启恢复最新快照。摘要使用已批准的 Mira 连续上下文提示词，公开 Pi hook 单次处理 initial/update/split_turn，失败不回退到 coding-summary。具体预算、单次溢出恢复与失败边界见 ADR 0016；确定性机制验证与[六例原生模型质量探针](docs/acceptance/compaction-continuity.md)分开报告；后者仍有许可措辞及来源 ID 局限，不代表生产 provider 验收。

Dreaming 在本地 Web 配置 Memory 时默认启用：有新的显式用户/扩展/外部 Wake，连续空闲 30 分钟，且自上次触发已有 3 次成功上下文压缩或超过 24 小时，才运行一次普通整理 Wake。首次启用建立基线；无新经历、仅记录事件和外部通知不会空跑。模型使用普通工具安静修订 Memory，Git 与失败恢复沿用现有链路；不强制压缩或刷新 system Memory。详见 [ADR 0018](docs/adr/0018-dreaming-memory-housekeeping.md)。

基础设施优先保证连续性、真实历史、执行完整性和故障恢复。主模型根据用户对话、上下文和自然语言 Prompt 决定工具调用或澄清，没有独立 authorize 回调或授权引擎；不建立数值情绪系统、不把每次 Wake 变成新会话。

内置 [公开文档、转写、浏览器和联网技能](docs/adr/0023-on-demand-public-skills.md)沿用普通 read/bash；仅提供说明与必要脚本，依赖按需准备，不预装浏览器、OCR 或音频模型。安装与云端调用边界见[按需运行工具](docs/development/runtime-tools.md)。

## 目录

| 路径 | 职责 |
| --- | --- |
| `apps/web` | Timeline、Memory、Extensions、Settings |
| `apps/server` | API、认证、启动与依赖组装 |
| `packages/life` | 事件、Wake 队列、单主认知循环 |
| `packages/context` | Working Context、时间渲染、版本 |
| `packages/cognition` | Runtime 接口与规范化消息 |
| `packages/runtime-pi` | Pi 适配与压缩集成 |
| `packages/authorization` | 事实性授权语境占位，无独立判断引擎 |
| `packages/persistence` | PostgreSQL、迁移、事务与历史检索 |
| `packages/workspace` | 普通记忆文件、Memory-only Git |
| `packages/extension-sdk` | 扩展的公开契约 |
| `packages/extension-host` | Cordis 生命周期与注册 |
| `packages/external-sdk` | 外部程序事件/Wake API |
| `tests` | 集成、恢复、端到端验收 |
| `docs` | 原始设计、决策、开发规则、验收 |

用户记忆、生成扩展、数据库、运行日志和凭据必须放在源码仓库之外。不要把源码仓库当作 Mira 的持久工作空间。

## 安装、使用与测试

第一次安装请按 [本地安装与测试指南](docs/development/local-web.md) 完成 Node/pnpm、PostgreSQL 用户与数据库配置。指南包含完整命令、网页直接填写 API Key、独立模拟环境和测试方式。

```sh
# 克隆这个私有仓库需要已有 GitHub 访问权限
git clone https://github.com/contrueCT/mira.git
cd mira
pnpm install --frozen-lockfile --ignore-scripts
pnpm terminal:prepare

# 已按指南创建数据库并设置数据库认证后，正常启动（不是模拟模式）
MIRA_DATABASE_URL=postgres://mira@127.0.0.1:5432/mira pnpm start
```

默认打开 `http://127.0.0.1:3210`。新数据库显示空时间线；已有数据库恢复自己的持久历史，不加载截图中的示例对话。先在设置中选择模型并直接填写 API Key，保存后再发送真实消息。密钥以明文保存到源码仓库外的本地 `~/.mira/models.json`，通过文件权限保护；网页仅显示是否已保存，不回填密钥。请只在可信的个人电脑上使用。

### 测试入口

- `pnpm check`：严格类型、包边界、离线测试和应用构建，无真实模型调用
- `pnpm test:integration`：需要显式独立的本地 `mira_test` 数据库；创建/清理测试 schema，不能指向日常数据
- `pnpm test:e2e`：先 `pnpm build` 并安装 Playwright Chromium；只启动专用浏览器测试 fixture
- 手动模拟需显式 `--synthetic`，并使用指南中的独立数据库、`MIRA_HOME` 与端口，避免把模拟回复写入日常历史

测试源码里的合成对话是回归测试夹具，不是应用初始数据。截图、运行数据、数据库、Memory、密钥、构建产物和浏览器测试输出不提交到源码仓库。真实模型效果与付费调用尚未验收。

模型目录与协议配置详见 [模型配置与发现](docs/development/models.md)。

模型设置现可选择默认推理强度，缺省为中档，按 Pi 模型能力适配；主 Mira、子任务与 Dreaming 使用同一偏好，压缩摘要独立使用最低支持档。更高档可能增加耗时和费用，实际推理预算仍受总输出上限限制，详见 [ADR 0027](docs/adr/0027-configured-reasoning-levels.md)。

## 可选网页密码与局域网访问

设置 → 访问可启用/修改/关闭共用密码，默认关闭。启用后全部私有 Web API 和附件需登录；修改或关闭需当前密码。登录最长 12 小时，服务重启后重登。密码仅以 scrypt hash 存入私有 `web-access.json`。

默认仅监听 `127.0.0.1`；局域网可显式设置 `MIRA_HOST=0.0.0.0 MIRA_PUBLIC_ORIGIN=http://<服务器LAN-IP>:3210` 后按原命令启动，客户端访问该 LAN IP。`0.0.0.0` 不是浏览器访问地址。关闭密码时所有能到达服务的人可访问 Mira；HTTP 不加密，公网使用须自行配置 HTTPS 反向代理并设置精确 HTTPS public origin、保持 Host。External SDK 仍仅允许回环访问。没有自动开放端口、TLS、代理部署或新账户系统。
