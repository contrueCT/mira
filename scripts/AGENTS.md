# 基础工具与 CI

共享规则见 [根 AGENTS.md](../AGENTS.md)。本文路径相对于 `scripts/`。本文件也提供修改根配置或 `.github/workflows/` 时需要按需读取的专门指引。

## 入口

- `check-boundaries.mts`：TypeScript AST、manifest、exports 和依赖图检查
- `boundaries.json`：已知 workspace 包路径及最小允许依赖
- `../tests/foundation/boundaries.test.mts`：规则正反例
- `../.github/workflows/ci.yml`：CI，完整 SHA 固定 Action

## 验证

从仓库根运行 `pnpm check`；编译后可运行 `node dist/scripts/check-boundaries.mjs`。修改安装配置时用 `pnpm install --frozen-lockfile` 验证锁文件一致性。

## 陷阱

- 新增 workspace 包必须同时更新策略；不要默认放行所有内部依赖
- 检查静态/动态导入、重导出、类型导入和 manifest-only 依赖，不能只用正则扫 import
- 静态边界检查不是未知代码沙箱；生成执行边界见 ADR 0005，不能把静态检查通过当作安全授权
- `create-extension-workspace.mts` 只复制模板/链接已有私有 SDK 和工具；`extension-artifact.mts` stage 不执行代码，test 执行显式 native command
- `tool-usability.mts` 从空测试 home 通过 Web 默认配置 loader 启动真实 Host；不预写扩展配置，不要求评估者另造 adapter。数据库/HTTP 不在该工具级 fixture 的验证范围
- CI 保持最小权限和无凭据测试，新增 workflow 权限或 secrets 使用前先确认
- 包管理器/TypeScript 升级要验证 API、锁文件格式、真实干净安装、测试和工具构建

- `external-sdk-usability.mts` 使用真实本机 HTTP、生产认证与 ingress、隔离临时 home，持久化明确为内存 fixture；输出/evidence 不含 token。独立作者使用正常 CLI/SDK，不读取实现；不能以此代替 PostgreSQL gate。
- `prepare-extension-package.mts` 只准备选定源码与已安装的声明运行时依赖闭包；无安装、市场或供应商特例。原有 snapshot/hash/test/install 不变；依赖版本/路径、pnpm、optional/peer 和循环图须有反例验证。

- 准备helper在写目标之前拒绝源码树内部符号链接，避免展平后改变Node相对导入；声明runtime闭包中的受控依赖/pnpm链接仍支持。
- 准备器仅支持根运行时依赖声明；拒绝嵌套安装/运行时声明、源码与依赖或目标闭包重叠、排除树入口和入口URL元字符。普通根node_modules及仅type/imports/exports子作用域必须保留正例。
