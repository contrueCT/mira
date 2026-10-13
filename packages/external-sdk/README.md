# External SDK

给独立 script、worker、常驻 service 的 TypeScript 客户端。仅连接本机 Mira；不直接写上下文或数据库，不创建第二个 Mira。Node 24.19+、现代 Fetch/AbortSignal 环境可用；没有 Node 或框架依赖。当前为仓库内私有源码包，未发布 npm 包。

## 1. 接入与凭据

在 Mira 仓库根目录，通过现有 Shell 执行：

```sh
pnpm external-access status
pnpm external-access create --id build-watcher
pnpm external-access enable
```

`MIRA_HOME` 必须与 `pnpm start` 相同，也可以对管理命令显式传 `--home /absolute/private/home`。全局缺省关闭；create 不自动打开开关，也不覆盖已有身份。命令只输出状态和 `sender.credentialFile`，不输出 token。不要 cat 凭据、把 token 放到模型上下文、命令行、源码、Memory、业务 payload 或日志。

普通启动已包含入口，只监听 `127.0.0.1`，缺省端口 3210。配置修改在后续认证生效，无需重启：

```sh
pnpm external-access status --id build-watcher
pnpm external-access rotate --id build-watcher
pnpm external-access revoke --id build-watcher
pnpm external-access disable
```

rotate 对现有身份生成新凭据，也可明确重新启用已撤销的身份；保留来源 ID 与去重历史。revoke 清空该程序 token；disable 关闭全局。停用不会撤销已受理的事件、Wake 或已通过认证的在途请求。

每个程序只需读取 CLI 返回的自身文件。文件是普通受限权限明文，同 OS 账户与管理员仍可读，不是进程沙箱。损坏、过宽权限、链接或并发冲突会明确失败，不能通过重建配置绕过。CLI 崩溃遗留 `.access.lock` 时先确认没有管理进程，再由所有者清理该锁；程序不会按时间自动夺锁。

## 2. 创建客户端

仓库内程序可 `import { createMiraClient } from '@mira/external-sdk'`。独立、位于仓库外的 Node 24 程序可直接从这份仓库的绝对源码路径导入，例如 `/absolute/mira/packages/external-sdk/src/index.ts`。不要假定 npm 已发布该包；安装目录中的 TypeScript 擦除限制与本地源码导入不同。浏览器代码不应读取凭据，此入口拒绝浏览器 Origin。

```ts
import { readFile } from 'node:fs/promises';
import { createMiraClient } from '/absolute/mira/packages/external-sdk/src/index.ts';

const credentialFile = process.env.MIRA_EXTERNAL_CREDENTIAL_FILE!; // CLI 返回的路径
const mira = createMiraClient({
  baseUrl: 'http://127.0.0.1:3210',
  credentials: async () => {
    const saved = JSON.parse(await readFile(credentialFile, 'utf8'));
    return { senderId: saved.id, token: saved.token };
  },
});
```

loader 每次调用执行一次；正常运行轮换时无需把密钥返回给模型或重启 worker。SDK 不读取环境、磁盘、cookies 或 ambient credentials。可传 `timeoutMs`（默认 10000，1–60000）与测试用 `fetch`。每个方法第二参数可传 `{ signal }`。接口只接受显式 `http://127.0.0.1:<port>`（1024–65535，与本地 server CLI 一致）；不跟随重定向。

## 3. 每个事实先选 Event 或 Wake

```ts
const event = {
  id: 'build-42.revision-7', type: 'build.failed',
  occurredAt: '2026-10-13T03:24:00.000Z', // 源事实原始时间，不能重试时重建
  payload: { buildId: 42, revision: 7, state: 'failed' },
};
// 二选一：只记录，不请求模型
await mira.emitEvent(event);
// 或者：用另一个尚未提交的源事实，一次事务记录并请求关注
await mira.requestWake({ id: 'attention-build-43', reason: 'The watched build failed',
  event: { ...event, id: 'build-43.revision-1', payload: { buildId: 43, revision: 1, state: 'failed' } } });
```

