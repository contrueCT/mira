# @mira/server

当前仅实现最小组装和 PostgreSQL + 假 provider 的 CLI 演示，没有 HTTP 服务、UI、真实模型认证或费用。

```sh
pnpm demo --help
MIRA_DEMO_DATABASE_URL='<explicit localhost mira_demo URL>' \
MIRA_DEMO_SPOOL='/tmp/mira-demo-workspace' \
pnpm demo first-message 'Hello Mira'
```

数据库需预先准备，URL 必须显式指定 localhost 的 `mira_demo` 或隔离测试库 `mira_test`。默认 schema 为 `mira_demo`；可通过 `MIRA_DEMO_SCHEMA=mira_demo_<suffix>` 使用隔离 schema。迁移仅显式执行 up，不自动 down。`MIRA_DEMO_MIRA_ID` 默认 `synthetic-mira`；下一次命令使用相同 Mira ID 和新的消息 ID，就延续原始上下文。相同 ID/消息再次提交是幂等重试；更改同一 ID 的内容会被拒绝。

`MIRA_DEMO_MAX_INLINE_BYTES` 可降低内联大小以演示溢出文件。`MIRA_DEMO_SPOOL` 必须是源码仓库及用户 home 以外的受控目录。完整批次保存在普通文本文件中，模型收到路径；复用 Pi 的普通 `read` 工具及其已有输出限制，不添加专用读取服务。超长单行等限制遵循该通用工具；同批也开放 Pi 原生 write/edit/grep/find/ls/bash；默认目录不是沙箱，没有应用目录限制。本演示假 provider 默认直接产生合成回复，不假称它已经阅读溢出文件。测试可以注入会调用文件工具的确定性模型。

演示授权证据仅用于测试中明确编排的合成工具调用，不能作为产品自然语言授权解析器。`runDemo` 供测试/本地组装使用；生产账户身份、网络、授权解释与服务入口均未实现。

验证：`pnpm check`、`pnpm check:all`；真实数据库要求见 `tests/integration/README.md`。本地 socket 被禁止时不要用 TCP 绕过，使用现有批准 CI 验证。

`runDemo({memory:{memoryRoot,stateRoot,stateFiles?}, ...})` 可启用本批普通记忆功能。根目录必须在源码外且互不重叠；State 不得进入 Memory Git。初始上下文一次性读取 MEMORY.md 和显式 stateFiles。每轮最终回复后执行可恢复 Memory 快照，State 不版本化。`memoryCheckpointHook` 可被其它可信组装复用；传入同一 fenced writer。历史工具由同一 Mira 身份绑定。

CLI 通过成对的 `MIRA_DEMO_MEMORY` 与 `MIRA_DEMO_STATE` 启用这些根目录，`MIRA_DEMO_STATE_FILES='["current.md"]'` 明确选择初始读取的 State 文件。单独设置一边会报错；未配置时保持原有无 Memory 演示。

`workingDirectory`（CLI 为 `MIRA_DEMO_CWD`）选择已存在的普通默认目录，缺省为进程 cwd，与可能尚未建立的 overflow spool 分开；它不限制工具访问范围。Pi edit 仍使用原生执行与规范 `edits[]` schema，仅移除在授权之前运行的可选旧参数格式转换器；自定义 preparer 仍由 runtime 拒绝，实际执行前保留完整原始/验证参数证据。


## 手工可信扩展

`MIRA_DEMO_EXTENSIONS=/absolute/extensions.json` 加载普通 JSON 中明确配置的可信本地模块；格式见 [示例](../../examples/extensions/README.md)。程序化组装可使用 `runDemo({extensions:{entries,hmr?,configurationFile?}, ...})`。不指定配置文件的程序化管理变更仅在当前进程有效。

来源身份由组装层绑定。`emitEvent` 不唤醒；显式 Wake 复用原队列去重/合并。SDK 工具和 `extension.inspect` / `extension.manage` 保留普通 Pi 授权、intent/outcome 路径。管理工具返回 accepted，整批工具完成后等待应用，再由同一 Wake 的下一自然请求看到并调用新工具；不重开已完成的最终回复。

启用/停用/配置先保存到同一 JSON，再交给 Cordis，receipt 区分保存与应用失败。源码 HMR 使用 `node --expose-internals apps/server/src/cli.mts ...`；没有 addon、运行时安装或生成扩展激活。文件 watcher 是异步的，嵌套 CJS require 不自动追踪，apply 失败不保证旧代回滚。完整语义见 [扩展宿主](../../packages/extension-host/README.md)。假 provider 默认仍不自动调用工具；真正同轮激活/调用由确定性测试验证。
