# ADR 0012 全局 History UUID

状态：Accepted，2026-10-06。

## 决策

History 采用真正统一的全局 UUID 身份。薄表 `history_records` 只拥有 `id`、`mira_id` 和 `kind`，四类详情通过匹配 ID、Mira、固定类型的外键关联。数据库主键保证不同类型和不同 Mira 不能共用一个 History UUID；身份和详情在原有持锁事务中一起提交或回滚。

`history_read` 仅接收 `id` 与可选读取预算，返回中说明类型。搜索、分页、上下文父链、Wake 关联和 Memory commit 使用同一清晰 UUID，不加前缀，不编码，不增加解析服务。原始外部事件 ID、Wake receipt 去重键、供应商 tool-call ID 保持原样，作为独立的来源与协议字段，不能用作 History ID。

Pi 公共压缩流程仍在内存中运行。仅新建的压缩候选改用完整 UUID；既有原文、parentId、firstKeptEntryId、工具调用/结果配对与恢复证据不重写。

Memory commit 的 `History-Id` trailer 直接保存对应 Wake UUID。`Mira-Run-Key` 仍是内部 Git receipt 的恢复键，用于校验 Mira/run 身份、查找已完成提交及修复崩溃窗口，不对外充当 History 引用。无变化回执、HEAD CAS、仓库身份校验和 PostgreSQL checkpoint 关联继续保留。

## 新建数据环境

用户确认这一早期开发改动从新空数据库和新的适用运行目录开始，不做旧数据兼容。直接更新当前初始 schema，文档说明新环境要求。程序不包含额外旧库检测、历史映射、兼容分支或自动清理；本改动不运行、清空或转换现有用户库。旧数据自行保留在原位置。

## 验证边界

回归覆盖全局冲突与类型/Mira 外键、重复外部事件去重、事务/CAS 回滚、工具不明结果与精确恢复、压缩 UUID、Memory 崩溃恢复、搜索/分页/原文读取，以及 Web 请求去重身份与展示身份分离。真实 PostgreSQL driver/并发测试须运行 `pnpm check:all`；离线 mock 或单用户 SQL 引擎验证不能代替它。
