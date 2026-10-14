# Web 界面

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则不能放宽共享约束。

## 入口与状态

- `README.md` 描述真实命令和行为；`package.json` 是依赖事实来源
- `src/main.tsx` 与 `src/App.tsx` 提供单条 Timeline；`src/SettingsDialog.tsx` 在既有设置入口内提供模型、Memory、扩展与运行记录；对应 panel 独立保持浏览器 DTO
- React + Vite + 原生 CSS 已获批准；不增加路由、状态管理、UI 组件库或 Markdown 依赖
- 生产静态文件由本地 server 同源服务，默认端口 3210；开发代理见 `vite.config.ts`

## 本地约束

- 不增加 New Chat、会话列表、账户/授权 UI 或每次 Wake 创建新人物的概念
- 普通 Timeline 展示对话文本、双向消息附件和必要通知；仅在已持久关联 child 时展示紧凑子任务卡片（ADR 0026），按 child/run 独立读取真实活动与显式公开进度。主 Mira 的工具活动仍不展示。禁止渲染 system/thinking、原始工具参数或结果；后端工具执行、持久记录和协议配对仍完整保留
- 浏览器可在密码式输入框接收用户输入的 API Key，仅发送本地后端；读取接口不回填 Key，仅给 hasApiKey 状态。禁止写入浏览器持久存储、URL、日志或消息历史，关闭/取消清除未保存输入
- Timeline `id` 使用全局 History UUID；用户条目的 `externalEventId` 单独关联待确认请求，不从 History ID 推导外部去重键
- 发送先暂存完整幂等信封；不明结果不自动重发；明确重试保持同 ID/文本/时间/有序附件 ID；持久事件确认后清除
- 页面不可见时停止轮询；历史合并按 ID，读取旧页保持滚动，新消息不打断向上阅读
- 模态设置支持焦点、Escape、取消和历史；迟到加载不得覆盖新编辑，revision 冲突须显式呈现
- Memory 读取当前总览；修改请求必须走既有普通消息/待确认信封，结果按精确请求/Wake 关联，不把 POST 回执或全局状态当成功。扩展配置只写不回填且接受 SDK 完整 JSON 值；运行记录只展示后端白名单 DTO，不借管理页面渲染原始诊断
- 修改 UI 后覆盖返回、取消、重复点击、中断恢复，并检查加载/空态/错误态及窄屏

## 验证

仓库根运行 `pnpm check`；构建为 `pnpm --filter @mira/web build`。依赖或 exports 改动需同步检查 `scripts/boundaries.json`，只开放确有用途的外部依赖。实际浏览器交互和截图验证与模拟/真实模型测试分别记录。

- 附件字节不存浏览器持久存储。媒体必须用带 X-Mira-Client 的受保护 fetch 转有界 Blob；图片仅安全栅格格式、视频有下载兜底，SVG/HTML/PDF/Word 不嵌入、不自动解析；对象 URL 随卸载/关闭清理
