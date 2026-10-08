# ADR 0015：安全的工具恢复诊断

状态：Accepted，2026-10-07。用户批准补齐工具失败诊断及扩展作者契约测试；范围限定为现有恢复 observation 的可选诊断、必要的运行状态提示和普通技能说明，不增加第二套工具日志或恢复服务。

## 已确认的边界

工具 execute 抛出异常，可能发生在外部副作用之后；返回结果不能序列化也不能证明外部操作失败。原始 intent 的 outcome 继续保持 `null`，当前 Pi attempt 停止，同批后面的调用不执行。沿用原有恢复 observation，在下一模型请求之前保存已观察到的事实，再由主模型结合用户意图决定查询、澄清或发出新 call ID。没有自动重放、同参重试硬门禁、工具批准 UI 或额外判断模型。

`finishTool`、上下文写入、writer fencing 和连接丢失仍是当前 runtime 的致命错误。写入失败时不继续模型、不假造工具结果，也不保证诊断已经保存。应重新取得 writer、读取权威历史；COMMIT 响应不明时，不能从异常猜测数据库是否提交。

## 当前恢复格式

沿用 envelope v1、Pi 1.0.2 与 `mira.recovery-observation.v1`。每个原有 recovery operation 可附加 `diagnostic: {phase, category}`；无新增表、迁移、journal、checkpoint 格式或历史改写。

仅允许四种组合，解释文字由 runtime 固定生成：

- `execute / execution-rejected`：工具执行拒绝，需核对外部状态
- `execute / event-content-conflict`：事件或 Wake identity 与已保存内容冲突，需检查原始 receipt。重试保留 exact identity、时间、payload 与 Wake 选择；真正的新事件采用新 identity
- `result / invalid-json-result`：返回结果不能表示为合法的 runtime JSON 或必要 tool-result 结构，应修复结果契约并核对外部状态
- `result / non-finite-result`：返回结果中存在 Infinity、-Infinity 或 NaN，应返回有限 JSON 数字并核对外部状态

诊断必须是普通对象，恰好包含 `phase`、`category` 两个键；phase 最多 7 字符，category 最多 32 字符，完整固定 ASCII JSON 最多 96 字节。未知值、额外字段、错误组合或非对象均拒绝。诊断仅能关联同一未决 batch 中有实际 intent、无 outcome 的真实调用。`not-started` 和已知 outcome 不得携带诊断。重启会重新验证 call、assistant record、工具名、原始/验证参数、顺序、状态与 outcome，不能用 canonical-looking 文字隐藏损坏的证据。

诊断不读取或保存任意工具 Error.message、cause、stack、headers、返回值片段或参数。原始 requested/validated arguments、已知工具结果及现有来源记录仍按原契约保存；该窄诊断不是对全部既有历史的删除或脱敏转换。

进程在 observation 落库前退出，下一次恢复只知道 unknown outcome，没有可重建的错误原因；可选诊断保持缺省。落库后的诊断随重启及现有 compaction/advisory 保留，摘要措辞不能覆盖未决事实。

## 可信错误与持久化 API

Life 仅提供小型 `DurableOperationError` 标签，不导入数据库或 Pi。标签由私有实例字段识别，普通 lookalike 对象、同名 message、driver code、嵌套 cause 或伪造 prototype 都不能选取诊断类别。

`PersistenceError` 保留既有 name、code 和两参数构造；第三个类别参数是可选的。普通 invalid/version/duplicate 错误不自动标成写入故障。只有 receive 的两个 identity/content 冲突点提供 `event-content-conflict`。实际停止的 writer、未知事务故障，以及 runtime 的真实 publication 异常标记为 `persistence-write-failure`，并保持致命停止；内部原异常不作为诊断文本。

JSON 边界保留 undefined 对象属性省略和完整 defined JSON 语义。验证器提供类型化的安全类别；工具异常不能靠模仿 Non-JSON 错误文字伪装为结果验证失败。已保存 outcome 缺少 transcript 时，仍按原 JSON 和 timestamp 精确补回，不添加诊断或更改结果。

execute 返回后、Pi 首次读取 `isError` 前，adapter 验证普通结果对象、有限且无环的 JSON、合法 text/image 内容、usage 及可选布尔字段，并返回脱离原对象的 canonical 快照。保留 Pi 1.0.2 对普通对象缺省/null content 归一化为 `[]` 的行为及全部 defined JSON 字段，含 `structuredContent`、`terminate`；支持的字段包括不可枚举 accessor，只读取一次。根 null/undefined/原始值及抛错 getter 归入 result phase，不允许 Pi 将其原异常变成已知错误 outcome。after-hook 继续验证组装后的工具消息，`finishTool` 故障边界保持致命。

## Web 提示

沿用 `/api/status` 的 error 文本和现有必要状态 notice。可信持久化故障只显示固定、临时的服务器提示，明确没有确认 durable tool diagnostic；没有新增工具 chip、工具 trace、API 成本字段或正常聊天活动。原始数据库/工具错误、headers 和秘密不会通过此提示返回。未知普通错误仍使用保护性的通用文字。

## 验证范围

- `tests/unit/tool-diagnostics.test.mts`：先红后绿的 execute/nonfinite 回归、普通错误语义、秘密不进入诊断、伪造实例、非 JSON 值、严格恢复链接和大小、已知结果不变、写入前后失败、落库失败后无原因的恢复、compaction
- `tests/unit/web-http.test.mts`：可信临时提示、未知错误保护、精确 HTTP 字段及 Timeline 无工具展示
- `tests/recovery/tool-diagnostics.test.mts`：显式隔离 PostgreSQL、独立进程恢复、observation 提交前后实际进程退出、真实 outcome 写入故障、Web 真实组装状态提示与同 Wake 恢复
- 扩展作者的 event/finite-result 契约测试分别位于 `tests/recovery/extension-event-contract.test.mts`、`tests/unit/extension-result-contract.test.mts`

离线测试不证明 PostgreSQL、浏览器或真实模型联通。此增量的本地 executor 未提供 PostgreSQL 服务；真实数据库和 Chromium 需在确切提交的 CI 单独验证。具体通过数量和审查结果以对应执行记录为准，不以本 ADR 或历史 CI 成功替代。
