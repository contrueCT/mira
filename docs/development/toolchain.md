# 基础工具链

状态：用户已确认工具链方向，以下是可重复的具体版本。build 只构建开发检查工具；运行时包用 Node 24 的 TypeScript 类型擦除执行，尚无应用构建。

| 工具 | 固定版本 | 用途 |
| --- | --- | --- |
| Node.js | `.node-version` 中的 24.21.0 | CI，Node 内置测试与 TypeScript 类型擦除 |
| pnpm | 11.28.4 | workspace 与锁文件安装 |
| TypeScript | 6.0.3 | 严格类型检查、工具构建、AST 依赖分析 |
| @types/node | 24.19.1 | Node 24 类型 |

本地兼容范围为 Node 24.19.0 至 24.x；CI 使用精确版本。Node 24 LTS 状态及 pnpm Node 24 兼容性已按[官方 Node 版本说明](https://nodejs.org/en/about/previous-releases)和[pnpm 安装说明](https://pnpm.io/installation)核验。

pnpm 12 当前采用原生可执行文件；本环境中依赖安装的 operation-lock 路径失败，因此使用官方仍提供的 JavaScript 版本 pnpm 11。TypeScript 7 已改变包内编译器实现；本检查器使用 TypeScript 6 的 JavaScript AST API，故固定 6.0.3。升级任何一个版本都要重跑完整基础检查和负例测试。

## 命令

在仓库根目录，安装 Node 和 `package.json` 固定的 pnpm 后运行：

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 顺序执行：

1. `pnpm typecheck`：所有已有 TypeScript 源文件的严格检查
2. `pnpm boundaries`：包目录、manifest、exports、依赖图、实际模块导入
3. `pnpm test`：Node 内置测试框架中的基础验证、违规反例和离线运行时测试
4. `pnpm build`：将检查工具编译到 `dist/`，不代表应用已可运行

CI 固定第三方 Action 的完整 commit SHA，只有只读仓库权限，不保存 checkout 凭据，不提供真实模型/生产数据库/部署凭据。CI 的 PostgreSQL 18.6 服务仅使用固定合成测试凭据。安装脚本默认不获允许。pnpm 11 的 `engineStrict`、`saveExact` 放在 workspace YAML；测试实际查询配置并验证不支持的 Node 版本会拒绝安装，不依赖已不生效的 `.npmrc` 配置。

## 包依赖策略

`context` 导出 JSON envelope 与快照，`life` 导出持久化契约；`persistence` 与 `runtime-pi` 仅依赖所需核心出口。Pi 依赖只开放给 runtime-pi，数据库依赖只开放给 persistence。其余包保持空 exports。新增契约时同步声明最小允许边。

检查器拒绝未声明依赖、禁止层次依赖、内部子路径、跨包相对路径、动态非字面量导入、CommonJS require、导入别名和 URL、包树符号链接，以及依赖环。静态导入、重导出、动态字面量导入、import type 均通过 TypeScript AST 分析。

包源码目前只支持 TypeScript ESM 的 `.ts`、`.mts`、`.tsx`，均进入严格类型检查；JavaScript、JSDoc 模块引用和 CommonJS 源文件暂不支持，会直接拒绝。相对模块路径按 ESM URL 规则解析后检查，禁止进入未扫描的 `dist`、`node_modules`、`.git`。类型声明的 reference-path 指令按文件相对路径处理；为 null 的 exports 不算公共入口。

exports 仅支持明确子路径映射到普通相对路径/null，或一层 `types`/`import`/`default` 条件映射（必须包含 `import` 或 `default`）。数组、嵌套条件、其他条件（含 `node`、`node-addons`、`module-sync`）和通配符会明确报错，不尝试模拟完整 Node 解析器。路径不支持 URI 编码、query、fragment、反斜线、点目录段、`node_modules` 或 `.git`。需要超出这些约定时先评估成熟工具，不继续扩张自制解析器。

字符串命名的外部模块声明/augmentation 与普通模块导入遵守相同边界，不作为绕过依赖的虚拟模块入口。reference-types 单独对应已声明的自带类型包或 DefinitelyTyped 包，例如 `node` 对应 `@types/node`；实际类型存在性由 TypeScript 验证。

这是协作开发的结构约束，不是未知代码沙箱。任意 JavaScript 能通过反射等手段绕过静态检查；生成扩展的隔离仍需独立实现。当前检查只覆盖 `apps/` 与 `packages/` 的代码，测试可以组合不同层进行验证。

## 连续上下文依赖与数据库测试

- `pg` 8.23.1、`@types/pg` 8.23.1、`node-pg-migrate` 9.0.0
- `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` 均为 1.0.2
- PostgreSQL 18.6，CI 使用官方 `postgres:18.6` 服务

`pnpm test:integration` 要求显式 `MIRA_TEST_DATABASE_URL`；`pnpm check:all` 运行全部检查。连接限制、故障范围和执行记录见 [验收](../acceptance/durable-context.md)。测试 runner 为每次运行创建临时 HOME，子进程继承合成测试环境，不继承模型凭据。无数据库时应运行 `pnpm check` 并明确报告数据库阶段未执行，不能把它称作完整通过。

## Pi 声明文件兼容例外

2026-10-05 用户确认声明检查例外。Pi 1.0.2 发布的 `.d.ts` 中 JSON 导入缺少 NodeNext 所需 import attribute，Google 传递依赖的声明还引用未安装的可选 MCP SDK。未修改上游包，也未添加无用途的 MCP 依赖。

根 `tsconfig.json` 保持 `skipLibCheck: false`，检查核心、持久化、应用占位、工具和相应测试。`tsconfig.pi.json` 仅承接 Pi 运行时及其离线/恢复测试，设置 `skipLibCheck: true`。例外跳过该项目消费的所有声明文件检查，不仅是 Pi 包；若以后添加自己的 `.d.ts`，也会落入这个例外，必须另行评估。两套配置继承相同 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等源代码检查，仍使用上游声明检查 Mira 的实际调用。`pnpm typecheck` 必须同时运行两套配置。
