# ADR 0036：普通扩展形式的飞书本人单聊通道

状态：Accepted scope，implementation draft；2026-10-15。用户批准扫码连接、同一个
Mira 双向交流和主动发送，并进一步要求凭据与设置能力为所有普通 Cordis 扩展可用。
本实现依赖 ADR 0035 的通用能力，不引入飞书专用核心接口。

## 边界

`packages/feishu-channel` 只依赖 extension-sdk 和固定的官方 SDK。通过既有 stage、
内容测试、install、activate 安装；无默认连接、保留内置 ID、专用 server 路由、
第二 Host 或独立认知循环。停用/卸载调用普通 onCleanup，关闭 WS 并取消扫码等待。
通用 `credentials` 和 `privateDirectory` 按持久安装身份隔离；设置声明也走通用 UI。

首版只接本人私聊文字，并用显式 `feishu_send_message` 发送回复或主动结果；Web
final 不自动镜像。群聊、多用户、文档/通讯录授权、用户身份代发、媒体和语音另立范围。

插件自行提供 `feishu_connect`，复用 `registerSettings` 返回的 start/current/cancel
同一宿主操作；工具立即返回安全 operation 和设置路径说明，不携带 provider URL、
配对挑战或凭据。网页按钮与对话工具共享 pending/取消/生命周期，不额外维护后台任务。

## 身份与可靠性

扫码使用官方 Channel 0.7.1 的 registerApp；基础 SDK 固定 1.75.0。关闭 preset，
仅申请 p2p read、send_as_bot 和 receive_v1 事件。飞书和 Lark 显式分域，拒绝意外品牌。
租户批准、机器人能力及长连接订阅仍需实际验证，不能把二维码生成称为连接成功。

本人绑定使用受保护设置内生成的高熵短时一次性配对码。匹配且未过期的私聊配对
消息直接持久绑定 tenant、sender open ID、private chat ID 与已消费消息 ID；普通
首个陌生消息不自动绑定。配对消息不进入聊天或模型，重启重投也不回放。删除二次
身份确认、测试发送动作及 tested 状态，绑定和重连均不自动发送消息。connected
只表示真实长连接就绪且本人已绑定，普通发送结果保留实际成功/未知证据。
入站保存原始时间、消息/引用 ID 与完整文字；未知媒体明确告知未支持。

Channel 的普通 pipeline 存在去重、过期丢弃、批处理和吞掉 handler 错误的问题，
因此原始接收使用官方 EventDispatcher/WSClient；其 awaited handler 失败产生 500
ACK。先写扩展私有 inbox 再走既有 fenced Event/Wake，稳定 ID 由既有 writer 去重。
重启只重试持久接收，不重新执行模型/工具。平台重投没有保证，故障必须显式报告。

发送使用基础 SDK 的单次 create/reply，无 Channel 重试/回退。每个分段先写 unknown
再 HTTP，确认后保存 message ID。未知结果和未开始尾段不自动重放；正常 reconnect
不等于再次发送。普通 runtime 的 intent/outcome 仍保留，扩展未替代核心历史。

## 安装闭包

既有 ArtifactStore 只快照显式本地依赖。pnpm 的传递依赖可能位于包目录之外，
直接 stage 包会被 missing closure 拒绝。通用 `prepare-extension-package.mts`
复制选定源码、显式链接已安装运行时依赖闭包，随后仍由既有 stage/hash/test/
install/activate 处理。无自动安装、catalog、全 node_modules 打包或供应商特例。

## 验证限制

离线覆盖 SDK 真实 HTTP/dispatcher、配对/隔离、private fs、持久重复/未知投递、
生命周期及实际生成扩展安装闭包。真实租户扫码、权限审批、scope introspection
前置权限及实时飞书收发未执行；不得把合成测试称为真实联通。完整命令与约束见
[扩展 README](../../packages/feishu-channel/README.md)。

## 通用来源显示

用户进一步批准所有普通扩展可使用不可变 `ExtensionEvent.message`（direction/text/sourceLabel/senderId/senderVerified）声明聊天文本投影。Host 白名单验证，Server 绑定真实安装 ID 和原始来源，不把 inbound 转成用户授权；前端只显示淡色小标签，不识别供应商 event type。沿用同一事件去重与时间线，无新增数据库或 final-delivery 协议。飞书确认发送分段才发布显示事件；失败仅补投显示、绝不重发。普通 final 不按文本隐藏。

