# ADR 0034：受管浏览器与界面内接管

状态：已批准方案，实现与验收中。2026-10-15 批准在既有设置内使用 agent-browser 0.39.1 官方 stream，用户无需离开 Mira。验收结果见后续 PR；源码或离线 fixture 通过不代表真实浏览器链路通过。

## 范围

- 设置增加“浏览器”页、只读画面、接手、明确交还及窗口内放大。不增加主聊天卡片、常驻按钮、独立 Dashboard、远程桌面或浏览器内核。
- 首版为 Mac/Linux 本机运行的官方 Chrome/Chromium。要求事先安装 agent-browser 0.39.1 和浏览器；应用不自动下载、安装、登录或读取任意已有浏览器。
- 官方 native daemon 由 Mira 监督；初始 launch 后仅通过同代官方 socket 协议通信。协议映射限定在 `browser-driver.ts`；不调用会自动重启 daemon 的 CLI 命令，不 fork 上游。
- 上游依据为 v0.39.1 commit `1165952d74ceed98fdc2dd97190ad41f44dd0e24` 的 `cli/src/native/stream/{mod,websocket}.rs`、命令协议和官方 streaming 文档。版本升级必须重新验收。

## 已安装浏览器发现（2026-10-18）

CLI 的浏览器路径配置不会自动传给 Mira 直接监督的 native daemon。默认缓存优先在 Ubuntu 上可能选中没有对应 AppArmor profile 的下载版 Chrome，即使系统官方 Chrome 已能正常启动。

代码在每次新建浏览器、发出 launch 前检查 Linux 官方 Chrome 标准安装位置，并把选中的可执行文件显式传入 daemon。显式 `MIRA_BROWSER_EXECUTABLE_PATH` 优先；系统安装可在下一次 open 发现，未找到或其他平台沿用上游发现。完整路径顺序见[运行工具](../development/runtime-tools.md)。这只选择已有文件，不执行候选探针、不安装依赖、不导入 CLI profile/flags/config，也不在 launch 失败后换浏览器重试。

skill 负责解释依赖检查、安装与 sudo 交互；浏览器发现由代码完成，普通用户安装系统 Chrome 后无需手工修改服务配置。自定义路径的启动环境覆盖仍需重启生效。

## 所有权与租约

服务创建不可猜测 browser ID、独立 session 和 daemon generation。main/child 工具闭包绑定各自 stream 身份；模型不能指定 owner。所有受管命令共用每浏览器队列。

接手立即关闭新 agent 命令入口，等在途命令完成后授予 human epoch。单个连接持有输入权，其他页不能抢占。断线保持 held，不自动交还或重发输入。重新接手重建只读画面 stream，旧 epoch 不能输入。

人工输入不再经过上游 stream。画面仍复用官方 stream；输入通过受管队列调用官方 daemon 的 `input_mouse`、`inserttext` 与 `press`，逐条等待上游 CDP 响应。文本/IME提交/粘贴走 inserttext，支持的非文本键与组合键走 press；不支持独立按键按住/释放、任意功能键或系统快捷键。输入参数和回包不进入模型工具调用、持久历史或日志。明确交还先撤销新输入入口，取消尚未发送的排队输入并显示数量，只等待已经发出的命令响应；文档 generation 已变化的未发送输入同样被丢弃，然后同一 daemon 取新 snapshot。响应只证明输入命令完成，不证明登录、支付或导航业务成功；失败为 unknown，不重放。模型必须显式取得新的 observation/snapshot，才能执行下一条受管命令。取消未发送输入可能打断一个手势（例如 mousePressed 已发出但 mouseReleased 被取消），页面可能保留按下状态；此时保持 held 并阻止 agent 继续。用户重新接管并看到画面后可显式点击松开按钮；不偷偷补发松开或重放操作。

