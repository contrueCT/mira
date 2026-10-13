# ADR 0017：外部程序 SDK 与本地接入

状态：Accepted，2026-10-13。用户确认通知在用户与 Mira 的同一 Timeline 展示；外部接口限本机、初始关闭；Mira 可通过现有 Shell 使用本地命令管理程序身份和凭据，配置下次请求生效。只实现功能与隔离合成验证，不在本次工作中配置用户真实长期访问，不部署或开放公网。

## 极小接口与原有生命循环

Architecture v0.5 §33–36、§51 第四阶段落为平台无关的 `@mira/external-sdk`。`emitEvent` 静默保存事实；`requestWake` 同一事务保存完整事件与 Wake；`sendNotification` 保存 external 来源事件并投影为带程序 ID、时间的 Timeline notice，不调用模型，不冒充用户或 Mira 的话，也不向邮件、Slack 或手机推送。三个方法都使用同一个 Mira、writer 与原始 Life History，不直接写 Working Context、不新增领域类型或数据库表。

Event/Wake 继承内部 Extension SDK 的不可变信封：同一个事实选择 emitEvent 或 requestWake，不能先 emit 再以相同 ID 追加 Wake。请求携带稳定源 ID、原始 occurredAt 和完整 JSON；冲突拒绝，精确重试返回 duplicate。不同程序拥有来源去重命名空间，通知另有独立命名空间。成功回执只确认 ingress 已持久化，不能当成模型完成或用户已读；重复 Wake 不能重启失败的认知。重启/真正的新 Wake 仍沿用既有恢复规则。

## 真实来源与本地接入

复用 Fastify 的既有固定 `127.0.0.1` listener、精确 Host、防 DNS rebinding、大小/并发/速率上限。Web 同源 Origin/header 规则保持不变。新的 `/api/external/*` 仅供外部程序，拒绝浏览器 Origin/fetch-site 请求，不开放 CORS；每次认证重新读取私有全局开关与程序凭据，核对 sender 与 token。认证证明来源，不证明正文中的用户授权；主模型动作判断继续遵循 ADR 0007。

全局开关缺省关闭。CLI `status`、`enable`、`disable`、`create`、`rotate`、`revoke` 通过普通 Shell 可用，不增加模型管理工具、账号系统、审批 UI 或管理 HTTP。每个程序独立私有文件，随机凭据由代码直接写入文件，正常输出只有路径和状态。worker 显式读取自己的文件，SDK 的凭据 loader 每次请求刷新；服务器认证同样逐次读取，不需要 watcher、重启或 Wake。

创建不会顺手打开全局开关。撤销阻止此后认证；不能撤销已保存事件、已排队 Wake、已经通过认证的在途请求或既有外部效果。轮换保留身份及去重空间，不修改历史。

## 凭据文件与失败

沿用 ADR 0010 的本地明文边界：源码、Memory 和生成扩展仓库之外；目录 0700、文件 0600、当前 UID、常规文件、禁止链接；读取有字节上限，写入原子发布并同步。并发 CLI 对同一存储加互斥并校验原快照，不静默覆盖冲突；不会凭时间自动接管遗留锁。损坏/不安全文件 fail closed，不自动 chmod、恢复环境变量或重置数据。没有新密钥库、云凭据或持久访问配置的实际执行。

同一 OS 账户、管理员及该身份的普通文件/Shell 工具仍能读凭据。此处避免正常模型/日志输出泄露，不宣称进程间隔离或未知代码沙箱。SDK 无 Node、数据库、核心内部依赖，无 ambient credential、重定向或自动重试。网络中断、超时、响应错误或 5xx 可能发生在落库之后，呈现 unknown；调用者保留原请求后显式核对/重试，不能生成新 ID 冒充安全重试。

## 验证

协议、客户端错误/取消、私有文件与 CLI 并发、真实回环 HTTP、完整 PostgreSQL 事务和服务恢复、Timeline Chromium 展示分层验证。所有数据与 token 为合成临时值，无真实模型/付费调用。独立首次使用通过正常文档、本地 CLI、SDK 与实际 HTTP 操作；其内存 fixture 不代替 PostgreSQL 验收。执行记录见 [External SDK 验收](../acceptance/external-sdk.md)，未执行的项目不得写成通过。
