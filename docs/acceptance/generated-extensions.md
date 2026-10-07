# §96 生成扩展生命周期验收

范围按 [ADR 0005](../adr/0005-generated-extension-lifecycle.md)。这是普通文件生成扩展的生命周期能力与确定性集成验收，不是“真实模型已能自主发现需求、写出正确代码”的质量报告。没有 HTTP/UI、真实账户/模型调用、市场、自动依赖安装、合并或部署。

## 可复现工作流

1. `node scripts/create-extension-workspace.mts /absolute/coding/extension`，使用已安装的本地私有 SDK/TypeScript/Node types，不联网安装或运行安装脚本
2. 普通 Pi read/write/edit/bash 查阅 SDK、编辑 `src/index.ts` / 其他文件
3. native `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 和 `node --test tests/*.test.mts`
4. `node scripts/extension-artifact.mts stage /absolute/data/artifacts /absolute/coding/extension src/index.ts`，或 `extension_stage`
5. 对返回的 digest 用 CLI test 运行显式 typecheck/test 命令。测试在该完整版本副本执行，receipt 绑定其内容；源工作区改动不改变已 staged release
6. 普通 JSON 设置 `artifactsDirectory`。`extension_manage` install 新 ID/digest/config；下一请求 inspect 确认 disabled；activate 后下一自然请求看到新 schema/dispatcher 并调用
7. update 选新 digest；rollback 选 inspection 的历史 revision ID；disable 保留 desired；remove 撤销配置/注册但保留源文件和 releases

直接在源码工作区跑 test 的终端结果仍有意义，但不是受保存的 digest 绑定 receipt。不会把一次旧测试自动套给改过的版本。若没有受绑定测试，receipt 如实报告 not-run，而不是强制风险门禁。

## 自动断言覆盖

- `extension-template.test.mts`：真正外部目录、测试专用 Node 网络 API 禁用探针（非 OS 沙箱）、实际 Pi 文件/Shell 工具、严格 NodeNext、私有 SDK bare import、本地声明依赖闭包、3 个真实 Node 示例测试、实际类型错误失败、拒绝覆盖；删除源工作区后完整 staged 副本仍能 typecheck/test
- `extension-artifacts.test.mts`：stage 无 import/脚本；文件权限、入口、普通文件及依赖字节改变 digest；循环/逃出链接拒绝；重叠根、别名、hoisted 依赖及跨根相对路径；不完整依赖/包作用域明确拒绝；fresh ESM/嵌套 CJS；测试/激活前后改动拒绝继承测试成功；启动/信号失败；CLI smoke
- `generated-extensions.test.mts`：disabled install 无 import；activate/update/rollback 真实不同代码、配置、模块状态、schema 与 activation；重启 disabled；source/release 保留；import/apply/文件保存冲突分别真实报告；在途工具 lease、服务消费者清理顺序、依赖等待/恢复
- `generated-runtime.test.mts`：确定性模型同一 Wake 中的 stage/install/activate、后续新工具调用、update/rollback schema 与 dispatcher 同代，技术校验/持久 intent、声明和结果延续
- `generated-extensions.test.mts`（recovery）：真实 PostgreSQL 的已应用管理调用结果丢失/未知恢复、desired code/config/disabled 重启；不盲重放未知操作
- 既有 296 个基础/离线/PG 测试继续保留；计数以最终命令和 exact-head CI 为准

## 执行记录

本地使用 Node 24.19.0 / pnpm 11.28.4 / TypeScript 6.0.3。`pnpm check` 包含全部三种类型项目、边界检查、基础/离线测试与工具构建。独立审查和最终测试结果在 PR 中按确切提交记录。

真实 PostgreSQL 在既有 GitHub Actions `postgres:18.6` 合成服务通过 `pnpm check:all` 验证。本地 socket 被拒绝，未改用 TCP 或其他方式绕过；本地不执行数据库阶段。CI 未完成前不称完整验收通过。

## 已知边界

测试、import、execute 运行在宿主 OS 身份；没有产品执行隔离、资源或凭据 sandbox。开发验证只运行已知合成代码，未用真实凭据/模型。内容标识覆盖私有快照，不证明任意外部绝对/dynamic import、网络或 OS 资源。普通文件可被同账号改动，不是敌对代码安全边界。

配置保存、文件发布、runtime、PG、外部副作用非原子。新 desired 保存后 apply 失败或进程崩溃仍在重启加载该版本。rollback 是明确另一次 fresh activation，不能撤销外部效果，不保证原子恢复。测试后文件变化会被核对，但不证明安全或检测所有 mutate-and-restore 竞态。

版本和 activation 目录默认保留，不提供不可逆删除或自动 GC。Memory 没有新增通知、Wake、重注入或额外版本服务。手工 HMR 的嵌套 CJS 局限仍按 ADR 0004，不冒称由生成版本复制机制修复官方 watcher。
