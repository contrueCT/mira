# ADR 0009：本地 Web 测试界面

状态：Accepted，2026-10-06。用户批准在真实模型验收前实现参考截图风格的初步图形界面，CLI 式一条命令启动后打开浏览器；批准 React + Vite + 原生 CSS，并明确要求 HTTP 框架，最终选择 Fastify。

> 后续 Web API Key 输入与存储行为见 [ADR 0010](0010-web-api-key-storage.md)，取代本文的环境变量名输入方式，其余本地边界不变。

## 范围与依赖

前端 React/ReactDOM 19.3.0、Vite 8.3.3；后端 Fastify 5.12.5 与官方 @fastify/static 10.1.5；浏览器测试 Playwright 1.63.0。版本来自 npm 官方发布记录，Fastify static 发布元数据明确支持 Fastify 5.x。Vite 8 支持既有 Node 24，不使用 Next、额外路由器、UI 库或新状态数据库。

Vite 8.3.3 的官方补丁包含开发服务器文件访问检查修复，保留精确版本的 pnpm 新发布年龄例外；不允许依赖生命周期脚本。普通运行使用构建产物和 Fastify 同源服务，不暴露 Vite 开发服务器。官方依据：[Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/)、[static 兼容性](https://github.com/fastify/fastify-static#compatibility)、[Vite 8.3.3 发布](https://github.com/vitejs/vite/releases/tag/v8.3.3)。

## 产品语义

只有一个持续 Mira、一个 Timeline。白底、浅灰助手气泡、蓝色用户气泡、居中 Mira 标识和底部输入栏参考用户提供的布局；不复制 dot 品牌，不加入 New Chat、登录、多账户、通话或未实现附件按钮。

界面包含发送、完整回复、排队/处理中/错误、基本工具名称和状态、模型设置、历史恢复与向前分页。不宣称逐 token 输出。工具参数、原始结果、system 内容和 thinking 均不直接输出到浏览器；运行诊断不伪装成人生消息。仅 source=user 且 type=web.message 的原始事件显示为用户消息。

## 持久化与生命周期

复用 PostgreSQL writer、WakeLoop、PiDurableRuntime、完整 v0.2 Prompt、七个 Pi 通用工具、原有 Memory Git 与扩展宿主。历史分页只读取既有记录；不另存消息、不改写原始历史、不新增迁移。页面刷新和进程重启从原始持久化记录恢复。

浏览器为每条提交保存不变的 ID、原始时间与正文；相同提交只查询/取得同一 receipt，不能启动第二轮工具执行。网络结果不明时不自动重发，用户可显式核对重试。receipt 表示已持久化排队，不能显示为模型已完成。服务器单写者继续跨进程受数据库 fencing 保护。

设置仅在空闲时保存，通过外部文件 SHA revision 和原子替换防止静默覆盖。模型配置仅保存环境变量名，不在浏览器输入或保存 API Key。live 模式下一条新消息使用已保存选择；synthetic 模式始终不调用模型，切换需重启。模型发现仅在显式点击后访问配置的目标，不能推断 token 上限、能力或真实访问权限。

## 本地 HTTP 技术边界

仅监听 127.0.0.1 的固定端口；精确 Host/Origin、同源自定义请求头、JSON schema、请求体/并发/频率上限、CSP 和禁止 iframe/CORS 防止外部网页与 DNS rebinding 访问本地通用 Shell 能力。没有账户认证 UI 或独立工具批准按钮。这些 HTTP 来源检查不改变主模型自然语言决策，也不构成宿主隔离或对本机恶意进程的防护。

不加入公网部署、代理透传、自定义监听地址、真实凭据、付费模型调用或数据库重置。停止时取消活动推理、等待 cleanup 并关闭 writer；外部副作用不可撤销，恢复仍如实保留 unknown。

## 验证

离线 Fastify inject/设置/前端状态测试；真实 PostgreSQL 持续上下文、去重和关闭恢复；Chromium 页面交互和桌面/窄屏截图。浏览器测试 fixture 不运行模型或工具，不等同 PostgreSQL 验收。命令、环境限制与最终执行结果见 [本地 Web](../development/local-web.md) 和 [验收](../acceptance/local-web.md)。
