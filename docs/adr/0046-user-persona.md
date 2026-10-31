# ADR 0046：用户自定义人设

状态：Accepted，2026-10-30。用户确认设计稿与 D1–D17（D8 改为支持图片上传，D15 增加“傲娇”预设，删除“被认真问是不是人时必须如实回答”的护栏，预设与“怎么称呼你”不出现真实人名）。记忆重置另行实现。

## 决定

- **一份全局人设**，保存在 `MIRA_HOME/persona.json`（缺省 `~/.mira/persona.json`，0600，原子写，`O_NOFOLLOW` 读取并检查所有者与权限）。字段：名字、头像环颜色、头像图片、怎么称呼用户、主要语言、身份与背景、性格与态度、说话方式、边界、最多 3 组示例对话、补充说明。渲染后的 `{{PERSONA}}` 文本不超过 4000 字。保存使用 revision 比较交换（冲突返回 409），每次真实变化生成新版本，保留最近 20 个版本；恢复历史版本会生成新版本，不改写历史。没有人设或草稿等同默认时保存为 `null`。
- **Prompt v0.3**：`prompts/mira-system-v0.3.md` 在 `</identity>` 之后加入固定 `<persona>` 段（宿主写定的说明 + `<persona_profile>{{PERSONA}}</persona_profile>`）。模板仍称 “Mira”，并说明在此人设下 “Mira” 指它自己、对用户使用人设名字。人设可调整 conversation_style 中的语气、长短和幽默，不能改变纯文本格式规则；任务汇报、行动、委派、Memory、授权、History、工具、扩展和动态语境规则完整适用。人设是对它的描述，不是用户请求，不授予任何权限；示例对话只示范语气，不是事实或记忆；较早消息可能来自旧人设。没有人设时 `PERSONA` 为固定的默认句。
- **模板版本化**：v0.2（`5e520269…`）成为历史版本 “pre-persona”，与 pre-delegation、pre-communication 一样可恢复，并在下一次自然请求时升级到 v0.3。占位符白名单按模板版本区分：v0.2 快照恰好 7 个键，v0.3 快照恰好 8 个键（多 `PERSONA`）；键集合与模板不符的快照按无效处理。section key 仍为 `mira.system.v0.2`。
- **Wake 开始时冻结**：server 在每次 `createRuntime`（一次 Wake）读取内存中的已保存人设并传给 runtime；同一 Wake 内的工具循环和实时输入保持同一人设。保存不唤醒 Mira，也不打断正在进行的工作，从下一次 Wake 生效。子任务 worker 不使用 Mira system prompt，因此不继承人设。压缩复用已冻结的 prompt 值。
- **Timeline 通知**：每次真实变化写入一条不唤醒的 `system` 事件 `persona.updated`（事件 ID `["persona-update", revision]`），Timeline 显示为分隔线式通知“人设已更新为「名字」（第 N 版）· 从下一次唤醒开始生效”。内容未变化的保存不产生版本或通知。
- **整理冲突记忆**：设置页“保存后请…整理与新人设冲突的记忆”默认勾选；保存成功且确有变化时，通过既有 Memory 请求信封发送一条普通消息，只要求整理关于它自己的名字、性格和说话方式的记录，不动用户事实。取消勾选则不发送。
- **头像图片**：`POST /api/persona/avatar` 只接受 `application/octet-stream`，按文件签名识别 PNG/JPEG/WebP，最大 2 MiB，以内容 SHA-256 命名保存在 `MIRA_HOME/persona-avatars/`（0700）。`GET /api/persona/avatar/:id` 走与其他 API 相同的鉴权、`X-Mira-Client` 和 nosniff 头，读取时重新校验签名与哈希。浏览器经 `clientFetch` 取 Blob 再生成对象 URL，不把受保护 URL 放进 `<img src>`。头部头像和聊天中每段连续 Mira 回复前显示图片；没有图片时保持原头像环（颜色可选），聊天内不额外显示头像。未被任何版本引用、超过 1 小时的上传文件在之后的保存时清理。
- **界面**：设置中“模型”之后新增“人设”页：生效状态与历史版本、查看注入内容（仅 `<persona_profile>` 内文本）、预设（默认 Mira、技术搭档、温和陪伴、简洁助理、毒舌但靠谱、傲娇、空白；名字均为虚构，“怎么称呼你”留空）、头像上传与颜色、字段计数、示例对话、固定规则说明、整理记忆勾选和总字数。头部名字、输入框占位、空状态、处理中提示和读屏播报使用人设名字。
- **HTTP**：`GET/PUT /api/persona`、`GET /api/persona/presets`、`POST /api/persona/preview`、`GET /api/persona/history`、`POST /api/persona/restore`、头像两条路由；`/api/status` 增加 `identity {name, ring, avatar}`。错误码：无效 400、冲突 409、不存在 404、本地文件不可用 503（不自动重置损坏文件）。

## 不做

不支持多套人设或按会话切换；不让模型自己修改人设；不改写旧消息；人设不改变工具、授权或 Memory 行为；记忆重置不在本 ADR 内（重置时保留人设）。

## 验证

- `tests/unit/system-prompt.test.mts`：v0.3 字节/哈希/占位符、`<persona>` 段是相对 v0.2 的唯一变化、转义、默认人设、按 runtime 冻结、v0.2 历史快照恢复与升级、快照键集合校验。
- `tests/unit/persona.test.mts`：解析与限额、渲染、预设、存储 CAS/历史/恢复/并发、损坏/越权文件失败关闭、头像签名/大小/哈希/清理、HTTP 安全模型与错误码。
- `tests/recovery/persona-service.test.mts`（PostgreSQL）：保存不唤醒、单条通知、Wake 内冻结、下一次 Wake 生效、恢复与重启。
- `apps/web/tests/persona.test.ts`：草稿归一、脏检查、客户端限额、整理请求、头像文件检查、状态身份兜底。
- `pnpm test:persona:e2e`（真实浏览器 + PostgreSQL + 生产 HTTP）：预设、头像上传与显示、保存通知、整理请求、下一次 Wake 的 prompt、桌面与 390px 窄屏截图。
