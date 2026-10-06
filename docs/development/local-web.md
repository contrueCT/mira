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

以 OpenAI 为例，在**启动服务前的同一个 Bash 终端**交互设置模型密钥：

```sh
read -r -s -p 'OpenAI API Key: ' OPENAI_API_KEY; printf '\n'
export OPENAI_API_KEY
pnpm start
```

然后在网页选择相应服务商和模型，将“API Key 环境变量名”填写为 `OPENAI_API_KEY`，保存后再发送消息。其他服务商可使用各自变量名；填的是变量名，不是密钥值。已有服务运行时先 Ctrl+C，再设置变量并重启；不要同时启动第二个相同实例。程序不会自动加载 `.env`。

自定义连接需填写 base URL、协议和环境变量名。模型发现仅返回候选 ID/名称；上下文窗口、最大输出、推理/输入能力仍需根据服务商资料明确填写，也可手动输入模型 ID。详细限制见 [模型配置与发现](models.md)。保存/浏览目录不发模型请求；发送真实消息或恢复已排队 Wake 可能调用模型并产生费用，本批尚未验证真实模型效果。

其他启动方式：

```sh
pnpm start --no-open
pnpm start --port 3212
node apps/server/src/web-cli.mts --help
```

`--no-open` 仍启动服务，仅不自动开浏览器。地址要使用打印出的 `127.0.0.1`，不改成 `localhost`。Ctrl+C 停止服务并保留数据；重新启动继续同一个 Mira，待处理 Wake 会按既有恢复规则继续，未知工具结果不会自动重放。

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
- `models.json` 保存 `{configuration, selection}`，只有密钥变量引用。修改冲突需重载；运行中不能改模型；空闲保存后下一条消息生效
- Timeline 只显示可见消息和基本工具状态，不输出 system/thinking/原始工具参数；目前没有逐 token 显示、New Chat、账号、多租户或公网部署
- 网络结果不明不会自动重发；显式“核对并重试”使用同一消息 ID。浏览器待确认消息保存在当前标签页 sessionStorage，确认落库后清除
- 连接失败先用第 2 节的 `psql` 检查数据库/用户名/密码；端口占用改 `--port`；模型失败核对服务商、模型权限与启动终端的环境变量

## 7. 仓库里的测试数据是什么

正常启动路径是 `pnpm start` → `web-cli.mts` → `LocalWebService` → PostgreSQL 历史；前端初始消息数组为空。截图里的四条示例对话仅在专用 E2E fixture 源码中，应用不会导入它。显式 synthetic provider 的固定回复属于测试功能代码，不是预置历史。

合并前按跟踪文件核查：没有截图、浏览器 trace、运行日志、数据库/数据导出、用户 Memory、密钥、node_modules 或 dist 产物进入这批提交。合法测试夹具保留，以继续验证恢复与防重复发送；`.gitignore` 排除运行/构建产物。不要把自己的聊天、配置、数据库或截图另行加入 Git。
