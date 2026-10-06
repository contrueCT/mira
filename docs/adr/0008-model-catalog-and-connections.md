# ADR 0008：Pi 内置目录与显式自定义连接

状态：Accepted，2026-10-06。用户确认直接复用 Pi 的完整供应商／模型目录、每个模型展示 API 协议；自定义 base URL、三种常用协议、模型 ID 与 context/output 限额独立配置，先 API Key，OAuth／云账号后续。用户另要求参考 CC Switch 从自定义 base URL 自动读取模型列表。

## 范围

`apps/server` 消费 Pi 1.0.2 `providers/all` 的现代 Models collection，按 `model.api` 展示协议，不维护第二份模型注册表。所有 bundled chat 条目可离线查看；目录不等于凭据、账户权益或云登录已经准备好。OAuth、云账号参数以及本阶段不支持的 provider 在目录明确说明。

自定义连接只支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，用独立 provider ID、显式 adapter map 和仅属于此连接的 API-key 环境引用。无需把真实 Key 写入配置，不继承内置 Key/headers、默认 auth 文件或 ambient credentials。上下文、输出、reasoning/input 显式填写；价格 unknown，不能把 SDK 内部计算占位当实际零价。

发现仅 GET 指定连接的按协议 endpoint，保留 base URL 路径；可选同源 modelsUrl，不扫描其它地址、不剥离 path、不跟随重定向。响应、页数、模型数、时间和取消受技术限制。Anthropic 正规 cursor 翻页；结果只给 ID/名称，用户可一直手动输入，发现不修改配置、不猜测协议或能力。

`createModelTransport` 暴露 model + streamFn，供现有 `PiDurableRuntime` 组装。目录/auth 留在 server，runtime 仍无凭据和网络 fallback，工具判断与完整 v0.2 Prompt 保持 ADR 0007 语义。初始 transport 内部消费上游 SSE，只输出清理后的完整终止消息事件；尚无逐 token 输出。SDK 原始日志模式会被拒绝，回显 Key 的语义 payload 整条失败，不改写工具参数。没有新数据库层、Web 框架、交互聊天 CLI、自动压缩策略或部署。`pnpm demo` 继续是确定性假模型。

命令、配置、来源与限制见 [模型开发说明](../development/models.md)。验证必须分开报告离线 adapter/discovery、真实 PostgreSQL CI 和 live provider；本阶段没有用户凭据配置或真实付费调用。
