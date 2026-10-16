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
- 请求重试：`unit/model-retry.test.mts` 注入真实Pi SDK的HTTP/SSE故障，覆盖partial/取消/unknown不重放；`recovery/model-retry.test.mts`走真实PG/service/普通bash与重启，不能用离线fixture替代。浏览器fixture单独验证状态提示。

- 网页密码：`unit/web-auth.test.mts` 验证 hash/cookie/限速/全API保护；`test:auth:e2e` 在真实 PG/HTTP/浏览器链路测试非loopback Host、登录/注销/改密/关闭/附件与截图，不使用真实凭据。
- 终端：`unit/terminals.test.mts`真实spawn/PTY/进程树与owner崩溃；`recovery/terminals.test.mts`真实PG/service跨轮次与插话边界。执行前显式 `pnpm terminal:prepare`，Mac/Linux CI不可用mock替代真实PTY。

- 受管浏览器：browser-manager/browser-http 离线机制、browser.spec UI fixture 与 browser-real 实际 daemon/PG/HTTP/浏览器链路分开报告；本地 socket/Chromium 被拒绝时不得将编译成功计为验收。

- 浏览器 native socket 合约由 run-tests 的 MIRA_TEST_REQUIRE_HOST_SOCKETS 标记在 CI 禁止跳过；该 test-only 标记不传 native 环境，不透传会改变 sandbox 行为的 CI。
- ADR 0039: task-live-input offline Pi and task-live-runtime/task-live-persistence real PG gates cover ordered parent input, single-tool/model yield, final admission, lost acknowledgements, terminal receipts and task ownership. Existing task summary cancellation tests remain mandatory; mocks cannot establish cross-connection lock correctness.
- 扩展私有设置：extension-settings.test.mts验证真实Cordis/文件生命周期；management-real.spec.ts增加真实PG/HTTP/浏览器设置和二维码截图。离线通过不代表真实外部认证。
- ownership：真实PG backend终止→Web service→扩展清理/动作取消/unknown接管；不能用手动service.close或仅mock AbortController替代这条恢复链。
- MCP：mcp-plugin/http/runtime/oauth/generated-install 与 extension-toolsets 使用真实官方 SDK 和合成 server/auth；test:mcp:e2e 贯穿普通 artifact tools→Host→HTTP→PG→浏览器，保留未知结果不重放及桌面/窄屏截图。不是 live provider 验收。


- ADR0043：replies 的离线边界、真实PG/recovery与 `test:replies:e2e` 分开报告；验证双向 canonical History 引用、插话/压缩/重启、子任务隔离、旧待确认请求幂等和真实桌面/触屏布局。引用文字是数据，不能构成权限；私人参考图不进源码。
- `behavior/reply-probe.mts` 捕获真实请求交给冷启动 native 模型作首次选择，`behavior/fixtures/reply-native-traces.json` 保留其实际决策和工具结果；PG/browser 回放只允许按唯一来源绑定新 UUID/索引路径，不得重写所选对象、正文或工具顺序。生产工具 schema 必须核对一致。行为模拟、录制回放、真实用户配置模型的质量结论必须区分，任何失败首轮不可删除或冒充成功。
