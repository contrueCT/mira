# External SDK 验收

状态：实现及验证进行中，2026-10-13。依据 ADR 0017；不把目标、模拟、历史分支通过当成本次完成。

## 已执行的早期基础检查

2026-10-11 Event/Wake 协议及薄 ingress 增量 `pnpm check` 通过，611 个基础/后端与 19 个 Web 测试；当时没有网络客户端、接入凭据或通知实现。此结果不代表本次最终增量已经通过。

## 本次验收范围

- 严格 JSON、来源/字段不可伪造、时间/深度/字节边界；SDK 取消/超时、无自动重试、精确 receipt 与秘密脱敏。
- 本地凭据 CLI、默认关闭、身份隔离、轮换/撤销逐请求生效、权限/链接/损坏文件、并发与崩溃窗口。
- 真实 HTTP 回环 SDK 交互；Web 与外部入口防护分别测试，禁止外部浏览器 Origin，保留 Host/CSP 和请求限制。
- 真实 PostgreSQL 并发、原子 Event/Wake、去重/冲突回滚、同一主循环与未知工具结果恢复；通知不 Wake、重启后同一 History ID。
- Chromium 桌面/窄屏 Timeline notice 的来源、时间、刷新与文本安全。
- 新的独立模型首次使用真实 CLI/SDK/HTTP；内存 fixture 与 PostgreSQL gate 分开记录。
- 每轮实现/修复后全新独立审查，最终确切提交完整 CI。

本地 PostgreSQL 18.6 启动在 Unix-domain socket 处遭环境 EPERM，未绕过该限制；真实驱动/恢复验收将以 CI 的隔离 PostgreSQL 18.6 为准。无真实用户长期凭据、生产 provider、付费调用或部署。

## 2026-10-13 独立首次使用

全新 native agent，不继承实现对话；只读公开 SDK README、示例与 CLI help，使用普通 Shell 写仓库外独立 Node 脚本并实际执行 SDK/HTTP 请求。

- 首次执行被测试会话的 loopback 隔离阻塞：第一个 emitEvent 返回 network_error/unknown，connection refused，fixture evidence 为 0。不能称为首次全流程通过，也未据网络异常猜测真实持久状态。
- 测试宿主补充 `--run`，把真实 HTTP listener 与原作者脚本放到同一工具进程。保持脚本、ID、时间和信封完全不变，明确以 retry #1 执行成功。
- 观察到 3 inserted、4 duplicate，2 个不同源事实、1 个通知、恰好 1 个 inserted Wake；所有重复信封与原始内容 deep-equal，kick 计数为 `[0,0,1,1,1,1,1]`。
- 同一运行中的客户端在下一调用读取轮换后的凭据并成功，无需重启。撤销后 loader 返回 credentials_unavailable/not_sent；缓存旧凭据的请求收到 401/rejected，未接收新事件。
- 通知证据 source=external、senderId=cold-watcher，保留作者现成中文正文。可见 Timeline 渲染未在此测试验收，另由 Chromium gate 覆盖。
- 文档足以完成 API/管理流程，无产品 API 误用或修补；测试拓扑需要宿主介入。实际 CLI 运行时 pnpm 为环境现有 11.25.0；最终工具链 gate 单独使用声明的 11.28.4，此处不把二者混记。

独立脚本 SHA-256 `fc3c71653e1e6b1b0b3666ceed95c84f82a5b220d5dfc77002961ae63d0954eb`；不可变源信封 SHA-256 `04dadb4f414b8c70197085f2771cd26b702cb23fbd1ecdeb7e0e613d138546b1`。所有凭据/文件均在隔离临时 home，最终身份已撤销。原始失败、成功重试、验证摘要与 evidence 均保留在本次临时 fixture 目录，不含 token 输出。

本次 cold fixture 使用生产认证、ingress、真实 HTTP 与客户端，但事件存储是内存，未调用模型，不代表 PostgreSQL durability、进程恢复或模型行为。后续 `--run` 子进程使用显式环境白名单，防止无关环境凭据继承；这不改变前述首次尝试记录。

