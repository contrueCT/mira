# 受管浏览器接管验收

日期：2026-10-15。对应 [ADR 0034](../adr/0034-managed-browser-handoff.md)。此文件记录实际验证边界，不将源码、编译或 fixture 当成真实网站验收。

## 第一轮实现检查

- TypeScript 全部配置、包边界、生产构建通过。
- 前端普通单元测试 62 项通过。
- auth/http/browser/skill 定向检查 44 项通过；1 项 Unix-socket daemon 契约测试因本地 `EPERM` 明确阻塞。CI 对 socket 缺失不跳过。
- 边界测试原 19 项通过，新增 ws 仅限 server 的正反例单独通过。
- 实际 Chromium 启动因 `process_singleton_posix.cc socket() failed: Operation not permitted` 阻塞。未绕过该限制；本地没有执行真实页面断言，没有生成实际截图。

## 第一轮独立审查

独立 gpt-6.1-sol / max 审查指出并要求修复：

1. P1：上游在 daemon 尚存时可能内部重新创建 Chromium，旧 handle 不得冒充同一浏览器。
2. P1：上游导航与图像通道独立，旧缓存帧不能因晚到而取得新 generation。
3. P2：Chrome 有独立进程组，daemon 异常退出后仅清理 daemon 组不够。
4. P2：daemon/Chrome 不能继承整个服务环境，需复用明确的浏览器环境白名单。

本轮修复中；完成后需要新一轮独立审查。真实链路仍以固定提交的 CI 结果为准。

## CI 中准备的真实门禁

`pnpm test:browser:e2e` 使用隔离 PostgreSQL、生产 Web service/HTTP/auth、固定 agent-browser 0.39.1 native daemon、Chromium 和本机合成网站，不访问真实账户或模型。

覆盖目标：普通 synthetic provider 发出 browser_open/browser_command，经 intent/outcome 持久化；同页面 cookie 连续性；人工输入、CDP 中文组合及粘贴；交还后新 observation；子代理不能借用主浏览器；真实历史不含人工输入；票据单次、跨 Origin、双输入连接、断线、注销与重启不重放。截图应包含桌面与窄屏。

CDP composition 事件检查不是操作系统原生 IME 全平台认证。下载/文件选择器不在此 MVP 范围。浏览器实例丢失的上游内部重建必须报告 unknown；后验检测不承诺副作用未发生。

## 第二批修复（待独立复审与 CI）

- 受管 driver 仅传 browserLaunchEnvironment 白名单，启动环境 sentinel 测试通过。
- 固定版本 lifecycle 元数据出现重建即失效原句柄，动作结果为 unknown；不重放。上游可能在返回元数据前执行一次动作的限制仍保留。
- 每次接管先 disable/enable 清空上一 stream；target/URL generation 变化后的旧时间戳帧被丢弃，不可当新页面输入依据。
- 精确 PID/启动身份跟踪 daemon 后代；ready 前要求捕获存活浏览器后代，daemon SIGKILL 后清理单独进程组，并检查进程已退出（僵尸已终止）。无法确认时为 unknown。
- focused manager/proxy 测试 13 passed；1 个 Unix socket 合约测试因本机 EPERM 明确 blocked，CI 不允许跳过。
- real spec 增补 runtime browser_command、child owner 拒绝、context_records/tool_executions 秘密排除、restart 无效果重放断言，以及真实官方 daemon SIGKILL/Chromium 清理测试。尚未运行，不计为验收通过。

## 第二轮独立复审与第三批修复

第二轮新增 P1 同 URL 新文档未失效画面、P1 stream_disable 不 await 独立 reader，不能证明输入屏障、P2 重建 Chromium 后代未重新捕获。第三批采用官方 awaited daemon 人工输入队列，stream 只传画面；所有导航事件（包括相同 URL）更换 generation；逐次命令完成捕获 owned 后代。以上修复须 fresh review 与真实 CI 验证，旧“stream 排空”证明撤回。

## 第三轮独立复审与第四批修复

此前 P1 修复已完成源码复核；第三轮仅新增 P2 captured pointer 拖出画布导致非法坐标断连，以及 P2 closed tombstone 累积导致终身容量耗尽。第四批将捕获拖动坐标 clamp 到当前画面边缘，补四边拖出/释放 fixture 与 real spec；已成功关闭的 tombstone 有界淘汰，closing/live 不淘汰，补 70 次 open/close 后继续打开回归。focused 21 passed，1 socket EPERM blocked；真实UI仍等待CI。

第四轮全新独立 gpt-6.1-sol/max 审查：无 actionable P1/P2。审查额外验证 8 active、pending-close 保留、容量恢复和 live handle 不淘汰。UI 仅源码复核，真实 Chromium/daemon CI 尚未验收；不得将 review 通过写为真实链路通过。

## 首次真实 CI 失败（保留记录）

