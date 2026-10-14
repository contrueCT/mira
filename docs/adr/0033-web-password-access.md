# ADR 0033：可选网页访问密码

状态：用户授权实现，草稿 PR 验证中；不包含正式部署、开放端口或设置实际密码。

## 范围

继续使用原有同源网页，保留一个持续 Mira。在既有设置中增加「访问」页和打开网页时的密码输入。不增加远程连接选择器、实例管理、client 壳、token 输入界面、OAuth 或多用户系统。访问 session 只是浏览器凭据，不是 Mira 的认知会话。

参考用户 nine1bot 的简洁模式，参考版本 `4d918fd1e555c5505705014f726b0b02d1167428` 的 `packages/nine1bot/src/access-auth/service.ts` / `credential-store.ts`：密码 hash、HttpOnly/SameSite cookie、有限登录有效期与错误限速。只借鉴行为，不引入其 Bun、Basic、扩展 bearer 或迁移系统。

## 密码与登录

- 默认关闭，保留当前无密码体验。设置内第一次启用需输入两次 12–256 字符的新密码，后端同时限制 UTF-8 字节数。
- Node 内置异步 scrypt（N=32768/r=8/p=1，64 字节，随机 32 字节 salt）只保存 hash，不保存/回填密码。`${MIRA_HOME}/web-access.json` 为 0600，home 必须为源码外 0700 私有目录。配置错误启动失败，不降级为关闭鉴权。
- 浏览器只使用随机 cookie；服务端只在内存保存 cookie 的 SHA-256 与到期时间，最多 256 个。12 小时绝对有效期，服务重启失效，没有长期记住我开关。Cookie 为 HttpOnly、SameSite=Strict、Path=/；明确 HTTPS public origin 才加 Secure，不猜测转发头。
- 修改密码或关闭保护需要已登录 session、当前密码和设置 revision。变更原子写入后撤销全部旧 session，当前浏览器获得新 session（关闭时清 cookie）。其他已接收的在途业务请求不会被追溯撤销。
- 当前进程拥有配置文件，手工改文件须停服后操作再重启；不提供在线重置/找回平台。同 OS 账户和模型普通 shell 仍有其既有文件权限，这不是 OS 沙箱。
- 登录与当前密码校验共用错误/尝试限制：每来源地址每分钟最多 5 次，全局最多 30 次，同时最多 2 次 hash 校验；成功也计入这一分钟预算。代理不信任 X-Forwarded-For，故代理后客户端共享来源预算。限速 429 携带 Retry-After=60；无需 IP 持久日志。

## HTTP 边界

- 只有静态应用资源、`GET /api/auth/status` 和 `POST /api/auth/login` 不要求已有登录。所有私有 Web API、管理投影、上传与附件字节统一鉴权，不能靠遮挡界面保护数据。API 401 让前端卸载私有界面并重新登录；密码不进入 localStorage、URL、历史或日志。
- Host 只允许明确的回环 authority 和可选 public origin authority。写请求须精确 Origin、X-Mira-Client 与对应 Content-Type；继续拒绝 cross-site Fetch Metadata、编码路径别名。没有通配 CORS、任意 Host 或自动相信代理。
- External SDK 保留独立凭据和用途。即使 Web 监听所有接口，其 `/api/external/*` 仍只接受实际回环来源地址以及回环 Host，不使用浏览器 cookie替代。
- 密码关闭确实允许直接访问，启动非回环监听时显著提示任何可达访问者都能读写 Mira；不发明无法关闭的限制。

## 启动

默认继续 `127.0.0.1:3210`。示例局域网配置：

```sh
MIRA_HOST=0.0.0.0 MIRA_PUBLIC_ORIGIN=http://192.168.1.20:3210 MIRA_DATABASE_URL=postgres://...@127.0.0.1/mira pnpm start
```

把示例 IP 替换成服务器实际 LAN 地址；0.0.0.0 是监听地址，不能在客户端拿它当服务器地址。非回环绑定未提供 public origin 时启动直接说明所需配置，不启动一个所有远程访问都 403 的实例。public origin 不接受路径、查询、凭据或通配监听地址。

HTTP 不加密密码、cookie 或聊天，仅用于可信 LAN。公网必须由用户另行配置 HTTPS 反向代理，设置 `MIRA_PUBLIC_ORIGIN=https://mira.example.com` 并保持上游 Host。Mira 不自动配置 TLS、防火墙、DNS、隧道或部署；代理方案需要限制上游可达范围。配置 HTTPS origin 不会让 Mira 的 HTTP listener 自动变成 HTTPS。

## 验证

`tests/unit/web-auth.test.mts` 覆盖默认关闭、hash/文件权限、私有 API/附件拒绝、密码错误/限速、logout、重启、revision、改密/关闭、精确远端 Host/Origin、Secure cookie 和损坏配置。

`pnpm test:auth:e2e` 是真实浏览器→HTTP→生产服务→独立 PostgreSQL/附件存储链路（只使用合成模型），通过显式非回环 hostname 验证远端 Origin。包括启用、错误密码、私有 API/附件 401、登录、改密、退出、重启、关闭及桌面/窄屏截图。CI 执行，不以 Fastify inject 或 UI fixture 替代真实链路。具体结果见 PR 与验收记录。
