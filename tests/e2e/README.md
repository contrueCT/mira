# 浏览器回归测试

`pnpm build` 后安装 Chromium（`pnpm exec playwright install chromium`），运行 `pnpm test:e2e`。完整的安装、数据库与测试隔离说明见 [本地指南](../../docs/development/local-web.md#5-自动化测试)。

Playwright 在 127.0.0.1:3211 启动 `fixture-server.mts`，测试发送/恢复、模型设置、取消与冲突、桌面和窄屏布局。密钥用合成字符串覆盖密码框、留空保留、替换/移除、取消/重载清除、临时发现与目标绑定变更；检查 GET/保存响应和浏览器存储不含密钥。这里的四条合成对话只属于专用内存测试服务；正常 `pnpm start` 不会导入或预置这些消息，也不会连接这个 fixture。

截图和失败 trace 输出到根目录 `test-results/`，已被 Git 忽略。测试不使用真实模型密钥或日常数据库；持久化与重启恢复由独立 PostgreSQL 测试覆盖。禁止将截图、运行数据或真实对话提交到此目录。

`pnpm test:external:e2e` 是独立、强制显式隔离 PostgreSQL 的真实链路 gate：生产本地 CLI 与私有凭据、SDK、HTTP、同一 service/writer、PG、WakeLoop/runtime 到实际浏览器 Timeline。仅模型 stream 为合成；没有 mock Timeline 或内存持久化。需要 `MIRA_TEST_DATABASE_URL` 和已安装 Chromium，不缺库跳过。配置为 `external-real.config.ts`，截图保存在 `test-results/external-real/`；CI 在原 UI fixture gate 后执行。

`pnpm test:management:e2e` 为独立真实管理链路 gate，同样强制隔离 PostgreSQL 与 Chromium。测试从设置 UI 提交记忆请求，核对实际 HTTP/Event/Wake、普通 read/edit 工具、Memory 文件、Git commit 与 lineage；关闭重开、重复点击、澄清不修改、运行记录、窄屏与重启冻结快照分别断言。另一条测试通过设置操作真实扩展启停/重载/配置/已有 stage 更新回滚，实际模型请求包含 ContextProvider，真实工具写入测试文件。模型 stream 为确定性合成，非真实模型质量验收。没有 route.fulfill、内存持久化或伪造工具完成；截图/trace 位于 `test-results/management-real/`。
