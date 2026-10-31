# 浏览器回归测试

`pnpm build` 后安装 Chromium（`pnpm exec playwright install chromium`），运行 `pnpm test:e2e`。完整的安装、数据库与测试隔离说明见 [本地指南](../../docs/development/local-web.md#5-自动化测试)。

Playwright 在 127.0.0.1:3211 启动 `fixture-server.mts`，测试发送/恢复、模型设置、取消与冲突、桌面和窄屏布局。密钥用合成字符串覆盖密码框、留空保留、替换/移除、取消/重载清除、临时发现与目标绑定变更；检查 GET/保存响应和浏览器存储不含密钥。这里的四条合成对话只属于专用内存测试服务；正常 `pnpm start` 不会导入或预置这些消息，也不会连接这个 fixture。

`history-load.spec.ts` 使用真实 React/Playwright 交互与合成 HTTP 分页，覆盖首屏/中间空页、稀疏页与去重后的 50 条目标、每次 8 页上限、游标循环、部分失败重试、连续点击、同时轮询新消息、桌面/窄屏逐页滚动锚定及加载后引用跳转。运行 `pnpm exec playwright test --config tests/e2e/playwright.config.ts history-load.spec.ts`；仅 typecheck 或 `--list` 不算浏览器验收，不能代替 `pagination-real` 的真实 PostgreSQL 链路。

截图和失败 trace 输出到根目录 `test-results/`，已被 Git 忽略。测试不使用真实模型密钥或日常数据库；持久化与重启恢复由独立 PostgreSQL 测试覆盖。禁止将截图、运行数据或真实对话提交到此目录。

`pnpm test:external:e2e` 是独立、强制显式隔离 PostgreSQL 的真实链路 gate：生产本地 CLI 与私有凭据、SDK、HTTP、同一 service/writer、PG、WakeLoop/runtime 到实际浏览器 Timeline。仅模型 stream 为合成；没有 mock Timeline 或内存持久化。需要 `MIRA_TEST_DATABASE_URL` 和已安装 Chromium，不缺库跳过。配置为 `external-real.config.ts`，截图保存在 `test-results/external-real/`；CI 在原 UI fixture gate 后执行。

`pnpm test:management:e2e` 为独立真实管理链路 gate，同样强制隔离 PostgreSQL 与 Chromium。测试从设置 UI 提交记忆请求，核对实际 HTTP/Event/Wake、普通 read/edit 工具、Memory 文件、Git commit 与 lineage；关闭重开、重复点击、澄清不修改、运行记录、窄屏与重启冻结快照分别断言。另一条测试通过设置操作真实扩展启停/重载/配置/已有 stage 更新回滚，实际模型请求包含 ContextProvider，真实工具写入测试文件。模型 stream 为确定性合成，非真实模型质量验收。没有 route.fulfill、内存持久化或伪造工具完成；截图/trace 位于 `test-results/management-real/`。

`pnpm test:memory-reset:e2e` 为记忆重置真实 gate（ADR 0047）：生产 `MiraLifeHost` + HTTP + PostgreSQL + Memory Git，桌面与 390px 窄屏各执行一次“只清空长期记忆”（Git 提交、Timeline 通知）和忙碌中的“从头开始”（停止工作、归档、进程内重启、页面重新加载为空聊天、另一标签页自动刷新）。只模拟模型输出；截图位于 `test-results/memory-reset-real-screenshots/`。

`pnpm test:attachments:e2e` 是附件的独立真实链路 gate。使用隔离 PostgreSQL 18.6、真实 Chromium、生产 HTTP/service/runtime 与不可变附件目录；只有 provider 返回合成响应，不调用真实模型、不读取密钥。真实文件选择器、拖入与粘贴产生上传和 Event，多图顺序在实际 runtime 请求中断言；视频/PDF/Word 首先只保留文件引用，不自动解析。视频在首次提交及重启后都不自动注入；仅模型显式调用真实 read 后，支持的 Gemini 请求才收到该工具结果的原生视频数据。再次重启不重放 read，但保留工具结果可重新水合。实际 `send_attachment` 工具发布本地生成文件，再修改/删除源文件，核对受保护下载及重启后的稳定内容。重复/冲突 receipt、临时上传移除、失败重试、预览关闭/返回/Escape、桌面/窄屏截图与恢复都单列断言。不缺库跳过，不用 UI fixture 代替 PG。运行前 `pnpm build`，设置 `MIRA_TEST_DATABASE_URL`，安装 Chromium；截图/trace 在 `test-results/attachments-real/`。视频素材为合成有效 MP4，图片为有效 PNG，文档为最小有效 PDF/Word，均内嵌确定性测试素材，无外部下载。生产 Google SDK 的请求序列化另由 `tests/unit/model-video-transport.test.mts` 验证；本 gate 不代表 live 视频质量验收。

`pnpm test:live-input:e2e` exercises ordinary sends through real Chromium, HTTP,
PostgreSQL, Pi runtime and actual bash effects. It verifies request cancellation,
one-tool rather than batch latency, unstarted sibling suppression, duplicate
receipts and restart; only model output is scripted. Evidence is written beneath
`test-results/live-input-real/`. Requires the same isolated test database.

`pnpm test:capabilities:e2e` verifies the combined features in one real
Chromium → HTTP → PostgreSQL → runtime chain: a fresh child discovers and reads
an official skill, a reminder becomes due while a real bash tool is active,
child completion also queues, and an ordinary user send steers before the next
sibling tool. The next Wake consumes reminder and child result together, and
service restart repeats neither effects nor receipts. Main Memory stays intact
and child transcripts never create main Memory checkpoints. Only provider output
is synthetic; desktop/narrow screenshots live in `test-results/agent-capabilities-real/`.

The capabilities gate also tests oversized extension output through the actual
runtime text budget, complete persisted outcome and ordinary `read` line pages.
After a service restart it reconstructs a deleted disposable spool file from PG
without executing the extension again. Desktop/narrow screenshots use the same
`test-results/agent-capabilities-real/` directory. This does not replace the
fresh-process PG crash tests or establish live-provider behavior.

`pnpm test:auth:e2e` 从默认无密码开始，经真实 HTTP/PG/service 与不可变附件存储启用密码、错误登录、成功登录、改密、注销、重启与关闭，使用显式非loopback浏览器hostname（只解析到隔离回环listener，不部署公共服务）。私有API和附件未登录均需401，桌面与窄屏实际截图在 `test-results/auth-real/`。改密竞态段只在测试服务器 onSend 暂时持有实际 PUT/Set-Cookie 响应，让浏览器旧 cookie 轮询由生产鉴权返回真实 401，验证私有 DOM 立即撤下、迟到成功响应安全恢复。响应延迟是测试安排，不冒充自然网络故障；没有 route.fetch 转发或伪造 401。其余登录/凭据/附件路径为生产实现，模型为合成。保留首次失败截图与trace。

`pnpm test:feishu:e2e` joins the official Feishu SDK HTTP/WS fixtures, generic extension settings/QR/owner pairing, real PostgreSQL Event/Wake, model tool execution, restart deduplication and Web Timeline. It captures desktop/narrow QR and sourced-message screenshots, including a non-Feishu ordinary plugin. Only transport/model fixtures are synthetic; it never creates a real app, grants permissions or uses live credentials. Missing PostgreSQL/browser support fails this gate rather than claiming a live Feishu test.

扩展设置的通用动作分组分别由 HTTP fixture 与真实管理链路覆盖。未标组和 primary 动作直接显示，secondary 与编辑入口置于默认收起的“更多操作”；折叠不隐藏取消。真实 settings-fixture 扩展通过 visibleActions 在连接、断开和 pending 间切换，走真实 Host 过滤、HTTP 与浏览器；桌面收起态和窄屏展开态截图保留在 management-real 的 CI 产物中。fixture 另测键盘展开、编辑中折叠、关闭/返回清空草稿、重复启动、重开取消和未知结果核对。

`pnpm test:replies:e2e` runs the reply acceptance chain through real Chromium,
HTTP, PostgreSQL and the production runtime. Only model output is scripted.
It requires the same isolated `MIRA_TEST_DATABASE_URL` and installed browser;
missing services fail rather than skip. Synthetic desktop/narrow screenshots
are written beneath `test-results/replies-real/`, never committed as source.

`pnpm test:pagination:e2e` seeds sparse visible messages among hidden events in
isolated PostgreSQL and exercises the production service, HTTP route and React
UI. One click must add 50 visible messages with one POST for this sample. It
records real driver connection counts, request durations and desktop/narrow
screenshots in `test-results/pagination-real/`. No live model or account is used;
missing database/browser support fails the gate rather than substituting mocks.
The far-quote case verifies the stretch from the located message through the
newest page, then explicitly reads the separate older-history frontier before
asserting that every seeded message is present exactly once.
