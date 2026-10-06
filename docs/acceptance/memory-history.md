# 普通 Memory 与历史阶段验收

当前约束见 [ADR 0006](../adr/0006-memory-only-system-prompt.md)，早期阶段历史见 [ADR 0003](../adr/0003-ordinary-memory-history.md)。所有模型调用为确定性假 provider；没有真实账户、凭据、模型费用、HTTP/UI 或部署验收。

## 覆盖

- 只有 MEMORY.md 必需，无独立 SemanticState、stateRoot 或 stateFiles；只维护当前 Memory-only 设计，不预设分类/状态机
- 初始语义上下文保存一次；新 Runtime、重启、普通 Wake、文件编辑不重注入、不默认通知、不自动 Wake
- Pi 原生 read/write/edit/grep/find/ls/bash，默认 cwd 不限制绝对路径/外部目录；合成 shell 命令不扫描真实秘密
- Memory 改变才产生 commit；无变化记录技术 receipt，不创建 commit；包含外部/预先已有编辑且不错误声称作者
- checkpoint intent → Git ref/HEAD → PostgreSQL receipt → Wake 完成分别恢复；最终回复恢复不再次推理
- 历史精确 Mira 范围、来源与原始 ID，读事件/上下文/工具/Wake；有界检索与完整读取预算
- simple FTS 前缀限制和中文缺少切分显式验证；literal substring 可搜索完整原文，非语义搜索
- 迁移 up/down、数据库不可变性、writer ownership、失败/取消与数据根分离

## 历史阶段验证（不代表本次 v0.5/Prompt 增量通过）

2026-10-05，代码提交 `d1e92b1de36c5babfce390b4801bbcfa33475c1d` 的 `pnpm check:all` 已在 [GitHub Actions](https://github.com/contrueCT/mira/actions/runs/37326159094) 通过：142 项离线 + 79 项真实 PostgreSQL/恢复测试，共 221 项，零失败、零跳过。两份严格 TypeScript 检查、包边界及构建通过。本地独立重跑 `pnpm check` 亦为 142 项通过。最终文档提交的确切 CI 状态及独立审查结论见 [PR #4](https://github.com/contrueCT/mira/pull/4)。PostgreSQL 驱动/多进程场景由批准的 GitHub Actions PostgreSQL 18.6 服务实际执行。本地 Unix socket 禁止，未尝试 TCP 绕过；未执行的集成检查不算通过。

现有原始历史保持权威。没有重建/清空认知接口、Dreaming 调度、自动 Compaction 策略或真实模型接入。Git 和 PostgreSQL 不具备跨系统原子性，OS 权限与自然语言执行判断也不是安全沙箱。

本批审查和 CI 曾发现并修复：Git receipt/HEAD 部分落盘、同路径替换 Git 仓库丢失 lineage 身份、内联 Wake 默认工具目录不存在，以及 Pi edit 可选旧格式预处理与持久化边界不兼容。对应回归覆盖精确父 HEAD CAS 修复、仓库 UUID 校验、无 overflow 的原生 Shell、规范 edits[] 的授权先于执行，以及 Git 成功/PG receipt 失败后的模型零重跑。