## 本地浏览器限制

已执行完整 `pnpm test:e2e` 尝试。Chromium 在创建进程 singleton Unix socket 时因环境 EPERM 启动失败，29 个浏览器用例未执行，1 个非浏览器 HTTP origin 用例通过。没有截图可供本地视觉验收，不通过替代参数绕过权限；由最终 CI 重新执行全部 30 项并产出截图。

## 第一轮独立审查与修正

全新 gpt-6.1-sol / max 审查全部生产增量、示例及测试，并运行 67 个 external 单元测试，全部通过。发现一个 P2：payload 的共享引用 DAG 在最终字节校验前展开，极小输入可耗尽客户端资源。修正为克隆期间逐项计算展开 JSON 的 UTF-8 预算，超限立即停止；追加带访问次数护栏的 29 层重复 DAG 回归，防止测试自身触发无界分配。保留最终完整信封的字节校验。

审查同时明确指出两处分段覆盖，实际 CLI/HTTP 测试终止于内存 writer，PG 恢复测试直接调用 service；原 notice 浏览器测试只注入 Timeline 响应。因此新增单独的 `pnpm test:external:e2e`，要求真实隔离 PG，串起生产 CLI/凭据、SDK、HTTP、同一 writer、WakeLoop/runtime 与真实页面；模型依旧为确定性合成 stream。该 gate 不替代原本独立的恢复/异常测试，也不在数据库缺失时静默 skip。执行结果仍需最终确切提交 CI 确认。

第一轮未发现已批准设计偏离、无用的新领域/审批层、显著冗余抽象或生产代码组织混乱。HTTP 与可独立调用的 ingress 重复校验属于两个不同边界。修正及新增真实链路测试仍须全新独立审查，不能沿用本轮清洁结论。

## 第二轮独立审查与修正

另一位全新 gpt-6.1-sol / max 审查确认 68 个 external 单元测试通过，新增真实链路 gate 的生产路径和断言连通，未发现新的 P1/P2、设计偏离、显著冗余或组织问题。发现一个 P3：Web 启动支持相对 `MIRA_HOME`，而管理 CLI 未解析为绝对路径。CLI 现与 Web 一致解析环境/default 路径；显式 `--home` 仍要求绝对路径。追加真实子进程相对环境路径回归，不创建用户数据；再次交由全新独立审查。

修正前的完整本地 `pnpm check` 已使用 Node 24.19.0 / pnpm 11.28.4 通过 668 个基础/后端测试、19 个 Web 测试、类型/边界与构建。相对路径修正后的全量结果单独记录，不把该修正前结果作为最终提交证据。真实链路测试以生产模块进行程序化组装，并非启动 `pnpm start` 子进程；只将模型 stream 替换为合成实现。真实 PostgreSQL 与 Chromium 仍待 CI 执行。

相对路径修正后的完整本地 `pnpm check` 已通过：669 个基础/后端测试、19 个 Web 测试，0 失败；Node 24.19.0 / pnpm 11.28.4，类型、包边界与生产构建也通过。此结果不包含受环境限制的真实 PG 和浏览器 gate。

## 最终独立代码审查

第三位全新 gpt-6.1-sol / max 对全部最终生产增量及两次修正给出清洁结论，无新的可行动问题；独立执行 69 个 external 单元测试、包边界与 diff 检查均通过，真实链路 discovery 为 1 项且缺少数据库时明确失败。按用户指定四项核查：测试有真实串联 gate，已批准设计无确认偏离，没有显著冗余生产抽象，职责/文件组织清楚。

执行边界仍明确：该审查没有运行受限的 PG/Chromium 或检查截图；关闭/重新打开的 PG 恢复测试不等于强杀进程，也未把认证 HTTP 与恢复同时组合；没有 live provider 判断质量验收。后续以 PR 确切 head 的完整 CI 和截图核验补齐 PG/浏览器执行证据。