PR39 head01e83b4 / run38729341707 的真实 browser gate 2/2 失败：runtime browser_open 后为 error；直接 driver.open 的启动失败又被 cleanup unknown 掩盖。尚未进入接管或 kill-daemon 断言，截图不计成功验收。其他已执行 gates 与 macOS 通过。增加无URL/账户/输入的隔离原生启动probe，保留受限startup响应与stderr用于取证，不改变生产日志、浏览器安全参数或cleanup判据。

## 原生启动原因已取证

head763993f / run38734216371 的短probe保留原始 `No usable sandbox!` 错误：Playwright下载版Chromium受到Ubuntu AppArmor user namespace限制。未启用no-sandbox、未透传CI开关、未改OS策略。下一批仅合成CI选runner预装的官方Google Chrome stable（版本写入job日志），使用其现有受支持sandbox；不移动binary，不做安全降级fallback。生产启动错误改为分别报告失败阶段与清理状态，原始native错误不进工具历史。下一次真实probe与完整gate仍待执行。

后续完整复审修复了导航以proxy收包时间误丢静态新页帧的问题，现使用已验证的native事件时间戳；真实测试要求静态提交页有新可用画面。test harness用专门strict socket标记维持CI禁止skip，不向native透传CI。普通安装增加既有miraHome/tools标准目录发现，显式路径仍优先，无安装器/下载器；新增后安装发现与override回归。以上仍待最终完整独立复审和新head真实CI。

### 延迟状态轮询修复

完整复审发现 browser list GET 可晚于更新的控制/WS 状态返回，覆盖同 epoch 的 requesting→human 或新 epoch，并清空已渲染输入 fence。面板现在为本地状态更新计数；读取开始后若发生更新，则丢弃该读取及其错误。新增两项 Playwright 回归：延迟 agent/旧 epoch 与 requesting/同 epoch GET，先收到 human 状态与唯一静态帧，再释放旧 GET，仍可发送绑定该帧的输入。真实浏览器回归等待 CI，未以本地 EPERM 环境宣称通过。

### 官方 stream 启动流量修复

后续完整复审用未修改代理的内存 WebSocket 替身复现：官方种子 status/tabs/frame，加上身份复核两次 stream_status 的 command/result/tabs，会在验证完成前超过原 8 条缓存而误断连。现在忽略不会转发的事件后才计数，仅保留有序 frame/url/tabs/status，并同时限制 8 条/8MiB；身份复核完成前仍不转发。无 socket 回归执行生产代理源码，覆盖官方启动序列、40 条 console 消息不泄漏、条数与字节溢出关闭，均通过。这是协议替身测试，不替代仍待运行的真实官方 daemon/Chrome gate。

### 安装恢复与开发代理复审修复

完整复审补充两项 P2 并已修复：每次新建受管会话重新解析官方可执行文件，避免旧 PATH 版本验证失败后缓存阻止标准目录安装生效；无 socket 回归先拒绝旧 PATH 版本，再安装标准目录候选并验证下次 open 选择它，显式路径仍优先。Vite 开发代理启用 WebSocket 转发，并对 proxyReqWs 使用与 HTTP 相同的精确本机 Host/Origin 改写；生产鉴权不变。无监听配置测试覆盖可信与不可信来源，但实际开发服务器 WS 联通仍未本地验收。

### a8d5257 真实 CI 结果与测试预算修复

Run 38742733368：官方已安装 Chrome 保持 sandbox 的短 probe 成功，launch/close 成功、ownedBrowserCaptured=true、cleanup=confirmed，无 probeError；完整 gate 内同样的 startup 与实际 daemon SIGKILL/独立 Chrome 清理均通过。主 UI 链路在首次模型请求前失败，后续 gate 跳过，不能报告功能验收通过。

已用真实 PiDurableRuntime/MemoryWriter、生产 23 个工具 schema 与 7 个 skill metadata 的无 socket 探针确认测试夹具原因：复用 8192 上下文模型，但请求估计 18243 tokens，大于 7680 input budget；provider 调用为 0，错误为 Context exceeds input budget after compaction。浏览器真实测试现与既有完整服务 gate 一致，将合成模型上下文设为 100000；不改变生产预算、浏览器超时或安全设置。真实主链路仍需在新 head 上重跑。

### d3b1723 真实认证过渡回归

Run 38746208537 中真实 runtime browser_open/snapshot 与持久工具结果均已通过；初次打开浏览器面板的 WebSocket 403 导致后续验收停止。Trace 证明访问密码 PUT 开始于 14:02:50.261、用时 153.49ms；测试在提交完成前于 .402 请求无 Cookie ticket，随后 .417 WebSocket 已携带新会话 Cookie。生产 cookie 绑定与密码修改撤销按设计拒绝旧 ticket，不能放宽该校验。修复仅让测试等待“访问密码已保存”的实际提交完成提示，而不是等待保存前就已存在的 composer。真实链路需新 head 再验收；旧失败证据保留。
