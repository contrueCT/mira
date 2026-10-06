# @mira/server

当前包含 PostgreSQL + 假 provider CLI、Fastify 本地 Web 组装，以及显式模型配置/transport。浏览器前端见 apps/web；真实模型联通与费用尚未验收。

```sh
pnpm demo --help
MIRA_DEMO_DATABASE_URL='<explicit localhost mira_demo URL>' \
MIRA_DEMO_SPOOL='/tmp/mira-demo-workspace' \
pnpm demo first-message 'Hello Mira'
```

数据库需预先准备，URL 必须显式指定 localhost 的 `mira_demo` 或隔离测试库 `mira_test`。默认 schema 为 `mira_demo`；可通过 `MIRA_DEMO_SCHEMA=mira_demo_<suffix>` 使用隔离 schema。迁移仅显式执行 up，不自动 down。`MIRA_DEMO_MIRA_ID` 默认 `synthetic-mira`；下一次命令使用相同 Mira ID 和新的消息 ID，就延续原始上下文。相同 ID/消息再次提交是幂等重试；更改同一 ID 的内容会被拒绝。

`MIRA_DEMO_MAX_INLINE_BYTES` 可降低内联大小以演示溢出文件。`MIRA_DEMO_SPOOL` 必须是源码仓库及用户 home 以外的受控目录。完整批次保存在普通文本文件中，模型收到路径；复用 Pi 的普通 `read` 工具及其已有输出限制，不添加专用读取服务。超长单行等限制遵循该通用工具；同批也开放 Pi 原生 write/edit/grep/find/ls/bash；默认目录不是沙箱，没有应用目录限制。本演示假 provider 默认直接产生合成回复，不假称它已经阅读溢出文件。测试可以注入会调用文件工具的确定性模型。

`runDemo` 供测试/本地组装使用，假 provider 的确定性工具调用不证明真实模型判断质量。主模型通过对话、上下文及自然语言 Prompt 决定调用或澄清；server 不注入 authorize 回调或合成授权证据，authorizationContext 仅说明事实。生产账户身份及服务入口仍未实现；显式真实协议 transport 与离线目录见下节。见 [ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md)。

验证：`pnpm check`、`pnpm check:all`；真实数据库要求见 `tests/integration/README.md`。本地 socket 被禁止时不要用 TCP 绕过，使用现有批准 CI 验证。

`runDemo({memory:{memoryRoot}, ...})` 可启用普通记忆功能。Memory 根目录必须在源码外且互不重叠。真正初始上下文一次性读取 MEMORY.md；后续 Wake、恢复、重启和压缩沿用持久快照，不重新读取。每轮最终回复后执行可恢复 Memory 快照。`memoryCheckpointHook` 可被其它可信组装复用；传入同一 fenced writer。历史工具由同一 Mira 身份绑定。

CLI 设置 `MIRA_DEMO_MEMORY` 即可启用 Memory；只支持当前 Memory 配置，不保留旧 State 配置解析、弃用提示或迁移流程。未配置 Memory 时仍注入完整 Mira v0.2 Prompt，根目录/Memory 以明确未配置值表示，不伪造路径。

完整 [v0.2 模板](../../packages/runtime-pi/prompts/mira-system-v0.2.md)用于初始与已有认知流；身份、示例和自然语言授权原则均原样保留。动态时间、环境、能力与授权语境在请求边界渲染；能力描述与实际工具注册表一致，工具批次结束后可在同一 Wake 下一自然请求更新。不会为 Prompt 更新单独调用模型。见 [ADR 0006](../../docs/adr/0006-memory-only-system-prompt.md)。

`workingDirectory`（CLI 为 `MIRA_DEMO_CWD`）选择已存在的普通默认目录，缺省为进程 cwd，与可能尚未建立的 overflow spool 分开；它不限制工具访问范围。Pi edit 仍使用原生执行与规范 `edits[]` schema，仅移除在持久 intent 之前运行的可选旧参数格式转换器；自定义 preparer 仍由 runtime 拒绝，实际执行前保留完整原始/验证参数证据。


## 手工可信扩展

`MIRA_DEMO_EXTENSIONS=/absolute/extensions.json` 加载普通 JSON 中明确配置的可信本地模块；格式见 [示例](../../examples/extensions/README.md)。程序化组装可使用 `runDemo({extensions:{entries,hmr?,configurationFile?,artifactsDirectory?}, ...})`。不指定配置文件的程序化管理变更仅在当前进程有效。

来源身份由组装层绑定。`emitEvent` 不唤醒；显式 Wake 复用原队列去重/合并。SDK 工具和 `extension_inspect` / `extension_manage` 保留普通 Pi 技术校验、不可变 intent/outcome 与来源路径。管理工具返回 accepted，整批工具完成后等待应用，再由同一 Wake 的下一自然请求看到并调用新工具；不重开已完成的最终回复。

启用/停用/配置先保存到同一 JSON，再交给 Cordis，receipt 区分保存与应用失败。源码 HMR 使用 `node --expose-internals apps/server/src/cli.mts ...`；没有 addon 或运行时依赖安装。生成扩展按 [ADR 0005](../../docs/adr/0005-generated-extension-lifecycle.md) 开启 artifactsDirectory 后使用 stage/install/activate/update/rollback/remove，仍走原工具技术校验和持久化路径。文件 watcher 是异步的，嵌套 CJS require 不自动追踪，apply 失败不保证旧代回滚。完整语义见 [扩展宿主](../../packages/extension-host/README.md)。假 provider 默认仍不自动调用工具；真正同轮激活/调用由确定性测试验证。


## 模型目录与连接

`pnpm models --help` 提供完整 Pi chat 目录、逐模型协议、显式自定义配置和按 base URL 发现模型。`createModelTransport` 返回可注入既有 `PiDurableRuntime` 的 model/streamFn；不会改动假 provider demo。配置与 URL 语义、独立 API Key、延期的 OAuth/云登录、unknown pricing 和验证边界见 [模型说明](../../docs/development/models.md)及 [ADR 0008](../../docs/adr/0008-model-catalog-and-connections.md)。

## Local web composition

`web-cli.mts` / `pnpm start` starts Fastify on 127.0.0.1 and opens the built React/Vite UI. `web-service.ts` keeps the existing PostgreSQL writer and wake/runtime contracts; `web-settings.ts` stores private API keys and model settings together outside source with protected permissions and atomic CAS; explicit public projections only return `hasApiKey`, never stored keys. CLI configuration retains explicit environment references. See [local-web](../../docs/development/local-web.md) for exact setup and verification. No live model request is made by the offline/browser fixtures.
