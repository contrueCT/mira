# Server 组装入口

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 组装假 provider、持久化、WakeLoop、Pi 通用文件/search/bash、Mira 固定范围历史查询、可选 Memory 与手工/生成扩展生命周期；`pnpm demo --help` 为 CLI 入口。`web-service.ts` 复用同一运行时，`http.ts` 提供严格同源 Fastify API，`web-cli.mts` 为本地启动。
- `src/model-catalog.ts` / `model-config.ts` / `model-discovery.ts` / `model-transport.ts` 负责 Pi 目录、独立显式密钥引用、受限模型发现和注入 runtime 的 transport；`pnpm models --help`，见 [模型说明](../../docs/development/models.md)。目录不是凭据状态，发现不猜 token 限额。
- `src/extensions.ts` 绑定事件来源、把 SDK 工具映射到普通 Pi schema/intent/outcome 与来源路径，并提供 stage 与直接等待应用的生命周期管理工具
- 本目录负责 API、技术来源边界、启动和依赖组装；框架为 Fastify。没有账号系统或工具批准 UI。

## 本地约束与跨包陷阱

- 在这里连接核心契约与具体适配器；不要让 life/context 反向导入 server
- API 必须区分 emit event 与 request wake，并在边界验证不可信输入
- cwd 只是默认位置，无应用目录限制或产品隔离环境；主模型通过自然语言 Prompt/对话决定调用或澄清，不注入 authorize 或合成批准证据
- 完整 Mira Prompt 必须到达实际请求，包括无 Memory 和当前上下文恢复；Memory 初始快照与 wake-end checkpoint 不得变成每 Wake 重读/重注入或文件变更通知
- `skills.ts` 仅加载源码 `skills/` 与 `${MIRA_HOME}/skills`（默认 `~/.mira/skills`），使用 Pi 显式路径及 `includeDefaults:false`；内置同名优先并报告诊断，缺失用户目录为空，不扩大到 `.pi` / `.agents` 扫描
- 启动恢复、停机和错误处理不能生成第二个活跃认知写者
- 持久化故障只通过现有 status/HTTP 显示固定临时 notice，明确无诊断落库承诺；仅接受可信实例标签，普通错误仍受保护，不添加工具 chip/trace 或成本字段
- Web CLI 默认通过 `web-extensions.ts` 初始化/读取 `${MIRA_HOME}/extensions.json` 与 artifact store，管理工具默认可用；已有文件不覆盖，显式 `MIRA_EXTENSIONS` 错误不回退。初始化不安装或激活新代码，程序化/演示入口仍使用显式扩展选项

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。`pnpm demo --help` 和 `node apps/server/src/web-cli.mts --help` 离线验证入口；数据库演示由恢复集成测试覆盖。此 Pi 消费项目进入 tsconfig.pi.json，Mira 源码仍严格检查。

## 本地 Web

固定 127.0.0.1/精确 Host、Origin 和请求头检查不可放宽；HTTP 来源防护不等于自然语言工具授权。Web 模型设置接收 write-only API Key，源码外的私有文件保存明文密钥并限制权限；公开响应仅返回 hasApiKey。禁止密钥进入日志、数据库、Prompt 或历史。CLI 仍使用显式环境变量引用；revision 冲突不能静默覆盖。Timeline 只返回白名单展示字段，不发送 system/thinking/原始工具参数。界面通过确定性 fixture 测试，真实 PostgreSQL 恢复单独验收。
