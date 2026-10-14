# 浏览器回归测试

`pnpm build` 后安装 Chromium（`pnpm exec playwright install chromium`），运行 `pnpm test:e2e`。完整的安装、数据库与测试隔离说明见 [本地指南](../../docs/development/local-web.md#5-自动化测试)。

Playwright 在 127.0.0.1:3211 启动 `fixture-server.mts`，测试发送/恢复、模型设置、取消与冲突、桌面和窄屏布局。密钥用合成字符串覆盖密码框、留空保留、替换/移除、取消/重载清除、临时发现与目标绑定变更；检查 GET/保存响应和浏览器存储不含密钥。这里的四条合成对话只属于专用内存测试服务；正常 `pnpm start` 不会导入或预置这些消息，也不会连接这个 fixture。

截图和失败 trace 输出到根目录 `test-results/`，已被 Git 忽略。测试不使用真实模型密钥或日常数据库；持久化与重启恢复由独立 PostgreSQL 测试覆盖。禁止将截图、运行数据或真实对话提交到此目录。

`pnpm test:external:e2e` 是独立、强制显式隔离 PostgreSQL 的真实链路 gate：生产本地 CLI 与私有凭据、SDK、HTTP、同一 service/writer、PG、WakeLoop/runtime 到实际浏览器 Timeline。仅模型 stream 为合成；没有 mock Timeline 或内存持久化。需要 `MIRA_TEST_DATABASE_URL` 和已安装 Chromium，不缺库跳过。配置为 `external-real.config.ts`，截图保存在 `test-results/external-real/`；CI 在原 UI fixture gate 后执行。

`pnpm test:management:e2e` 为独立真实管理链路 gate，同样强制隔离 PostgreSQL 与 Chromium。测试从设置 UI 提交记忆请求，核对实际 HTTP/Event/Wake、普通 read/edit 工具、Memory 文件、Git commit 与 lineage；关闭重开、重复点击、澄清不修改、运行记录、窄屏与重启冻结快照分别断言。另一条测试通过设置操作真实扩展启停/重载/配置/已有 stage 更新回滚，实际模型请求包含 ContextProvider，真实工具写入测试文件。模型 stream 为确定性合成，非真实模型质量验收。没有 route.fulfill、内存持久化或伪造工具完成；截图/trace 位于 `test-results/management-real/`。

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
