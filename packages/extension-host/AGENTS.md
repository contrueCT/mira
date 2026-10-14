# Extension Host

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 为手工与生成本地扩展宿主，使用官方 Cordis RC / Loader / HMR / Timer。
- 本目录负责Cordis 的注册、依赖、生命周期和清理。

## 本地约束与跨包陷阱

- Cordis 不是安全沙箱；按 ADR 0005，已授权生成代码直接使用宿主 OS 身份测试/import/apply
- 验证卸载、重载失败、旧 timer/listener/socket 清理和注册撤销
- 扩展只使用 SDK 公共契约，不直接接触数据库或核心内部
- `artifacts.ts` 的 stage 只复制/哈希，不 import；测试/激活版本必须真实绑定完整快照与本地依赖
- 每次生成版本激活使用私有新路径，保护实际在途调用并等待 cleanup；保留 release，不宣称回退外部效果
- requestChange 统一 await 保存/清理/应用，返回最终 receipt + runtime；无 accepted 队列，管理工具不持有扩展执行租约，旧 activation 的未执行调用返回已知 stale 结果
- prepareCapabilities 同份捕获工具/ContextProvider，实际采样才取得租约；旧代未开始项返回 stale，失败不复用旧数据；限额与取消见 ADR 0019
- configuration、artifact、PG 与 runtime 非原子；receipt 必须分别报告未保存/已保存/实际失败

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。离线验证见 `tests/unit/extension-host.test.mts` 和 `tests/unit/official-hmr.test.mts`；实际 HMR 子进程使用 `--expose-internals`，不调用真实模型。

- 持久调度owner绑定配置ID和安装身份：generated首revision、manual持久installationId。disable/remove暂停保留pending，重装不可继承；显式生命周期与投递扫描串行，见ADR 0022。