## 最小操作与来源脚注

插件独立声明状态对应的 visibleActions 和次要 action group；未连接仅显示下一步，
已连接只在通用“更多操作”下保留维护动作。框架只解释通用声明，不包含飞书状态、
动作 ID 或供应商分支。所有插件消息的时间与来源共用同一行小号淡色脚注。

## 私有记录原子更新

插件使用 Node 24 内置 SQLite，在同一私有数据库保存 owner/inbox 主行与按 callId
分行的发送 receipt。schema 2 修复原单行累计保存全部已发送正文导致的容量故障：
每个自然发送查询只读取对应 receipt，待发布事件经 binding/pending 索引逐行补投，
不把全部发送历史装入内存。主行与单个 receipt 各自保持 2 MB 限制；全库随永久
调用身份与未决证据增长，取消旧 8 MB 整库限制。磁盘满仍明确失败，保留未决记录。

所有主行与 receipt 更新共用一个安装级 revision CAS，防止 ownership 交接后的旧
回调覆盖新证据；每份 JSON 另存内容 digest。短同步事务仍使用 100 ms busy timeout，
不在事务内联网，不新增 npm 依赖、通用存储框架或供应商核心分支。SQLite journal
恢复进程中断，busy/conflict 不自动重发。每段确认发送先持久保存完整待发布 Event，
Host 持久接收后才删除 receipt 中的 publication 正文；uuid、状态、message ID、
内容摘要和 callId 永久保留。unknown、未开始尾段与未发布正文不因容量而删除。
解绑保留旧调用证据；旧 binding 的待发布记录不会被新 binding 自动补投。

当前有效 schema 1 台账先校验再迁移：旧 sends 拆分、主行移除 sends 内容、schema
与全局 revision 更新处于同一事务，失败整体回滚。schema 2 使旧二进制拒绝继续写入。
早期预览 JSON 原字节仍保留，每次访问核对 legacy revision。升级须停止所有旧实例，
legacy 检查不能隔离仍在运行的旧二进制；未知 schema/失败迁移不覆盖证据。

入站保留完整原文的可逆表示。普通正文仍直接存于 `payload.text`；只有 NUL 或
孤立 UTF-16 surrogate 使用 `textEncoding: "json-string"` 与 `text: JSON.stringify(raw)`，
读取时 `JSON.parse(text)` 精确还原。这两类字符串即使可存入 PostgreSQL `json`，
后续 `event->>'source'` 也会分别报 22P05/22P02，故编码必须先于入队和 Event 接收。
聊天预览用 well-formed Unicode 显示孤立 surrogate 的替代字符；payload 可逆保留
原始码元。当前 pending 即使已有合法预览，也检查原始 payload 并补充同一编码。
只有聊天投影受 Host 的 100000 UTF-16 单元和
禁控字符边界约束：超限、空正文或含禁控字符时生成明确预览，转义控制字符，并在
完整码点处截断及提示。当前格式既有 pending inbox 在补投前应用同一投影，保留
原 Event/Wake 身份、来源和原文，不放宽通用 Host 校验或删除历史。
这覆盖 Host 尚未接收的待投递输入。旧版若已将非法 Unicode 提交到权威 History，
本轮不会改写记录或更换 Event ID 来绕过冲突；保留 pending 与原始证据，须人工
对账后恢复，不能宣称已修复这类既有坏历史。

`feishu-dialogue` 通过真实 Cordis Host 与 SQLite 验证重复大消息、重启/同 callId、
unknown/outcome 保存失败、当前 schema 迁移、未发布消息补投及 binding 隔离、
超长/Unicode/控制字符入站与既有 pending 恢复；`feishu-store` 验证逐行容量、
超过旧整库限制、全局 CAS 与事务迁移回滚。这些仍为合成协议验证，未接真实租户。

`recovery/feishu-inbound.test.mts` 穿过真实 Cordis Host、SQLite、PostgreSQL、
Event/Wake 和 History，确认 NUL/高低孤立 surrogate 可逆保存、普通emoji/超长预览、
重启去重及旧 pending 修复；随后普通消息、History read/search/page、来源提取和
Dreaming selection 均继续可用。测试使用显式 localhost mira_test 独立临时 schema，
无真实飞书账户或模型调用。
