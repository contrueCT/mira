# 文档

共享规则见 [根 AGENTS.md](../AGENTS.md)。本文路径相对于 `docs/`。

## 入口与事实来源

- `design/architecture-v0.5.md` 是最新设计，`design/system-prompt-design-v0.1.md` 是 Prompt 设计；实际 v0.2 模板在 `../packages/runtime-pi/prompts/`
- 上述原文及 `design/original-v0.4.md` 历史存档保留原始字节；来源、大小与 SHA-256 见 `design/sources.json`
- `adr/0006-memory-only-system-prompt.md` 记录 Memory-only、动态 Prompt、快照与既有宿主 OS 执行边界的解释优先级
- `architecture.md` 保存已确认边界；`adr/README.md` 区分批准与待决策
- `development/` 保存真实规则、版本和命令
- `acceptance/foundation.md` 是目标清单，不能当成已完成报告

## 验证

核对所有相对链接，命令要真实执行，版本需注明依据。修改原始设计需用户明确要求；其他说明通过新文档或 ADR 记录演进。状态明确写已实现/实验/待确认/未执行。

行为、配置、公开接口、测试发现与运行方式变化必须在同一 PR 更新文档。不要记录凭据、用户隐私、内部工作笔记或未经证实的性能/安全承诺。
