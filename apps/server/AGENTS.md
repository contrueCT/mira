# Server 组装入口

共享规则见 [根 AGENTS.md](../../AGENTS.md)。本文路径相对于本目录；子目录规则只能补充，不取消根规则。

## 入口与状态

- `README.md` 描述职责；`package.json` 是包名和公开 exports 的事实来源
- `src/index.ts` 组装假 provider、持久化、WakeLoop 和普通文件读取；`pnpm demo --help` 为 CLI 入口。尚无 HTTP 服务。
- 本目录负责API、认证、启动和依赖组装；服务框架尚未选定。

## 本地约束与跨包陷阱

- 在这里连接核心契约与具体适配器；不要让 life/context 反向导入 server
- API 必须区分 emit event 与 request wake，并在边界验证不可信输入
- 启动恢复、停机和错误处理不能生成第二个活跃认知写者

## 验证

从仓库根运行 `pnpm check`。依赖或 exports 改动必须同时检查 `scripts/boundaries.json`，并添加允许/拒绝反例。`pnpm demo --help` 离线验证入口；数据库演示由恢复集成测试覆盖。此 Pi 消费项目进入 tsconfig.pi.json，Mira 源码仍严格检查。
