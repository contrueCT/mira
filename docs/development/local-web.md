# 本地 Mira Web

## 启动

先安装 Node 24、pnpm 11.28.4，并准备独立的本地 PostgreSQL 数据库。Mira 不创建、清空或重置数据库；启动会执行当前向上迁移。

```sh
pnpm install --frozen-lockfile --ignore-scripts
MIRA_DATABASE_URL=postgres://localhost/mira pnpm start --synthetic
```

这是一条启动命令：先构建前端，再启动 Fastify，默认打开 `http://127.0.0.1:3210`。`--no-open` 仅打印地址；`--port 3211` 更改固定端口。`pnpm start --help` 查看帮助。停止用 Ctrl+C，保留数据库和 Memory。

`--synthetic` 经过真实持久化主循环返回确定性模拟回复，不调用外部模型。省略该参数为 live 模式：先打开设置，选择模型和显式 API Key 环境变量名；把对应变量安全地设置在启动进程的终端环境中。密钥不输入网页，不写入源码或配置文件。此批开发/CI 未执行真实模型调用。

## 数据与配置

- `MIRA_DATABASE_URL`：必需的 localhost PostgreSQL URL，明确数据库名，不接受 URL 查询选项
- `MIRA_HOME`：默认 `~/.mira`，必须在源码仓库外；包含 `models.json`、`memory/` 独立 Git 与 `wake-input/`
- `MIRA_SCHEMA`：默认 `mira`；请给本应用独立 schema，不指向已有无关应用表
- `MIRA_CWD`：默认启动目录，仅普通工具工作目录，不是沙箱
- `MIRA_EXTENSIONS`：可选的可信本地扩展配置文件，沿用现有生命周期；没有额外安装器或管理 UI

固定 Mira ID 为 `mira`。不要让两个进程抢占同一实例；数据库单写者会拒绝第二个。Memory bootstrap、持久 Prompt、历史、工具结果不因刷新/重启被清空。

模型设置保存在 `MIRA_HOME/models.json`，内容为 `{configuration, selection}`。`configuration` 复用 [现有模型配置](models.md)，`selection` 为内置或自定义模型选择。网页使用 revision 防止覆盖另一窗口或外部编辑；冲突需重载。空闲时读取设置会采用磁盘上的新版本；处理中仍显示并保留当前运行配置。设置写入不验证真实模型联通。正在运行的 Wake 不允许改配置；live 空闲保存后下一条消息生效，synthetic 模式仍需重启才能切到 live。

## HTTP 与展示

所有 API 在同源 `/api/` 下。API 请求需要 `X-Mira-Client: web`；写请求还需精确 Origin 和 JSON。仅监听 IPv4 回环，不支持 `localhost` Host 别名、跨域、远程代理或公网访问。错误不回显原始异常、供应商响应或凭据。

Timeline 展示用户 web.message 与 Pi assistant 的 text blocks，隐藏 thinking/system/原始工具数据。工具只显示名称和已知状态，结果未知不伪装成失败或完成。浏览器收到持久 receipt 后仍等待后续完整回复，不提供 token streaming。

历史按稳定游标向前读取，时间异常的已存记录仍保留，并按明确 fallback 顺序分页，详见 persistence README。单条历史读取最多 1 MiB，过大记录显示保留提示而非泄露/静默截断。首页使用 GET；向前翻页使用只读 POST JSON 请求体携带不超过 524288 字符的游标，避免大型历史 ID 超过 URL/请求头上限。

浏览器 sessionStorage 只保存当前不确定提交的 ID/正文/时间；确认落库后清除。断网不自动重发。显式“核对并重试”使用同一 envelope；服务端 duplicate 不重启 cognition。

## 验证命令

```sh
pnpm check
MIRA_TEST_DATABASE_URL=postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

浏览器测试使用明确 fixture 服务，只有合成消息，不访问用户数据库或模型。真实 persistence/restart/cancellation 单独在 PostgreSQL 测试验证。需要系统浏览器时可显式设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`；不能借此绕过执行环境禁止的 socket/进程操作。CI 使用官方 Chromium 和 PostgreSQL 服务。
