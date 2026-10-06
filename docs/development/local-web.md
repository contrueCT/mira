# Mira 本地安装、使用与测试

以下终端示例使用 **Bash**（macOS/Linux 可先运行 `bash`，Windows 可用 WSL）。CI 实际验证 Linux；没有宣称完成所有操作系统或真实模型验收。

## 1. 准备与安装

需要 Git、Node.js 24、pnpm 11.28.4，以及已启动的本地 PostgreSQL。CI 固定 Node 24.21.0（见 `.node-version`）和 PostgreSQL 18.6；Node 兼容范围是 `>=24.19.0 <25`。PostgreSQL 安装与启动方式按自己的系统选择 [官方安装包](https://www.postgresql.org/download/)。

```sh
node --version
npm install --global pnpm@11.28.4
pnpm --version

git clone https://github.com/contrueCT/mira.git
cd mira
pnpm install --frozen-lockfile --ignore-scripts
```

这是私有仓库，克隆需要自己的 GitHub 访问权限；不要把 token 填进仓库 URL。已有 checkout 不需重复 clone。依赖安装脚本保持禁用。

## 2. 创建日常使用的数据库

先确认 PostgreSQL 服务已启动，监听本机。用已有管理员角色进入 `psql`；下面的 `postgres` 若不是你安装时的管理员名，请替换为实际角色：

```sh
psql --host=127.0.0.1 --port=5432 --username=postgres --dbname=postgres
```

在 `psql` 里一次性执行，给 Mira 独立的非超级用户和数据库：

```sql
CREATE ROLE mira LOGIN;
\password mira
CREATE DATABASE mira OWNER mira;
\q
```

`\password` 会交互要求密码，不把密码直接写进 SQL 历史。角色/数据库已存在时先确认归属，不要删除重建。对应官方说明：[创建角色](https://www.postgresql.org/docs/18/sql-createrole.html)、[创建数据库](https://www.postgresql.org/docs/18/manage-ag-createdb.html)。

回到 Bash，交互读取刚才设置的数据库密码，并检查连接：

```sh
read -r -s -p 'Mira 数据库密码: ' PGPASSWORD; printf '\n'
export PGPASSWORD
export MIRA_DATABASE_URL='postgres://mira@127.0.0.1:5432/mira'
psql "$MIRA_DATABASE_URL" -c 'SELECT current_database(), current_user;'
```

密码不写进 URL 或仓库。驱动会使用 `PGPASSWORD` 补充未在 URL 指定的密码，见 [node-postgres 连接说明](https://node-postgres.com/features/connecting)。环境变量仍属于本机进程的敏感数据，只在可信的个人电脑上使用；不要输出或粘贴完整环境。Mira 退出后可 `unset PGPASSWORD`。

## 3. 正常启动与模型设置

```sh
pnpm start
```

这条命令构建前端、启动 Fastify 并打开 `http://127.0.0.1:3210`。新数据库没有示例对话，已有数据库恢复自己的历史。数据库/模型尚未配置不代表已连接：第一次先在右上角打开模型设置。

在网页右上角打开模型设置，选择服务商和模型，在密码式 **API Key** 输入框直接粘贴密钥并保存。不需要先设置模型密钥环境变量，也不需要为了换 Key 重启服务；空闲时保存后下一条新消息使用新配置。

已保存的 Key 只显示“已保存”状态，不会回填到输入框。留空保留当前 Key；输入新 Key 替换；点击清除并保存会移除 Key。取消或关闭设置丢弃未保存的输入。清除 Key 后需要重新配置才能发起真实模型调用。

自定义连接填写服务地址、协议与 API Key。Key 绑定当前连接及其地址/协议/模型发现地址，改变这些目标后旧 Key 不会自动带往新目标，需要重新输入。点击“获取可用模型”会使用本次输入的 Key 或该目标已保存的 Key；发现本身不保存新 Key。模型发现仅返回候选 ID/名称；上下文窗口、最大输出、推理/输入能力仍需根据服务商资料明确填写，也可手动输入模型 ID。详细限制见 [模型配置与发现](models.md)。

保存/浏览内置目录不发模型请求；发现会向配置的服务发送 Key。发送真实消息或恢复已排队 Wake 可能调用模型并产生费用，本批尚未验证真实模型效果。远程服务请使用 HTTPS，HTTP 不加密模型请求或密钥。

其他启动方式：

```sh
pnpm start --no-open
pnpm start --port 3212
node apps/server/src/web-cli.mts --help
```

`--no-open` 仍启动服务，仅不自动开浏览器。地址要使用打印出的 `127.0.0.1`，不改成 `localhost`。Ctrl+C 停止服务并保留数据；重新启动继续同一个 Mira，待处理 Wake 会按既有恢复规则继续，未知工具结果不会自动重放。

### Timeline 与模型输入

普通 Timeline 仅显示用户/助手文本、必要通知与总体处理中状态，不显示工具名称、工具状态或活动卡片。`GET /api/timeline` 与用于旧页的 `POST /api/timeline` 仅返回 `items`、`nextCursor`；后端不为页面额外读取工具活动。模型工具仍正常执行，原始调用/结果、intent/outcome、历史和合法协议配对完整保存，不能把隐藏界面理解为停止工具。

送给模型的普通 Web 用户消息使用来源、原始时间与未裁剪原文，不附重复的固定 Wake 原因、类型和传输 ID。其它事件保留有意义的原因、类型、事件 ID，以及完整任意 JSON payload。积累消息仍合并为一个 Wake；超限普通文件保存完全相同的精简文本，按需使用普通文件工具读取。

### Wake 输入布局升级注意

本次从请求信封 JSON 改成精简文本，不维护旧布局解析或迁移。若旧版本的活动 Wake 已持久化旧输入或生成旧 overflow 文件，但尚无 final，新版本重新渲染后会被既有输入/文件一致性检查拒绝。发布切换前应先在生成该 Wake 的原版本、原配置下完成未结束任务；不能靠删除记录、重置数据库或关闭一致性检查绕过。若原版本无法完成，升级处理需单独确认。

同一当前版本的普通重启、未完成 Wake 恢复、丢失 overflow 文件重建仍受支持。已完成历史原样保留；已有 final 的 Wake 继续按原恢复路径验证并完成，不重新生成模型输入。

## 4. 手动模拟：与日常数据分开

`--synthetic` 不调用模型，但**会真实保存你发送的消息和模拟回复**。切回 live 不会删除它们。因此不要在日常数据库上试跑后期待自动清空。

用数据库管理员另建 `mira_demo`（所有者仍可为 `mira`）：

```sql
CREATE DATABASE mira_demo OWNER mira;
```

然后在已设置对应 `PGPASSWORD` 的 Bash 中运行：

```sh
MIRA_DATABASE_URL='postgres://mira@127.0.0.1:5432/mira_demo' \
MIRA_SCHEMA=mira_demo \
MIRA_HOME="$HOME/.mira-demo" \
pnpm start --synthetic --port 3211
```

日常模式使用数据库 `mira`、默认 `~/.mira`、端口 3210；上述模拟使用不同数据库、Memory/配置目录和浏览器 origin。停止模拟后，按第 3 节的日常配置启动即可。不要把 demo 的数据库或 Memory 拷入日常实例。

## 5. 自动化测试

### 离线检查

```sh
pnpm check
```

包含五套严格 TypeScript 检查、包边界、后端/前端离线测试与构建。不需要数据库或模型密钥。

### PostgreSQL 集成与恢复

只能使用明确的 localhost **mira_test** 数据库。测试会创建并删除自己的唯一 schema，不能指向日常数据。可用已安装且运行的 Docker 启动专用测试实例，密码是公开的合成测试值，不用于日常数据库：

```sh
docker run --detach --name mira-test-postgres \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_DB=mira_test \
  --env POSTGRES_USER=mira_test \
  --env POSTGRES_PASSWORD=synthetic-ci-only \
  postgres:18.6

docker exec mira-test-postgres pg_isready -U mira_test -d mira_test
```

等到 `pg_isready` 显示接受连接，再执行：

```sh
MIRA_TEST_DATABASE_URL='postgres://mira_test:synthetic-ci-only@127.0.0.1:55432/mira_test' pnpm test:integration
# 或合并离线检查与真实数据库检查
MIRA_TEST_DATABASE_URL='postgres://mira_test:synthetic-ci-only@127.0.0.1:55432/mira_test' pnpm check:all
```

测试 runner 不继承 `PGPASSWORD` 或模型密钥，所以测试 URL 明确包含仅供测试的认证。容器名已存在时用 `docker start mira-test-postgres`，不要重复创建；不用时 `docker stop mira-test-postgres`。这里不提供删除数据库/卷的快捷命令。

### 浏览器交互与截图

```sh
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Linux 缺少系统库时，使用 Playwright 官方 `pnpm exec playwright install --with-deps chromium` 安装所需依赖。测试临时监听 127.0.0.1:3211，请先停止占用该端口的手动模拟服务。它只启动 `tests/e2e/fixture-server.mts` 的内存测试服务，不连接日常 PostgreSQL，也不调用模型；合成对话仅用于回归测试。截图输出到被 Git 忽略的 `test-results/`。

`pnpm check:all` 不包含浏览器测试；完整验证还需 `pnpm test:e2e`。环境禁止 PostgreSQL/Chromium 所需 socket 时不能绕过；使用允许的 CI 完成检查，并区分未执行和通过。

## 6. 数据位置、故障与限制

- `MIRA_DATABASE_URL` 必需，明确本地数据库名；不接受查询选项或远程数据库地址。启动会执行当前向上迁移，不自动建库或重置数据
- `MIRA_HOME` 默认 `~/.mira`，必须在源码仓库外；保存 `models.json`、`memory/` 独立 Git 和 `wake-input/`
- `MIRA_SCHEMA` 默认 `mira`；固定 Mira ID 为 `mira`。两个进程不能同时持有同一实例的 writer
- `MIRA_CWD` 默认启动目录，只是工具 cwd，不是沙箱；文件/Shell 使用宿主 OS 权限
- `MIRA_EXTENSIONS` 可选，沿用可信本地扩展配置；没有新增扩展安装器或管理 UI
- `models.json` 在同一原子文件中保存私有配置、选择和 API Key，使用 revision 防止并发编辑静默覆盖。文件为明文，创建/更新权限为 `0600`，新建私有目录为 `0700`。已有文件及其直接父目录也必须由当前 OS 账户拥有，且无组/其他用户权限；否则明确失败，不自动 chmod。只有脱敏的 `hasApiKey` 状态返回网页，Key 不写入 PostgreSQL 配置、上下文或 Memory 快照。修改冲突需重载；运行中不能改模型；空闲保存后下一条消息生效
- 与 Pi 的本地凭据文件类似，这不是加密保险箱；同一 OS 账户、管理员或该身份执行的工具/扩展仍可能读取文件。请勿把 `models.json` 上传、提交 Git 或复制进 Memory；备份也应作为秘密保管。无旧环境变量设置文件的兼容迁移，旧格式明确报错，不自动删除或改写用户文件
- Timeline 只显示可见消息、必要通知和整体处理状态，不输出 system/thinking/原始工具参数；目前没有逐 token 显示、New Chat、账号、多租户或公网部署
- 网络结果不明不会自动重发；显式“核对并重试”使用同一消息 ID。浏览器待确认消息保存在当前标签页 sessionStorage，确认落库后清除
- 连接失败先用第 2 节的 `psql` 检查数据库/用户名/密码；端口占用改 `--port`；模型失败核对服务商、模型权限与网页中保存的 API Key

## 7. 仓库里的测试数据是什么

正常启动路径是 `pnpm start` → `web-cli.mts` → `LocalWebService` → PostgreSQL 历史；前端初始消息数组为空。截图里的四条示例对话仅在专用 E2E fixture 源码中，应用不会导入它。显式 synthetic provider 的固定回复属于测试功能代码，不是预置历史。

合并前按跟踪文件核查：没有截图、浏览器 trace、运行日志、数据库/数据导出、用户 Memory、密钥、node_modules 或 dist 产物进入这批提交。合法测试夹具保留，以继续验证恢复与防重复发送；`.gitignore` 排除运行/构建产物。不要把自己的聊天、配置、数据库或截图另行加入 Git。

### 查看模型请求错误

“运行错误”固定显示在消息滚动区外，阅读最新或旧消息时都不会被历史滚动带走；长详情可独立滚动，仍可使用输入框。它会显示脱敏后的具体模型诊断，包括 provider 给出的原因/代码、实际 HTTP 状态与 request ID（有返回时）。复制这段文字即可用于排查；无需把 API Key、原始 headers 或请求正文发给别人。网络原因只能显示底层实际提供的 message/code，不能据此推断账户余额或权限。过长诊断会标明截断，HTML 与无支持字段的原始错误对象不直接显示。

失败输入仍已保存，不生成虚假的助手成功回复。修改模型设置不会自动重试，重复提交同一消息也仅核对 receipt；重启或发送新消息时，先按既有恢复规则处理未完成的 Wake。未知工具结果不会因此自动重放。