上游 `stream_disable` 不能作为输入屏障：它 join 连接任务，但连接的独立 reader 只被 AbortOnDrop.abort()，并未 await，且 reader 投递 CDP 使用 send_command_no_wait。因此它只用于画面生命周期，Mira 不向 stream 发送人工输入，避免两套输入通道。

资源互斥不是动作批准平台。主模型仍依据自然语言用户意图决定操作与澄清。普通 shell、终端和同 OS 用户进程没有沙箱；它们可能绕过受管入口，因此 skill 明确要求使用受管工具，不承诺全主机强隔离。

## HTTP 与秘密

REST 继续原 API 的精确 Host/Origin、X-Mira-Client、cookie 和 CSRF 规则。唯一 WebSocket 路径独立验证精确 Host/Origin、重复安全头、当前登录、15 秒一次性票据及 browser epoch。票据只通过受保护 POST 返回，以 WebSocket subprotocol 发送，不放查询 URL、持久存储或日志。客户端不能指定目标 URL/端口/CDP 地址，代理只访问登记的 loopback stream。

帧采用上游 ack pacing，用户完成渲染才 ACK。代理只转发有界 frame、status 和脱敏 domain/tab 信息；不透传 console、command、原始 CDP。输入限类型、长度、坐标和速率，绑定 epoch、画面 generation 与已渲染帧。标签/URL 变化后必须等待新画面。认证撤销、密码修改、服务关闭或浏览器代际结束撤销连接与票据。

人工画面、按键、粘贴和票据不进入模型、数据库历史、Memory 或日志。模型明确恢复后自行获取的新 snapshot 属于普通工具结果，仍按原历史规则持久保存。LAN HTTP 不加密；远程敏感页面应使用 HTTPS/WSS，网页密码不能替代传输加密。

## 交互限制

支持鼠标、滚轮、基础键盘及临时本地文本输入桥。指针取消或捕获丢失仅终止本地手势跟踪，不合成远端松开事件；已发送的按下保持到用户看到当前画面后显式松开，交还仍受 held 门禁保护。中文组合输入/文本粘贴必须分别验证协议和实际浏览器，不把合成 composition 事件冒充各操作系统原生输入法验收。文件选择器不在网页 screencast 内，首版不支持上传桥接；下载位于 Mira 主机，需由 Mira 通过已有附件工具明确交付。仅显示当前标签，不增加完整浏览器管理 UI。

服务重启不恢复浏览器句柄、human lease 或票据，不假装恢复登录态。结果未知不重放；daemon 与浏览器属于同一受管生命周期，正常关闭释放资源。OS 进程组清理不是抵抗同用户任意脱离进程的隔离保证。

## 验证门禁

离线测试覆盖队列、main/child 隔离、epoch、fresh observation、未知结果、不重启/重放、命令协议、Host/Origin 和输入白名单。UI fixture 单独覆盖状态、取消、重复点击、断线、窄屏与输入事件。

独立真实链路要求 PostgreSQL、生产 HTTP/auth/service、固定版本 agent-browser、Chrome/Chromium 和远端合成站点，验证相同页面/cookie、接手排队、人工文本/粘贴、交还新 snapshot、双页冲突、注销/改密、重启失效及截图。无真实账户、无付费模型。未执行或环境拒绝的门禁明确记录，不降低要求。

## 已知上游恢复边界

固定版本的页面命令（包括 snapshot/get/tab/navigation/输入）可能在 daemon 尚存但 Chromium 断线时内部 auto-launch；stream/status/session-info/close 不走该路径。适配器从不重试命令或重启 daemon，但这不等于能事先否决上游单条命令内部的重新启动。适配器核对上游响应的 lifecycle.launched/relaunchedBrowser/restartedBackground，出现新实例时将旧受管句柄失效并报告 unknown，不能把新页面冒充恢复。检测发生在命令之后：例如 navigate/tab-new 可能已经访问 URL，不能承诺该副作用未发生。不得用故意无效的环境变量充当隐藏开关；进一步强化需公开的上游接口与独立验收。
