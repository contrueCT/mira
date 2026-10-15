# Extension SDK

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 为唯一公开 API；`defineExtension` 不导入 Cordis/Pi/数据库类型。
- 本目录负责扩展唯一的 Mira 公共契约入口。

## 本地约束与跨包陷阱

- 保持平台独立，不导入核心内部、Pi、Cordis、数据库或 Node 平台模块
- 只暴露注册工具、事件、Wake 等批准能力；不得暴露直接改历史/上下文的通道
- ContextProvider 是自然请求的只读来源数据，注册/大小/取消/生命周期见 [ADR 0019](../../docs/adr/0019-extension-context-providers.md)；不直接改上下文、Memory 或产生 Wake
- 新增公共 export 需兼容性考虑及消费者测试，避免映射整个内部类型树

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。离线验证见 `tests/unit/extension-host.test.mts` 和 `tests/unit/official-hmr.test.mts`；实际 HMR 子进程使用 `--expose-internals`，不调用真实模型。
- ADR0035：credentials/privateDirectory/registerSettings 为通用私有设置能力；无框架类型、OAuth引擎或沙箱承诺，secret仅设置输入，普通字段继续config重载。
- registerSettings返回本安装/activation专属动作handle，只含安全operation receipt，不把protected status/providerURL变成模型能力；由插件选择对话工具。
- ADR0040: registerToolset exposes atomic candidate replacement and revision-bound stale execution; isError is a known outcome, not an exception/unknown. No MCP types or framework imports enter this contract.
