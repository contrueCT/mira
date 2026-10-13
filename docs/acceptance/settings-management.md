# 设置管理与 ContextProvider 验收

状态：实现及修复后独立审查已完成，已执行结果见下文。合入仍须 [PR22](https://github.com/contrueCT/mira/pull/22) 最终 HEAD 的完整检查及用户确认。依据 ADR 0019/0020，主聊天保持原布局，管理只进入原设置窗口。

## 真实边界

Memory 总览读取当前 `MEMORY.md`，没有摘要模型、文件编辑 API 或第二份事实源。自然语言请求仍经普通消息信封、Event、Wake、主模型普通工具与 Memory Git；管理页根据确切原始消息查它关联的 Wake，而不是拿全局运行状态或其他 Memory 变化假定成功。changed 回执只是该 Wake 的文件快照观察，不能证明所有差异都由该请求创作。当前版本不提供逐文件 diff 浏览器。

ContextProvider 通过 SDK、真实 Cordis 宿主、同代工具/Provider 快照和 Pi 自然请求边界进入原持久 system section。观察有绑定来源、字节预算和空/失败/旧代状态；取消不发布部分数据。初始化/成功压缩的 Memory 冻结规则、重启恢复、原始历史和合法工具协议保持不变。

运行记录读取既有 PostgreSQL History、Wake 和 Memory receipt；没有新日志。只显示实际持久名称、状态、安全诊断和 commit。当前运行时没有持久化压缩失败历史，界面如实说明，不能把缺记录理解为没发生过错误。

## 验证层级

- `pnpm check`：类型、包边界、离线 Node 测试、Web 状态测试和生产构建。最终实现提交 `f0aea7d` 在本地实际通过 705 个 Node 测试、36 个 Web 测试及类型/边界/构建。
- ContextProvider 专项及既有 Host/HMR/runtime/压缩/Skills/Memory checkpoint/SDK 组合：166 项离线机制检查通过；其中 HMR 是真实官方宿主子进程，模型和 writer 为明确的合成夹具。
- `pnpm test:integration`：新增真实 PG 的精确消息关联、版本区间/成员分页、checkpoint/receipt、只读性、当前磁盘总览与冻结上下文、重启以及失败隔离；并包含生产 service/Host 配置变更的 HTTP 注入验证。
- `pnpm test:management:e2e`：独立真实 Chromium → 生产 HTTP → PostgreSQL → Wake/runtime → read/edit 等普通工具 → 实际 Memory 文件与 Git。模型响应为确定性脚本，不是实际模型质量或生产 provider 联通验收。测试不是 route.fulfill 或内存数据库；丢响应用 route.fetch 完成真实请求后断开回包，核对真实副作用仅发生一次。

真实管理浏览器覆盖记忆总览空/超限读取、只读不调用模型、自然语言修改、重复点击、处理中关闭重开、确切 Wake/commit 关联、澄清但不修改、运行详情、窄屏与重启冻结快照。扩展覆盖实际启停、重载、丢响应后的状态核对、完整配置、已有 stage 更新/回滚、实际 ContextProvider 请求与真实工具文件副作用，配置/原诊断不回显。另有从真实聊天输入 56 条、利用运行中排队形成 55 成员合并 Wake、通过设置翻页并逐一核对 PG 身份的真实浏览器用例。原 UI fixture gate 和 External SDK 的完整真实浏览器 gate 继续保留。

## 独立审查与保留的首轮失败

使用新鲜独立 `gpt-6.1-sol` / `max` 审查，未继承实现对话。首轮发现并保留修复过程：

1. 运行详情补中间页时错误前插，破坏持久版本顺序。改为按已知边界/锚点插入，不按可能倒退的 wall-clock 时间排序。
2. unknown 工具被新记录挤出最新页后，补旧页不能提升为已知结果。新增超过 50 条记录的直接复现，先失败、修复后通过；持久 outcome 仅能 unknown → 固定成功/失败，旧响应不能回退已知结果。
3. 执行记录虽分页，Wake 成员仍整批读取，大批合并输入会冲破管理响应预算。已将元信息/计数与有界成员分页分离，保留原始 History 完整读取语义；新增 1,500/6,501 成员的 PG 回归，已在 `f9c828a` 的真实 CI 执行通过。

4. 第二轮审查补充：大工具结果超过展示预算时，旧页的 unavailable 投影同样需替换之前的 unknown；增加超过 50 条记录与迟到响应回归，先失败后通过，不扩大原始读取预算。

修复后第三轮全新 `gpt-6.1-sol` / `max` 复审基于 `cb445a6→f0aea7d`，未发现有证据的新 P1/P2。审查者独立通过 83 项后端专项、36 项 Web 测试、相关类型与边界检查，以及 1,500 组分页随机交错的顺序/唯一性/可达性检查。没有把审查者未执行的 PG/浏览器当作通过。

## 真实 CI 与视觉检查

[`f9c828a` 完整 CI](https://github.com/contrueCT/mira/actions/runs/38392279779) 实际全过：705 Node、35 Web、171 PostgreSQL 集成/恢复、30 原浏览器、1 External SDK 真实浏览器链路、3 管理真实浏览器链路。随后 `f0aea7d` 只修复上述 oversized 旧页投影；它本地完整检查通过。最终文档/截图断言提交的确切 HEAD 门禁以 PR22 检查和验证说明为准，不能只凭较早 green 合入。

已实际查看这次 CI 的 Memory 桌面/窄屏、扩展桌面、运行记录桌面、模型窄屏和主聊天桌面/窄屏截图：管理仅在设置窗口内，主聊天无新增按钮/图标；长内容在窗口内滚动，窄屏无横向溢出。后续截图断言覆盖模型桌面、各管理页窄屏底部控件/结果可滚动触达，以及初始主聊天只有原设置和发送按钮。

用户要求优先本地截图后，实际尝试当前云开发环境的 HTTP 前端（可启动）及已安装 Chromium；Chromium 在 Unix socket 创建时报 `Operation not permitted`，因此未绕过限制，改交付上述真实 CI 截图。样例数据和模型响应均为合成测试内容，不是用户的真实记忆或凭据。[截图 artifact](https://github.com/contrueCT/mira/actions/runs/38392279779/artifacts/11810551998) 有 GitHub 保留期；最终截图也由 PR 的对应 CI artifact 保存。

未经用户另行确认，不合并、不部署、不修改真实用户配置。
