# Mira

一个持续存在、拥有长期记忆、能够不断扩展能力的个人智能体。

Mira 把与你的对话、共同经历和正在做的事保留在同一条时间线上。你可以和它闲聊，也可以交给它实际任务；关掉页面再回来，继续和同一个 Mira 相处。

这份连续性也服务于更丰富、细腻的情感表达。Mira 的设计重视自身的个性与反应，让情绪和对你的理解随交流自然延续，让关系在共同经历中逐渐发展。

![Mira 聊天界面，一条持续的时间线](docs/assets/mira-chat.png)

## 可以做什么

- **持续陪伴的个人智能体**。保留对话和工作上下文，支持重启恢复与自动压缩。外部事件或已安排的唤醒也能让 Mira 继续处理事情，是否联系你由它结合当前情境判断。
- **能够自行整理的记忆**。Mira 用普通文件记住你的偏好、重要经历与长期理解，并通过 Dreaming 在符合触发条件时整理记忆。你可以查看、编辑这些文件，独立 Git 保留变更，需要核对细节时还能查询原始历史。
- **有个性、有变化的交流**。提示词鼓励 Mira 表达兴趣、疑虑、幽默和不同意见，也关注交流中的情绪变化。近期反应随上下文延续，重要的关系理解可以进入长期记忆；具体表现取决于所用模型与实际互动。
- **自然流畅的使用体验**。一条时间线承接日常聊天与任务，支持发送附件，处理任务时也能补充要求或调整方向。Mira 会在生成请求让出或当前工具执行完成后接入新输入；工具与子任务详情放在设置的运行记录中，主聊天保持简洁。
- **可不断扩展的行动能力**。内置文件、搜索、Shell 与跨轮次终端工具，可委派独立上下文的子代理，按需使用文档、转写、浏览器和联网 Skills。Cordis 管理手工与生成扩展，支持增加工具、事件来源和上下文；External SDK 还能让本机程序接入同一条时间线。
- **自己的模型与数据**。在网页设置中选择模型、配置 API Key 或自定义连接，管理 Memory、扩展与历史，也可设置共用网页密码。

终端进程可跨对话轮次保留，但不跨服务重启恢复。Skills 提供说明和必要脚本，浏览器、OCR 等依赖按需准备；附件的处理能力取决于模型与工具。[按需工具说明 →](docs/development/runtime-tools.md)

## 快速开始

需要 Git、**Node.js 24.19.0–24.x**、**pnpm 11.28.4** 和本机 PostgreSQL。CI 使用 Node 24.21.0 与 PostgreSQL 18.6。Linux 的 PTY 构建还需要 Python 3、make 和 C++ 编译器；终端支持 Linux/macOS。

安装前请确认这是可信的个人运行环境：Shell 和扩展使用宿主账户权限，没有产品级沙箱。

先按[本地安装指南](docs/development/local-web.md)创建独立的 `mira` 数据库和用户，并设置数据库认证。然后运行：

```sh
git clone https://github.com/contrueCT/mira.git
cd mira
pnpm install --frozen-lockfile --ignore-scripts
pnpm terminal:prepare

# 数据库认证按安装指南设置，不要把密码写入仓库或连接 URL
MIRA_DATABASE_URL=postgres://mira@127.0.0.1:5432/mira pnpm start
```

打开 `http://127.0.0.1:3210`，在右上角设置中选择模型并保存 API Key，即可发送消息。新数据库从空时间线开始，不会载入截图中的演示对话。

- [完整安装、启动与故障排查](docs/development/local-web.md)
- [模型目录、自定义连接与推理强度](docs/development/models.md)
- [无需模型调用的独立模拟环境](docs/development/local-web.md#4-手动模拟与日常数据分开)

## 数据与执行边界

请在可信的个人环境中使用。**文件、Shell 和扩展以宿主 OS 账户身份运行，没有产品级沙箱，也没有独立的工具审批引擎。** 模型根据对话和提示词判断操作或澄清；工作目录和 Cordis 都不是权限边界。

- 数据库、Memory、生成扩展、日志和凭据保存在源码仓库之外。`MIRA_HOME` 默认是 `~/.mira`；不要提交或公开自己的聊天、配置和运行数据。
- API Key 以明文保存在私有 `models.json`，通过文件权限保护，网页不会回填。它不是加密保险箱；同一 OS 账户下的工具与扩展可能读取它。
- 使用远程模型会向所选服务商发送模型请求，并可能产生费用。自定义远程连接应使用 HTTPS。
- 默认只监听 `127.0.0.1`，网页密码默认关闭。可选网页密码不提供传输加密；局域网或公网访问需自行配置访问边界，公网还需 HTTPS 反向代理。[访问配置 →](docs/adr/0033-web-password-access.md)
- 工具执行结果不明时会保留事实，不自动重放。上下文恢复不意味着外部副作用可以撤销。

## 了解实现

TypeScript monorepo，Web 使用 React/Vite 与 Fastify，运行时接入 Pi，持久化使用 PostgreSQL，扩展生命周期由 Cordis 管理。

| 路径 | 职责 |
| --- | --- |
| `apps/web`、`apps/server` | 聊天页面、设置、API 与启动组装 |
| `packages/life`、`packages/context` | 事件、唤醒队列、单主认知循环与连续上下文 |
| `packages/cognition`、`packages/runtime-pi` | Runtime 契约、模型执行与压缩 |
| `packages/persistence`、`packages/workspace` | PostgreSQL 历史、普通记忆文件与 Memory Git |
| `packages/extension-sdk`、`packages/extension-host` | 扩展契约与生命周期 |
| `packages/external-sdk` | 本机外部程序接入 |
| `tests`、`docs` | 回归测试、设计、决策与验收记录 |

- [架构概览](docs/architecture.md) · [完整设计 v0.5](docs/design/architecture-v0.5.md) · [实际 System Prompt v0.2](packages/runtime-pi/prompts/mira-system-v0.2.md)
- [扩展开发](packages/extension-host/README.md) · [External SDK](packages/external-sdk/README.md)
- [工具链与检查命令](docs/development/toolchain.md) · [测试指南](docs/development/local-web.md#5-自动化测试)
- [开发约束](docs/development/rules.md) · [开发指引](AGENTS.md) · [决策记录](docs/adr/README.md)

## 许可证

Mira 的原创代码采用 [MIT License](LICENSE)。随仓库分发的第三方内容保留各自许可，不因根目录许可证而改变：[OpenAI 文档](skills/doc/LICENSE.txt)、[PDF](skills/pdf/LICENSE.txt)与[转写技能](skills/transcribe/LICENSE.txt)、[agent-browser](skills/agent-browser/LICENSE)、[扩展作者技能引用](skills/mira-extension-authoring/LICENSE.deepseek)。来源和修改记录见[上游清单](skills/upstream-sources.json)，依赖包遵循各自许可证。

## 致谢

- [Pi](https://github.com/earendil-works/pi) 提供了 Mira 使用的模型运行时、工具和上下文压缩基础。
- [OpenAI Codex](https://github.com/openai/codex)，Mira 参考了相关功能实现。
