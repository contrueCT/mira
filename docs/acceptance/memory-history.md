# 普通 Memory/State 与历史阶段验收

范围与最新用户约束见 [ADR 0003](../adr/0003-ordinary-memory-history.md)。所有模型调用为确定性假 provider；没有真实账户、凭据、模型费用、HTTP/UI 或部署验收。

## 覆盖

- 只有 MEMORY.md 必需，State 普通文件在 Memory Git 外，不预设分类/状态机
- 初始语义上下文保存一次；新 Runtime、重启、普通 Wake、文件编辑不重注入、不默认通知、不自动 Wake
- Pi 原生 read/write/edit/grep/find/ls/bash，默认 cwd 不限制绝对路径/外部目录；合成 shell 命令不扫描真实秘密
- Memory 改变才产生 commit；无变化记录技术 receipt，不创建 commit；包含外部/预先已有编辑且不错误声称作者
- checkpoint intent → Git ref/HEAD → PostgreSQL receipt → Wake 完成分别恢复，State 不加入；最终回复恢复不再次推理
- 历史精确 Mira 范围、来源与原始 ID，读事件/上下文/工具/Wake；有界检索与完整读取预算
- simple FTS 前缀限制和中文缺少切分显式验证；literal substring 可搜索完整原文，非语义搜索
- 迁移 up/down、数据库不可变性、writer ownership、失败/取消与数据根分离

## 验证状态

本地 `pnpm check` 已通过当前实现的类型、边界、离线测试及构建；最终测试数量、独立审查与确切 head CI 以 PR 验证结果更新。PostgreSQL 驱动/多进程场景必须由批准的 GitHub Actions PostgreSQL 18.6 服务实际执行。本地 Unix socket 禁止，未尝试 TCP 绕过；未执行的集成检查不算通过。

现有原始历史保持权威。没有重建/清空认知接口、Dreaming 调度、自动 Compaction 策略或真实模型接入。Git 和 PostgreSQL 不具备跨系统原子性，OS 权限与自然语言执行判断也不是安全沙箱。
