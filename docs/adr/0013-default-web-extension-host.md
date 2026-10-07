# ADR 0013：Web 默认持久扩展宿主

状态：Accepted，2026-10-07。用户确认修复普通启动没有扩展管理能力的问题，并明确保留 Agent 正常行动过程中的对话输出。本次不改 Prompt、thinking 或 Timeline 展示。

## 决定

`pnpm start` 在未设置 `MIRA_EXTENSIONS` 时读取 `${MIRA_HOME}/extensions.json`。仅文件不存在时原子发布 `entries: []` 与绝对 `artifactsDirectory: ${MIRA_HOME}/extension-artifacts`；已有文件不覆盖。完整临时文件同步后通过不覆盖目标的 hard link 发布，并发初始化者读取已发布结果，不会看到初始化中的半份 JSON。

该配置传入已有 `LocalWebService` / `ExtensionHost`，提供 inspect、stage、manage，管理变更保存到同一配置文件。artifact 子目录仍由既有 store 按需创建。首次默认配置没有扩展，不自动安装或激活新代码；重启加载用户已保存的目标状态。

显式 `MIRA_EXTENSIONS` 始终优先，空路径、不存在、无效 JSON 或配置错误都直接失败，不退回空默认配置。已有默认文件同样不自动修复或补字段。程序化服务和 synthetic demo 的显式扩展选项不变；没有兼容层、迁移或用户数据清理。

模型继续按照持续对话及自然语言 Prompt 决定操作或澄清。未引入授权回调、批准 UI、自动授权、沙箱或新 registry 安装器。安装/激活与保存/应用分别报告的语义不变。

## 验证

回归覆盖实际 Web CLI 的默认及显式配置路径、并发初始化、已有配置保留、无效配置拒绝，以及默认 Host 的 stage/install/activate 和重启恢复。PostgreSQL service 测试核对默认管理工具到达真实运行时；不以预配置工具 fixture 代替默认入口测试。所有模型响应采用合成 provider，真实模型和用户日常配置不在本次验证范围。

工具级可用性 CLI 同样从空测试 home 经由这个默认 loader 启动真实 Host，不再预先手写扩展配置。冷评估者只使用正常 CLI、实际 Prompt/skills 与工具 schemas，无须自造 `/tmp` adapter；该测试基础设施仍不替代 PostgreSQL/HTTP 回归。
