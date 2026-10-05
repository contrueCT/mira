# Extension Host

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 为手工配置可信本地扩展宿主，使用官方 Cordis RC / Loader / HMR / Timer。
- 本目录负责Cordis 的注册、依赖、生命周期和清理。

## 本地约束与跨包陷阱

- Cordis 不是安全沙箱，不在宿主直接加载未知生成代码
- 验证卸载、重载失败、旧 timer/listener/socket 清理和注册撤销
- 扩展只使用 SDK 公共契约，不直接接触数据库或核心内部
- 隔离方案确认并验证前不开放自生成扩展激活

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。离线验证见 `tests/unit/extension-host.test.mts` 和 `tests/unit/official-hmr.test.mts`；实际 HMR 子进程使用 `--expose-internals`，不调用真实模型。
