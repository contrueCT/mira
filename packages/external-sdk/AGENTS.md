# External SDK

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/protocol.ts` 定义外部 Event/Wake 输入与持久回执，严格验证并返回独立 JSON 快照。`src/client.ts` 提供 emitEvent/requestWake/sendNotification，逐次加载显式凭据、只接本机、无自动重试；通知仅为持久 Timeline notice，不 Wake。
- 本目录负责外部程序事件与 Wake API。

## 本地约束与跨包陷阱

- 保持平台独立，不导入核心内部实现或 Node 平台模块
- 事件与 Wake 是两个独立操作，不默认每个事件调用模型；沿用内部 Extension SDK 的完整原子 Event/Wake 信封，同 ID 不允许先 emit 再追加 Wake
- 认证范围、去重、输入验证与结果不明必须在协议中明确
- 外部程序不能直接写 Working Context、工具执行记录或历史数据库

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。客户端/HTTP/私有配置单元测试见 `tests/unit/external-client.test.mts`、`external-http.test.mts`、`external-access.test.mts`；协议及 ingress 单元测试为 `tests/unit/external-protocol.test.mts`、`tests/unit/external-ingress.test.mts`；PostgreSQL 并发与恢复为 `tests/recovery/external-ingress.test.mts`，由 `pnpm test:integration` 执行。

## 接入与身份

本地 CLI 通过普通 Shell 管理全局开关与私有程序凭据；默认关闭，正常输出无 token。认证绑定来源，不是动作审批。凭据 loader 每次调用更新；轮换保留 source ID/去重空间，撤销不撤回已落库的工作。当前私有源码包未发布 npm；独立 Node 24 程序的源码导入及示例见 README。
