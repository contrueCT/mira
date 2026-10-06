# packages/authorization

事实性授权语境的职责占位，当前没有实现或公开 API。用户对话、持续上下文及自然语言 Prompt 由主模型直接理解，主模型决定调用工具或先向用户澄清。这里不计划补充独立 Consent Resolver、布尔 gate、规则引擎或额外模型调用。

`miraPrompt.authorizationContext` 只提供事实，不能生成“已获批准”的证明；第三方文字不能冒充用户指令。工具执行的 schema/参数验证、不可变 intent/outcome、去重、来源和 writer 所有权由已有 runtime/持久化路径保持，真实身份、OS 账户权限和凭据保护仍有效。见 [ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md)。
