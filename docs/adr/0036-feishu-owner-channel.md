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

本人绑定使用随机短时配对码加受保护设置内的身份确认。候选冻结，首个陌生消息不
自动绑定；只认匹配的 tenant、sender open ID、private chat ID 和 human sender。
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
