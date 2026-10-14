# Tests

共享规则见 [根 AGENTS.md](../AGENTS.md)。本文路径相对于 `tests/`。

## 入口

- `foundation/design-sources.test.mts` 锁定三份新原文和 v0.4 存档的字节数/SHA-256，核对来源 manifest
- `foundation/boundaries.test.mts` 是当前实际测试入口
- `foundation/toolchain.test.mts` 通过当前 pnpm 验证配置和不支持的 Node 版本被拒绝；用 `pnpm test` 运行以传入准确包管理器入口
- `unit/model-connections.test.mts` 与 `unit/model-discovery.test.mts` 使用真实 Pi adapter + 注入 fetch／合成 SSE 验证协议与发现，绝不执行 live 模型调用
- `unit/` 为核心/离线运行时测试；`integration/` 与 `recovery/` 为真实数据库/进程测试；`e2e/` 为 Playwright 合成 HTTP UI fixture；真实 Web service 恢复在 recovery/web-service.test.mts
- `unit/tool-diagnostics.test.mts` 覆盖安全类别、秘密/伪造字段、未知结果与写入失败；`recovery/tool-diagnostics.test.mts` 验证真实 PG 和 observation 落库前后进程死亡。无 PostgreSQL 不能算该门禁通过
- `scripts/run-tests.mts` 显式发现对应目录的 `*.test.mts`，剥离凭据并设置临时 HOME；新增目录要同步测试发现

## 运行与隔离

从仓库根运行 `pnpm test` 或 `pnpm check`。离线测试不需要服务或模型；`pnpm test:integration` 必须配置本地独立 `mira_test` PostgreSQL。CI 通过 `pnpm check:all` 跑真实数据库。使用独立临时目录，`finally` 清理，不使用用户 Memory 或生产数据库。

Prompt 测试检查原始模板 hash、单次转义、实际请求上下文、当前上下文追加更新与恢复/压缩、能力更新同代一致、静默 Wake，以及普通请求/重启不重读 Memory、成功压缩原子刷新最新快照。ADR 0016 增加阈值/预算/工具 schema、实际输出上限、工具批次后压缩、单次溢出恢复、候选不能缩小/不能容纳、Memory 读取失败、CAS/取消/重启和未知结果不重放覆盖。

ADR 0007 回归直接工具调用与模型普通澄清，保留 schema/参数、intent 先于执行、来源/去重/恢复/CAS 边界；不重新引入 authorize stub、合成批准证据或额外授权模型调用。

边界规则必须有允许和拒绝反例。恢复测试覆盖中断、重启、重复事件、并发写入、过期版本和远端结果不明。不要用 mock 宣称模型、数据库或工具副作用真实可用。

引入需要 PostgreSQL/模型的测试时明确服务版本、启动命令、环境变量、费用授权、隔离策略、跳过条件和 CI 是否实际执行。不能将被跳过的测试记为通过。

`pnpm test:e2e` 只给子进程传入显式测试环境，不加载用户凭据；浏览器 fixture 不代表真实数据库。截图覆盖桌面与窄屏，必须检查实际渲染。

- External SDK：`unit/external-*.test.mts` 覆盖协议、客户端、真实回环 HTTP 与私有文件；`recovery/external-*.test.mts` 为真实 PostgreSQL。`deny-model-network.mts` 的 scoped 测试许可只放行显式登记的精确 127.0.0.1 HTTP origin，禁止重定向，清理后立即撤销；其余 fetch 及 http/https 外发仍拒绝。

- Dreaming：`unit/dreaming.test.mts` 验证 timer；`integration/dreaming.test.mts` 用真实 PG 验证条件/事务/COMMIT 前后进程死亡；`recovery/dreaming-service.test.mts` 走真实服务/普通工具/History/Git（仅 provider 合成）。质量探针及第一轮局限见 `docs/acceptance/dreaming-memory.md`。

- 管理：`unit/management.test.mts` 与 `integration/management-history.test.mts` 验证脱敏投影、同源HTTP和真实PG关联；`test:management:e2e` 独立经过真实浏览器/HTTP/PG/runtime/普通工具/Memory Git。后者只模拟模型，不可被fixture gate替代。ContextProvider离线机制与真实数据库/浏览器门禁分开报告。

- 附件：`test:attachments:e2e` 是独立真实浏览器→HTTP→PG→Wake/runtime→实际 `send_attachment`→不可变存储 gate（只替换 provider 返回），包括重启、重复 receipt、上传失败与截图。`recovery/attachments.test.mts` 为 PG 重启恢复，`unit/model-video-transport.test.mts` 为真实 SDK 请求的注入 fetch 验证，不可混称 live 模型。

- 调度：`unit/reminders.test.mts`、`unit/scheduling-host.test.mts`验证扩展/DST/生命周期/timer；`integration/scheduling.test.mts`覆盖真实PG及COMMIT前后子进程死亡；`recovery/scheduling-service.test.mts`穿过真实reminder_create与活动Wake/重启补扫。后两者不能用mock或standalone SQL代替。

- 组合：`recovery/agent-capabilities.test.mts` 用真实 PG/service 验证 child wait 的用户插话及后台完成不清除失败主轮；`test:capabilities:e2e` 将提醒到期、child skills/read/完成、单工具插话及重启不重复放入同一真实浏览器链路，不调用真实模型。
