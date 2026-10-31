# Server 组装入口

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 组装假 provider、持久化、WakeLoop、Pi 通用文件/search/bash、Mira 固定范围历史查询、可选 Memory 与手工/生成扩展生命周期；`pnpm demo --help` 为 CLI 入口。`web-service.ts` 复用同一运行时，`http.ts` 提供严格同源 Fastify API，`web-cli.mts` 为本地启动。
- `src/model-catalog.ts` / `model-config.ts` / `model-discovery.ts` / `model-transport.ts` 负责 Pi 目录、独立显式密钥引用、受限模型发现和注入 runtime 的 transport；`pnpm models --help`，见 [模型说明](../../docs/development/models.md)。目录不是凭据状态，发现不猜 token 限额。
- `src/extensions.ts` 绑定事件来源、把 SDK 工具映射到普通 Pi schema/intent/outcome 与来源路径，并提供 stage 与直接等待应用的生命周期管理工具
- `dreaming.ts` 提供普通整理指令和单 timer；`web-service.ts` 只在空闲、无错误、有 Memory/模型时调用 DreamingWriter，关闭需等待在途检查，见 ADR 0018。不得把 timer 变成清错/自动重试路径。
- `management.ts` / `management-http.ts` / `management-projections.ts` 提供 Memory、扩展与运行历史只读投影及同一宿主生命周期管理；配置 write-only、expectedRevision 队列内核对，历史不返回工具原始参数/结果或推理，详见本目录 README。
- 本目录负责 API、技术来源边界、启动和依赖组装；框架为 Fastify。没有账号系统或工具批准 UI。

## 本地约束与跨包陷阱

- 在这里连接核心契约与具体适配器；不要让 life/context 反向导入 server
- API 必须区分 emit event 与 request wake，并在边界验证不可信输入
- cwd 只是默认位置，无应用目录限制或产品隔离环境；主模型通过自然语言 Prompt/对话决定调用或澄清，不注入 authorize 或合成批准证据
- 完整 Mira Prompt 必须到达实际请求，包括无 Memory 和当前上下文恢复；`loadMemory` 在初始化及压缩刷新时读取当前 Memory；普通请求/重启沿用最新持久快照，不得变成每 Wake 重读/重注入或文件变更通知；自动压缩沿用 runtime 默认预算，见 ADR 0016
- `skills.ts` 按顺序仅加载源码 `skills/`、`${MIRA_HOME}/skills`（默认 `~/.mira/skills`）、运行用户 `os.homedir()` 下的 `~/.agents/skills`，使用 Pi 显式路径及 `includeDefaults:false`；同名首项优先并报告诊断、真实路径去重、缺失目录为空。`MIRA_HOME` 不重定位全局目录，`MIRA_CWD` 不引入项目/祖先扫描，不默读 `.agent` / `.pi`。主与 child 每自然请求刷新元数据，正文普通 read 按需读取
- ADR 0024：普通 Web submit 使用 receiveLiveInput，先持久补充输入再让出模型请求；当前单工具不取消，HTTP receipt 不代表模型已读。外部 ingress 继续普通 receive，不加停止/暂停按钮。
- 启动恢复、停机和错误处理不能生成第二个活跃认知写者
- 持久化故障只通过现有 status/HTTP 显示固定临时 notice，明确无诊断落库承诺；仅接受可信实例标签，普通错误仍受保护，不添加工具 chip/trace 或成本字段
- Web CLI 默认通过 `web-extensions.ts` 初始化/读取 `${MIRA_HOME}/extensions.json` 与 artifact store，管理工具默认可用；已有文件不覆盖，显式 `MIRA_EXTENSIONS` 错误不回退。初始化不安装或激活新代码，程序化/演示入口仍使用显式扩展选项

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。`pnpm demo --help` 和 `node apps/server/src/web-cli.mts --help` 离线验证入口；数据库演示由恢复集成测试覆盖。此 Pi 消费项目进入 tsconfig.pi.json，Mira 源码仍严格检查。

## 本地 Web

按 ADR 0033 默认 127.0.0.1，可显式 MIRA_HOST=0.0.0.0 与 MIRA_PUBLIC_ORIGIN；精确 Host、Origin 和请求头检查不可放宽为通配。可选网页密码统一保护私有 API/附件；HTTP 来源防护不等于自然语言工具授权。Web 模型设置接收 write-only API Key，源码外的私有文件保存明文密钥并限制权限；公开响应仅返回 hasApiKey。禁止密钥进入日志、数据库、Prompt 或历史。CLI 仍使用显式环境变量引用；revision 冲突不能静默覆盖。Timeline 只返回白名单展示字段，不发送 system/thinking/原始工具参数。界面通过确定性 fixture 测试，真实 PostgreSQL 恢复单独验收。

## External SDK 接入