`requestWake` 自带完整 event，并原子保存事件和 Wake。不要先 emitEvent 再对同一个事件调用 requestWake；两种方式之间转换会冲突，与内部 Extension SDK 一致。事实已静默保存而之后出现需要关注的新变化时，产生真实的新事件，而不是换 ID 重发旧效果。

通知直接使用已经写好的用户可读正文，不唤醒模型：

```ts
await mira.sendNotification({ id: 'backup-12.complete', occurredAt: '2026-10-13T03:25:00.000Z', text: '备份已完成。' });
```

它在同一 Timeline 显示为“外部程序 build-watcher”及正文、时间，不是 Mira 向邮件/Slack/手机推送，也不是 Mira 的发言。要让 Mira 判断或组织答复，用 requestWake。

ID/类型为 1–128 位 ASCII 字母数字及 `_.:-`，首位字母数字；时间必须是 `new Date(...).toISOString()` 形式；reason 非空最多 4096 字符；通知非空最多 16000 字符；整个输入最多 65536 UTF-8 字节。payload 接受有限、无环、32 层以内的普通 JSON，不接受 undefined、NaN、函数、自定义对象、getter 或稀疏数组。

## 4. 回执与未知结果

成功回执包含 `operation`、调用者 `id`、`receipt: 'inserted' | 'duplicate'`、`durability: 'persisted'`；Wake 额外包含源 `eventId`。这些 ID 不是 History UUID。回执只说明 ingress 已落库，不等于模型已完成、用户已读或远端效果成功。

重试必须保留原 ID、原时间、完整 payload、Wake ID/reason 和操作选择。对象键顺序不影响去重；内容变化会冲突。duplicate 不能重新启动已失败或已完成的认知；重启继续已有持久恢复。

SDK 从不自动重试。`MiraClientError` 只有固定 `code`、HTTP `status`（若已收到）和 `outcome`，不会附上请求、原响应或底层异常：

- `not_sent`：本地校验/凭据失败或发送前取消，没有派发请求。
- `rejected`：明确 HTTP 4xx（408 除外），如认证失败、冲突、输入超限。
- `unknown`：发送后网络/取消/超时、5xx 或坏回执，可能已经落库。保留源信封再显式核对/原样重试，不生成新 ID。

HTTP 路径分别是 POST `/api/external/events`、`/api/external/wake`、`/api/external/notifications`，JSON body 就是方法输入。请求头由 SDK 设置 `X-Mira-Client: external`、`X-Mira-Sender` 和 `Authorization: Bearer …`。来源在服务器绑定为 external，正文不能冒充 user/Mira。

## 示例与验证

- Mira 可按需读取内置 [外部程序作者技能](../../skills/mira-external-programs/SKILL.md)，通过现有普通文件/Shell 完成接入，不添加管理工具。
- [一次性脚本](../../examples/external/script.ts)：读取持久源信封，静默提交。
- [worker](../../examples/external/worker.ts)：读取完整 Wake 信封，一次提交关注请求。
- [常驻 service](../../examples/external/service.ts)：软件轮询/filter，匹配后发通知；`--once` 可离线驱动一次。遇未知结果停止，源文件保留供显式重试。
- [ADR 0017](../../docs/adr/0017-external-sdk-local-ingress.md)、[验收记录](../../docs/acceptance/external-sdk.md)。

示例从 `MIRA_EXTERNAL_CREDENTIAL_FILE` 读取文件路径，`MIRA_EXTERNAL_URL` 可指定本机端口。运行：`node examples/external/script.ts /absolute/event.json`，其余同理。源文件必须保持原始信封；示例不会生成新的重试身份。

独立首次使用 fixture：`node scripts/external-sdk-usability.mts --help`。它使用生产 HTTP/认证/ingress 与隔离临时 home，但存储为内存、不调用模型，不能代替真实 PostgreSQL 验收。
