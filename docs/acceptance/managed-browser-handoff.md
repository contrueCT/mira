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