见 ADR 0017。`external-http.ts` 和 `http.ts` 在既有 127.0.0.1 listener 上提供三条 `/api/external/*` 路由，Web 同源规则不变。外部请求拒绝浏览器来源，逐次校验 sender/token；`external-access.ts`/`external-access-cli.mts` 管理源码、Memory、artifacts 外的私有配置，默认关闭、CLI 无 token 输出、下次认证生效。`external-ingress.ts` 绑定 external 来源并使用同一 writer；事件与 Wake 保持完整不可变信封。sendNotification 仅保存并投影带来源/时间的 notice，不发模型请求。Secrets 不进入 Event/Context/日志；普通 Shell 与同 OS 账户边界不变。

- `scheduling.ts` 是独立单次UTC投递组装与timer，使用同一fenced writer和Event/Wake队列；不停/重试失败认知、不改Dreaming。日期/时区/提醒策略仅在扩展，见ADR 0022。
- 组合边界：child wait 查询当前已claim run 的持久 pending input 并监听已提交提示，补 intent→execute 空窗；child completion 与调度都只入普通队列，后台结果不清除失败主轮。child skills 仅独立元数据及普通 read，不能注入主persona/Memory。

- ADR 0027：configuration.defaultThinkingLevel 只保存用户默认偏好；transport.thinkingLevel 是 Pi 能力适配后的 runtime 注入值。主/child/Dreaming 同路；压缩独立最低档，不在 streamFn 隐式填会话默认，Anthropic 思考与答案共同受原输出 cap 限制。

- ADR 0033：web-auth.ts 管理独立网页密码 hash 与短期 cookie；External SDK 继续实际 loopback 地址+Host 限制，不跟随 Web 暴露。
- ADR 0032：`terminals.ts` service级registry、`terminal-process.mts`随主进程IPC生命周期监督；工具闭包按stream绑定owner，不给模型owner参数。普通bash不变，关闭服务须清理终端；取消等待不等于杀进程，异常不重放。

- ADR 0034：browser-manager/driver/tools 负责受管 daemon、owner 与命令队列；显式路径优先，其次发现服务 miraHome/tools 标准安装，无自动下载；Chrome 显式启动路径优先，每次新 open 在 Linux 检查已安装官方 Chrome，再沿用上游发现，不读取 CLI config 或失败后换浏览器重试；browser-http 只代理登记的 loopback stream，独立严格 WebSocket 鉴权与一次票据。人工输入/帧不进历史；注销/改密/关闭撤销。
- ADR0035：扩展私有设置路由复用全部Web鉴权，secret仅写入；模型inspect仅暴露settings固定state/code，不暴露details/授权链接/凭据。异常文字脱敏但保留unknown-outcome恢复语义。
- writer ownership abort与显式close共用joinable清理；先fence/cancel再并行drain，任一cleanup失败不跳过其他资源/关闭writer。CLI同样绑定Host ownerSignal；unknown副作用不自动重放。

- ADR 0041：发现只导入明确且有效的能力元数据；custom reasoningFormat 只适用 Chat Completions；设置探针最多两个 Pi 请求，仅明确参数拒绝换格式；LiteLLM 依主错误提示选择固定 reasoning_effort 允许列表，失败/取消不保存、不改主轮错误；正常聊天不探测。


- Timeline replies: `replies.ts` resolves only same-Mira public main messages by canonical History UUID. Browser submits only `replyToMessageId`; frozen quote/source joins immutable Event/live input. Main-only `send_reply` publishes through successful durable tool outcome, never a channel send or mutable next-response flag. Both Timeline HTTP routes whitelist `reply`; child/internal/notice records remain unavailable as targets.

- Web spool 写入显式使用 `miraHome` 为私有 managed data root，默认 `~/.mira/wake-input` 可存放输入及附件/回复索引；必须严格包含 spool，不能是 HOME/其祖先或与源码互相包含，保留链接、所有者和不可变发布保护。demo 仍要求显式源码/HOME 外 spool。
- 记忆重置（ADR 0047）：`life-host.ts` 的 `MiraLifeHost` 持有当前 `LocalWebService`、预检令牌与 `MIRA_HOME/reset-journal.json`；HTTP 只经委托 backend 访问服务，重置期间返回 503。改动重置步骤时同步更新崩溃注入测试 `tests/recovery/memory-reset-service.test.mts`；旧生命只经 `pnpm life` 命令行恢复。
- 用量与余额暂停（ADR 0048）：`usage-http.ts` 只投影 token/请求数，禁止费用字段；余额分类只认 402 与 `model-errors.ts` 的 `balanceErrorCodes`，不匹配文本。`web-service.ts` 的 `#kick(source)` 在暂停时拒绝一切非 `'user'` 来源；新增唤醒入口必须走默认 `'system'` 来源。改动见 `tests/recovery/balance-pause.test.mts`。
- 前台时限与后台作业（ADR 0049）：`background-jobs.ts` 只写追加事件（started 不唤醒；settled/lost 共用 `["tool-background-result", jobId]`）；运行状态只经 `runtimeStatus` 进入模型输入，禁止投影到时间线或状态接口。NO_REPLY 与「已读」（ADR 0050）：`visible()` 用 `isNoReply`，`#markRead` 每次读取计算、不缓存。
