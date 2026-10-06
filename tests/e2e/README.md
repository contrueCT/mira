# 浏览器回归测试

`pnpm build` 后安装 Chromium（`pnpm exec playwright install chromium`），运行 `pnpm test:e2e`。完整的安装、数据库与测试隔离说明见 [本地指南](../../docs/development/local-web.md#5-自动化测试)。

Playwright 在 127.0.0.1:3211 启动 `fixture-server.mts`，测试发送/恢复、模型设置、取消与冲突、桌面和窄屏布局。密钥用合成字符串覆盖密码框、留空保留、替换/移除、取消/重载清除、临时发现与目标绑定变更；检查 GET/保存响应和浏览器存储不含密钥。这里的四条合成对话只属于专用内存测试服务；正常 `pnpm start` 不会导入或预置这些消息，也不会连接这个 fixture。

截图和失败 trace 输出到根目录 `test-results/`，已被 Git 忽略。测试不使用真实模型密钥或日常数据库；持久化与重启恢复由独立 PostgreSQL 测试覆盖。禁止将截图、运行数据或真实对话提交到此目录。
