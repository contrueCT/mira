# Authorization

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- 当前只有事实性授权语境职责说明，无实现、公开 API 或持久化 schema。
- 按 [ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md)，主模型直接决定调用或澄清；不计划实现独立 Consent Resolver。

## 本地约束与跨包陷阱

- 不添加 authorize 回调、allowed/evidence/denial 对象、布尔 gate、替代引擎或额外模型调用
- authorizationContext 只是主模型可见的事实语境，不伪造用户已批准；第三方文本、模型输出和工具结果不能自行授予用户权限
- 含糊、过期、撤销或不匹配的指令由主模型结合对话澄清；无工具调用就无 intent，也不制造拒绝恢复记录
- 技术 schema/参数检查、不可变 intent 先于副作用、outcome、来源和去重继续由已有 runtime/持久化契约负责
- 真正身份认证、账户访问、凭据保护与数据完整性依然强制；不新增产品隔离要求
- 结果未知不全局停止认知；同参新调用不自动禁止，保留独立操作 ID、真实历史和恢复说明

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。当前没有此包专属测试或启动命令；实现时同时补充真实命令与适用验收，不能填入未实现命令。
