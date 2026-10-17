# 基础工具链

状态：用户已确认工具链方向，以下是可重复的具体版本。build 构建开发检查工具和 Vite Web 应用；服务端仍用 Node 24 的 TypeScript 类型擦除执行。

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
pnpm install --frozen-lockfile --ignore-scripts
pnpm terminal:prepare
pnpm check
```

`pnpm check` 顺序执行：

1. `pnpm typecheck`：核心、Pi、Cordis、Web 和 E2E TypeScript 源文件的严格检查
2. `pnpm boundaries`：包目录、manifest、exports、依赖图、实际模块导入
3. `pnpm test`：Node 内置测试框架中的基础验证、违规反例和离线运行时测试
4. `pnpm build`：将检查工具编译到 `dist/`，并构建 `apps/web/dist/`

CI 固定第三方 Action 的完整 commit SHA，只有只读仓库权限，不保存 checkout 凭据，不提供真实模型/生产数据库/部署凭据。CI 的 PostgreSQL 18.6 服务仅使用固定合成测试凭据。安装脚本默认不获允许。pnpm 11 的 `engineStrict`、`saveExact` 放在 workspace YAML；测试实际查询配置并验证不支持的 Node 版本会拒绝安装，不依赖已不生效的 `.npmrc` 配置。

## 包依赖策略

`context` 导出 JSON envelope 与快照，`cognition` 导出最小 Runtime 契约，`life` 导出持久化契约与串行 WakeLoop。`persistence` 与 `runtime-pi` 依赖所需核心出口；`workspace` 仅公开普通溢出文本写入，`server` 公开假 provider 组装、Pi 目录、显式自定义发现与 model/streamFn transport，见 [模型说明](models.md)。Pi 依赖只开放给 runtime-pi 和 server 组装，数据库驱动只开放给 persistence；其余占位包保持空 exports。新增契约同步声明最小允许边。

检查器拒绝未声明依赖、禁止层次依赖、内部子路径、跨包相对路径、动态非字面量导入、CommonJS require、导入别名和 URL、包树符号链接，以及依赖环。静态导入、重导出、动态字面量导入、import type 均通过 TypeScript AST 分析。

包源码目前只支持 TypeScript ESM 的 `.ts`、`.mts`、`.tsx`，均进入严格类型检查；JavaScript、JSDoc 模块引用和 CommonJS 源文件暂不支持，会直接拒绝。相对模块路径按 ESM URL 规则解析后检查，禁止进入未扫描的 `dist`、`node_modules`、`.git`。类型声明的 reference-path 指令按文件相对路径处理；为 null 的 exports 不算公共入口。

exports 仅支持明确子路径映射到普通相对路径/null，或一层 `types`/`import`/`default` 条件映射（必须包含 `import` 或 `default`）。数组、嵌套条件、其他条件（含 `node`、`node-addons`、`module-sync`）和通配符会明确报错，不尝试模拟完整 Node 解析器。路径不支持 URI 编码、query、fragment、反斜线、点目录段、`node_modules` 或 `.git`。需要超出这些约定时先评估成熟工具，不继续扩张自制解析器。

字符串命名的外部模块声明/augmentation 与普通模块导入遵守相同边界，不作为绕过依赖的虚拟模块入口。reference-types 单独对应已声明的自带类型包或 DefinitelyTyped 包，例如 `node` 对应 `@types/node`；实际类型存在性由 TypeScript 验证。

这是协作开发的结构约束，不是未知代码沙箱。任意 JavaScript 能通过反射等手段绕过静态检查；生成扩展按 ADR 0005 在宿主身份执行，不要求产品隔离；静态检查并非安全证明。当前检查只覆盖 `apps/` 与 `packages/` 的代码，测试可以组合不同层进行验证。

## 连续上下文依赖与数据库测试

- `pg` 8.23.1、`@types/pg` 8.23.1、`node-pg-migrate` 9.0.0
- `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` 均为 1.0.2
- PostgreSQL 18.6，CI 使用官方 `postgres:18.6` 服务

`pnpm test:integration` 要求显式 `MIRA_TEST_DATABASE_URL`；`pnpm check:all` 运行全部检查。连接限制、故障范围和执行记录见 [验收](../acceptance/durable-context.md)。测试 runner 为每次运行创建临时 HOME，子进程继承合成测试环境，不继承模型凭据。无数据库时应运行 `pnpm check` 并明确报告数据库阶段未执行，不能把它称作完整通过。

macOS 的 `/tmp` 是 `/private/tmp` 的符号链接。测试夹具对自己刚创建的临时根使用 `realpath(await mkdtemp(...))`，再构造附件、Memory 与 Wake spool 路径；保留产品对符号链接、所有权和权限的拒绝断言。全量本地验收可显式设置 `TMPDIR=/private/tmp`，避免默认长临时路径或多层隔离目录超过 Unix socket 路径长度，也避免合成生命周期测试被无关路径长度推入上下文预算门禁。此设置不放宽浏览器 sandbox、socket 必须可用或真实 PostgreSQL 的要求。

受管浏览器键盘门禁使用 Playwright `ControlOrMeta`，分别发送 macOS Command 或 Linux Control；后续提交值仍须精确相等，不能以事件已发送代替远端选择与编辑真正生效。真实 PG 门禁应串行运行：唯一 schema 隔离数据，但各 schema 的 owner sequence 可能分配相同数据库级 advisory key，并发独立套件会互相拒绝 writer。

## Pi 声明文件兼容例外

2026-10-05 用户确认声明检查例外。Pi 1.0.2 发布的 `.d.ts` 中 JSON 导入缺少 NodeNext 所需 import attribute，Google 传递依赖的声明还引用未安装的可选 MCP SDK。未修改上游包，也未添加无用途的 MCP 依赖。

根 `tsconfig.json` 保持 `skipLibCheck: false`，检查核心、持久化、workspace、非 Pi 应用、工具和相应测试。`tsconfig.pi.json` 承接 Pi 运行时、server provider 组装及消费 Pi 的离线/恢复测试，设置 `skipLibCheck: true`。例外跳过该项目消费的所有声明文件检查，不仅是 Pi 包；若以后添加自己的 `.d.ts`，也会落入这个例外，必须另行评估。两套配置继承相同 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等源代码检查，仍使用上游声明检查 Mira 的实际调用。本阶段新增下述 Cordis 项目；`pnpm typecheck` 必须运行全部三套配置。

CI 和本地安装显式使用 `--ignore-scripts`。pnpm 11 对未批准的传递依赖构建会返回 `ERR_PNPM_IGNORED_BUILDS`；本批不需要 Google SDK、esbuild、protobufjs 的安装脚本，因此继续禁用脚本，不执行 `approve-builds` 或扩大构建权限。


## Cordis consumer declaration resolution

See ADR 0004. Official Cordis RC declaration exports omit ESM file extensions.
`tsconfig.extensions.json` uses strict ESNext/Bundler resolution with library checks;
`tsconfig.pi.json` uses the same resolution for Pi/server consumers and retains
the previously approved skipLibCheck exception for all declarations consumed by that project. Root/core/SDK retain
NodeNext. No bundler is installed: Node 24 executes explicit .ts ESM and actual HMR
children use `--expose-internals`. All three projects run under `pnpm typecheck`.

## 本地 Web 工具链

React/ReactDOM/对应类型 19.3.0、Vite 8.3.3、Fastify 5.12.5、@fastify/static 10.1.5、Playwright 1.63.0，见 ADR 0009。Web 配置 `tsconfig.web.json` 保持 strict 和声明检查，E2E 消费 Pi 后端沿用 `tsconfig.pi.json` 的既有声明例外。`pnpm test` 同时运行前端状态测试，CI 单独安装官方 Chromium 并执行 `pnpm test:e2e`，产物均为合成测试截图。依赖安装脚本仍禁用。

## Managed terminal native setup

After the script-disabled install, run `pnpm terminal:prepare` for terminal PTYs.
The explicit helper only prepares Microsoft `node-pty` 1.1.0 (MIT), pinned in the
server manifest/lockfile. Linux builds its native addon with pinned development
`node-gyp` 11.4.2, Python 3, make and a C++ compiler; Node headers are downloaded
by node-gyp into `node_modules/.cache/node-gyp`. Mac uses the upstream bundled
arm64/x64 addon and sets its packaged spawn-helper executable bit (upstream #919).
No dependency lifecycle scripts are enabled and no toolchain is installed by Mira.
An unavailable native module produces an explicit PTY setup error; ordinary pipe
execution and the existing synchronous Pi bash tool do not require a native addon.
CI executes actual pipe/PTY/lifecycle tests on Linux and macOS. Windows is outside
this first terminal implementation.

`pnpm test:replies:e2e` 为双向指定消息回复的独立真实浏览器链路门禁；需先构建页面、安装 Chromium 并配置隔离的 `MIRA_TEST_DATABASE_URL`。它使用生产 HTTP/service/runtime 与真实 PostgreSQL，只有模型返回为合成，不代表真实模型回复选择质量。CI 保留原有门禁并执行此命令。
