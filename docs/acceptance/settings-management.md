# 设置管理与 ContextProvider 验收

状态：实现与独立审查进行中，尚未完成最终确切提交验收；本页会随修复和 CI 结果更新。依据 ADR 0019/0020，主聊天保持原布局，管理只进入原设置窗口。

## 真实边界

Memory 总览读取当前 `MEMORY.md`，没有摘要模型、文件编辑 API 或第二份事实源。自然语言请求仍经普通消息信封、Event、Wake、主模型普通工具与 Memory Git；管理页根据确切原始消息查它关联的 Wake，而不是拿全局运行状态或其他 Memory 变化假定成功。changed 回执只是该 Wake 的文件快照观察，不能证明所有差异都由该请求创作。当前版本不提供逐文件 diff 浏览器。

ContextProvider 通过 SDK、真实 Cordis 宿主、同代工具/Provider 快照和 Pi 自然请求边界进入原持久 system section。观察有绑定来源、字节预算和空/失败/旧代状态；取消不发布部分数据。初始化/成功压缩的 Memory 冻结规则、重启恢复、原始历史和合法工具协议保持不变。

运行记录读取既有 PostgreSQL History、Wake 和 Memory receipt；没有新日志。只显示实际持久名称、状态、安全诊断和 commit。当前运行时没有持久化压缩失败历史，界面如实说明，不能把缺记录理解为没发生过错误。

## 验证层级

- `pnpm check`：类型、包边界、离线 Node 测试、Web 状态测试和生产构建。初轮通过 702 个 Node 测试；UI 修复增至 35 个 Web 测试，最终数量以最终确切提交执行为准。
- ContextProvider 专项及既有 Host/HMR/runtime/压缩/Skills/Memory checkpoint/SDK 组合：166 项离线机制检查通过；其中 HMR 是真实官方宿主子进程，模型和 writer 为明确的合成夹具。
- `pnpm test:integration`：新增真实 PG 的精确消息关联、版本区间/成员分页、checkpoint/receipt、只读性、当前磁盘总览与冻结上下文、重启以及失败隔离；并包含生产 service/Host 配置变更的 HTTP 注入验证。
- `pnpm test:management:e2e`：独立真实 Chromium → 生产 HTTP → PostgreSQL → Wake/runtime → read/edit 等普通工具 → 实际 Memory 文件与 Git。模型响应为确定性脚本，不是实际模型质量或生产 provider 联通验收。测试不是 route.fulfill 或内存数据库；丢响应用 route.fetch 完成真实请求后断开回包，核对真实副作用仅发生一次。

真实管理浏览器覆盖记忆总览空/超限读取、只读不调用模型、自然语言修改、重复点击、处理中关闭重开、确切 Wake/commit 关联、澄清但不修改、运行详情、窄屏与重启冻结快照。扩展覆盖实际启停、重载、丢响应后的状态核对、完整配置、已有 stage 更新/回滚、实际 ContextProvider 请求与真实工具文件副作用，配置/原诊断不回显。另有从真实聊天输入 56 条、利用运行中排队形成 55 成员合并 Wake、通过设置翻页并逐一核对 PG 身份的真实浏览器用例。原 UI fixture gate 和 External SDK 的完整真实浏览器 gate 继续保留。

## 独立审查与保留的首轮失败

使用新鲜独立 `gpt-6.1-sol` / `max` 审查，未继承实现对话。首轮发现并保留修复过程：

1. 运行详情补中间页时错误前插，破坏持久版本顺序。改为按已知边界/锚点插入，不按可能倒退的 wall-clock 时间排序。
2. unknown 工具被新记录挤出最新页后，补旧页不能提升为已知结果。新增超过 50 条记录的直接复现，先失败、修复后通过；持久 outcome 仅能 unknown → 固定成功/失败，旧响应不能回退已知结果。
3. 执行记录虽分页，Wake 成员仍整批读取，大批合并输入会冲破管理响应预算。已将元信息/计数与有界成员分页分离，保留原始 History 完整读取语义；新增 1,500/6,501 成员的 PG 回归，等待 CI 真跑。

修复后的新鲜复审与最终 CI 尚待记录。未经用户另行确认，不合并、不部署、不修改真实用户配置。
