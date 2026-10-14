# ADR 0022：持久单次延迟投递与提醒扩展

状态：Accepted，2026-10-14。用户确认补全持久提醒，并明确区分系统职责与扩展业务；本次只实现单次，不引入 cron、后台任务引擎、语义 State 或新的审批层。

## 分层

Life 拥有 ScheduledDeliveryInput / SchedulingWriter 契约。输入为稳定 key、规范 UTC dueAt、opaque Event、可选 Wake 与可选 expiresAt。系统只将冻结数据投递至既有队列，不理解“明早”、时区、提醒文案或周期。

扩展 SDK 暴露 owner 作用域内 schedules.create/get/list/replace/cancel。单次提醒示例提供四个普通工具，负责明确本地日期、时刻、IANA 时区与 DST 校验，以及错过时补发或超时跳过的政策。主模型结合对话决定工具参数或澄清，没有第二次模型调用，没有每次醒来计算下一周期。示例不会自动安装或开启真实提醒。

## 原子性与真实结果

scheduled_deliveries 身份为 Mira + 稳定安装 owner + key。相同 key 与当前完整输入相同返回 duplicate，不同输入返回 conflict。occurredAt 属于输入，重试不能重新生成。replace/cancel 使用 expectedVersion，只能修改 pending；成功增加版本。终态不复用 key。

状态为 pending、enqueued、cancelled、expired。mutation 返回 updated/duplicate/conflict/settled/missing，并返回当前 delivery。settled 且 delivery.status=enqueued 表示已入队、无法撤回，不能声称已取消。重复取消可读回 cancelled。提交回执丢失后用 get/list 确认事实，不自动重放未知外部工具效果。

PG 在现有独占连接、session advisory lock 与 epoch 检查下，将普通 Event/Wake 插入和 enqueued 标记放进同一事务。入队沿用全局 History UUID 与去重路径。改期与到期、取消与到期在同一 writer 的事务队列串行判定，不保存另一份过时定时器任务。到期且数据库当前时间 >= expiresAt 时记录 expired，不入队。

到期入队不等于立刻回复。当前认知轮不会被打断，新 Wake 等待既有串行循环；模型不可用/当前轮失败时入队事实仍保存，不借 timer 清错或自动重试失败认知。没有外部副作用 exactly-once 承诺。

## owner 与生命周期

owner 绑定配置扩展 ID 和持久安装身份。生成扩展复用 generated.history 首 revision ID，更新、回滚、重载不改变它。手工扩展在既有 ConfigurationWriter 链路保存 installationId 后提供调度；没有配置文件的程序化宿主须显式提供 installationId。不能使用每次 activation 的随机 ID 或工具名。

disabled、removed、加载失败或依赖未就绪的 owner 不参与投递，pending 保留。相同安装重新启用或重启时按 dueAt/expiresAt 补扫，已 enqueued 的历史不撤回。remove 后新安装取得新身份，不继承旧提醒。旧记录仍可通过 extension_inspect 的 schedules 对账，没有自动删除。恢复原配置及安装身份意味着明确恢复同一个逻辑安装。

显式生命周期变更和扫描共享宿主串行边界。某次入队可能先于 disable/remove 完成，故停用也不撤回既有队列。HMR/依赖变化由下一次扫描观察，持久事实不依赖旧代码仍在内存。

## 运行与验证

Web 启动补扫，独立 DeliveryTimer 根据数据库返回的下一时间唤醒，最长 30 秒重查以观察时钟校正或 HMR/依赖变化。timer 不保存事实，也不是 Dreaming scheduler；Dreaming 的条件和游标不变。关闭先等待正在进行的到期事务，再关闭宿主/writer。有限批次演示 CLI 仅启动补扫，不承诺退出后后台投递。

离线测试验证 SDK、时区/DST、身份与生命周期。真实 PG 集成/子进程测试验证 CAS、去重、fencing、事务前后崩溃与丢回执；service 恢复测试仅替换模型，不能用 mock 代替 PG 证明。本地 Unix socket 限制导致 PG 服务无法启动，真实驱动/进程门禁以确切提交 CI 验收。未调用真实模型、未部署、未启用用户提醒。
