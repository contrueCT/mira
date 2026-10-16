# @mira/web

React + Vite + 原生 CSS 的本地浏览器界面。只有一个持续 Mira 和单条 Timeline，没有会话列表、New Chat 或账户系统；可选访问密码只保护这一个 Mira 的网页入口。布局参考用户提供的白底、淡紫圆环、灰色 Mira 气泡与蓝色用户气泡。

## 命令

从仓库根运行：

- `pnpm --filter @mira/web build`：构建静态资源到 `apps/web/dist`
- `pnpm --filter @mira/web dev`：启动本地 Vite 开发界面，`/api` 代理到 `http://127.0.0.1:3210`
- `pnpm --filter @mira/web test`：发送信封恢复、历史去重、管理视图解析/分页与存储错误的确定性测试
- `pnpm check`：仓库聚合检查；浏览器交互另行验证

正式本地入口由 `apps/server` 的 Web 命令提供，静态界面与 API 同源。Vite preview 只用于查看构建产物，不提供持久服务。

## 行为与边界

- 页面刷新重新读取服务端历史。浏览器按 ID 合并最新页，按时间瞬间与细分精度排序；手动读取旧页保留可见消息位置；接近底部时才跟随新消息。断线后的不连续窗口显式提示补齐，长游标使用只读 POST 查询，不因隐藏记录空页重置翻页进度
- 页面可见时轮询，工作中约 1.2 秒、空闲约 5 秒；发送回执或手动刷新已确认 working 时，将仍待执行的空闲轮询提前到现有工作周期，已有更早轮询不延后。隐藏/卸载清除计时，迟到完成不重新挂起；不展示未持久化 token streaming
- 每条提交先把完整 `{id,text,occurredAt,attachmentIds?}` 信封写入此标签页的 sessionStorage，再 POST；回执仅表示接收，不表示模型完成
- 中断或不明响应不会自动重发。刷新后保留原始 ID、文本、时间和有序附件 ID；用户明确点击“核对并重试”才读历史并使用相同信封重试；确认用户消息的 `externalEventId` 与原始提交 ID 相同后清除暂存（Timeline 的全局 History UUID 是独立展示身份）
- 发送进行中禁用重复点击和 Enter；回执后可以继续发送待处理消息；中文输入法组合时 Enter 不发送
- Timeline 仅渲染对话文本、消息附件和必要通知，不显示子任务卡片或新增入口（ADR 0031）。子任务的真实活动、显式公开进度和有界结果仅通过既有设置→运行记录查看；不展示主工具活动、原始参数、system prompt 或 thinking。`GET/POST /api/timeline` 仅返回 `items` 与 `nextCursor`，不投影 spawn/followup 的 child/run 引用或空消息；内部执行和持久工具记录不变。文本使用 React 安全渲染与 `white-space: pre-wrap`
- 所有 API 请求包含 `X-Mira-Client: web`；不把 token 或密钥写入 HTML、URL、日志或浏览器存储
- 主聊天布局和唯一设置按钮保持不变。设置使用 `#settings` 与原生 dialog，内部五个标签为模型、Memory、扩展、运行记录与访问；支持关闭、Escape、浏览器前进/返回、标签键盘操作和焦点恢复。标签切换保留草稿，关闭清除未保存配置/密钥；已经发出的记忆请求继续由同一主循环处理
- 模型设置和发现请求在关闭后取消，离开模型标签也会取消尚未完成的发现；迟到响应不会覆盖新编辑。模型保存有 revision 冲突提示，不静默覆盖
- 内置目录与自定义连接分开；自定义发现只提供候选 ID/名称，限额和能力须明确填写。界面直接接受密码式 API Key 输入，由本地后端保存；读取只返回已保存状态。留空保留、输入替换、显式清除后保存移除；目标改变不复用旧 Key
- 既有自定义连接与非当前模型会保留；未完成连接可单独取消，既有连接与密钥编辑可单独还原，保存前验证非当前编辑；不提供数据删除、历史重置或无后端功能的语音按钮

## 验证重点

除构建与类型检查外，浏览器验收覆盖桌面/窄屏、空态/加载/错误、重复发送、响应丢失与刷新恢复、显式同 ID 重试、历史分页滚动、设置取消/前进/返回/迟到发现、revision 冲突、内置选择与手动自定义模型。所有模拟模型与 API fixture 验证不能作为真实模型联通证明。

## 管理视图

- Memory 摘要直接渲染当前 `MEMORY.md`，采用不解析 HTML/链接的安全块级文本子集，支持标题、段落、列表和代码文本；无文件浏览器、编辑器、第二份 Memory 或额外模型摘要。刷新只读取磁盘，不刷新运行时冻结的 Memory
- “修改记忆”生成明确的普通自然语言请求，复用 `/api/messages`、原始 ID/正文/时间与既有 sessionStorage 待确认信封。只额外保存最后请求的 ID/时间用于关联，保留不明提交并且不自动重发。结果从 `/api/messages/:id/status` 精确关联事件与 Wake；接收、完成、回复、Memory checkpoint 是不同事实，同一 Wake 可能合并多个请求。未变更、无回复、未记录与需要澄清均不伪称修改成功
- 扩展页面展示实际状态、已注册 Tools/ContextProviders、生成版本和脱敏错误。启停、重载、完整 JSON 配置值替换及已有 staged 更新/显式回滚由宿主执行，写请求携带当前 revision。配置只接收用户明确输入，不读取、回填或存入浏览器持久存储；不明结果暂停新操作，必须重新读取核对，不自动重试
- 运行列表/详情是既有 Wake/History 的只读白名单投影，展示触发来源、模型/工具/压缩与 Memory 已记录事实。详情展示真实触发请求总数与已载入数，触发成员和执行记录使用独立游标与分页按钮；切换标签/运行后迟到的成员分页不能覆盖新视图。执行记录按服务端记录顺序合并，最新结果可更新旧 unknown，分页保留断层游标；不展示 thinking、system、原始工具参数或结果。当前没有持久化的压缩失败记录会明确说明，不能推断从未发生错误
- 管理页面仅在相应标签与页面可见时轮询；读取取消与请求 ID 核对阻止迟到数据覆盖其他请求/运行。主 Timeline 不增加工具展示字段或管理状态

## 消息附件

- 输入区左侧 + 支持选择多个文件，也接受输入区的拖放/粘贴；多行或附件内容时 + 位于左下角。每条最多 10 个附件、总计 100 MiB；单文件 50 MiB、图片 10 MiB，后端按内容识别 MIME。上传期间可移除取消，失败可明确重试；所有附件上传完成后支持附件单独发送
- 文件字节只留在临时内存和后端私有附件目录，不进入浏览器持久存储。未提交的附件草稿刷新后不会保留；提交前先保存完整信封，有序附件 ID 随原始消息精确恢复/重试
- 双向图片使用紧凑两列圆角缩略图，奇数末张居左；图片和视频可打开原生预览 dialog，支持关闭、Escape、返回/前进和焦点恢复。视频通过有界 Blob 播放，不支持的编码提供下载兜底
- 上传和读取均使用同源、带 `X-Mira-Client: web` 的 fetch。图片/视频元素只接收有界下载后的 Blob URL，不直接请求受保护 API；关闭预览或卸载时取消读取并释放对象 URL
- 仅 PNG/JPEG/GIF/WebP 和允许的视频 MIME 可嵌入。PDF、Word、SVG、HTML 及其他文件仅下载/引用，不自动解析或嵌入；下载使用惰性附件内容，不把文件路径或 HTML 当 UI 执行

设置→运行记录中的子任务详情按 child/run 独立每 2 秒刷新，隐藏页面和屏幕外卡片暂停；终态卡片降为每 5 秒检查，以识别同一 child 的后续任务。详情保留明确来源、开始/结束时间、未知结果与截断提示。取消/追加任务仍通过向 Mira 发送普通消息完成，不新增控制面板。

默认推理强度位于既有模型标签，默认中档；只显示当前模型支持档位，非推理模型显示关闭。切换模型保留原偏好并显示适配结果；关闭/取消清除未保存编辑，冲突需重新读取；主 Mira 或子任务（含取消/清理）未结束时保存返回忙碌并保留草稿供稍后重试。主 Mira、子任务和 Memory 整理同用默认档，压缩摘要独立最低支持档；真实 token 预算受总输出 cap 限制，界面不承诺固定思考量或费用。

请求级瞬时错误重试在现有 working indicator 显示最近一次 status 观察到的等待/正在重试及实际尝试次数，刷新后重新读取。轮询是尽力观察，不保证每个短暂重试阶段都在页面闪现；不保留已错过的重试提示。成功、失败、取消或服务停止会清除提示；不新增 Timeline 条目、工具活动、按钮或原始 provider 诊断面板。见 ADR 0029。

## 可选网页访问密码

- 默认关闭；页面先读取 `/api/auth/status`，状态确认前不挂载聊天、设置或附件，也不发起其读取请求。状态读取失败保持独立错误/重试页；启用后未登录只显示密码入口，没有账户或远程服务选择器
- 既有设置→访问支持开启、修改密码、关闭及退出当前浏览器。开启须设置新密码，修改和关闭须验证当前密码；新密码为 12–256 个 Unicode 码点、UTF-8 不超过 1024 字节且非全空白。读取只返回 enabled/revision，不回填密码
- 草稿切换标签仍保留，关闭、取消、Escape 或返回会卸载并清除密码输入；提交后立即清空输入，重复提交受控。版本冲突和不明保存结果要求重新读取核对，不自动重发
- 登录只使用同源 HttpOnly Cookie；前端不保存密码或会话凭据到浏览器存储、URL、日志或聊天。有效期 12 小时，服务重启后重新登录；更改密码撤销其他浏览器的登录并为当前浏览器换发登录 Cookie。已提交的认证写请求在关闭窗口后仍完成状态核对，关闭不能撤回服务端密码更改
- 任意普通 API 或附件 fetch 收到 401 时，在解析响应前撤下整个私有界面；请求、附件 Blob URL 和未保存字段随组件卸载清理。旧登录发出的迟到 401 不会覆盖后来的登录状态；若轮换密码时并发旧请求先收到 401，私有界面仍立即撤下，并等待当前认证写操作独立完成，新登录/退出操作会使旧结果失效。已有待确认消息信封保持原来的 sessionStorage 恢复语义，重新登录前不读取或展示，不会自动重发
- 页面明确说明关闭时任何能连接服务的人均可访问；访问密码不会加密 HTTP 上的密码或内容，跨网络使用前应配置 HTTPS
- 确定性验证覆盖状态/设置 DTO、密码边界、所有 API 与附件 401、非 JSON 401、迟到旧响应及凭据不落存储。实际浏览器还应覆盖首次加载失败重试、错误密码/限速、启停/修改、退出、关闭/返回、重复点击、冲突/不明结果、会话失效和窄屏。

Extension cards render declarative connection fields/actions/status within the existing
settings dialog. The host supplies the visible action list; actions with no group or
`primary` remain visible, while `secondary` actions and the existing editor entry
share a default-collapsed “更多操作” section. Collapsing it does not hide the open
editor or its cancellation button. Pending-action cancellation also remains visible.
Secret drafts remain transient, blank preserves the saved value, and
clear is explicit. Cancel/close clears drafts. Pending actions survive closing the
window and can be cancelled after reopening. Unknown writes require rereading before
another attempt. HTTPS authorization QR codes use pinned `qrcode-generator` locally;
no external QR service receives the link.


### 消息分组与回复

相邻同角色、同来源消息紧凑排列；首条、间隔严格超过五分钟或本地日期变化时居中显示日期和时间。时间与扩展来源在气泡外侧随悬停或键盘焦点显示。Mira 消息有可聚焦的回复按钮，触屏始终可见；正文上方显示带弯箭头的单行引用，不增加反应、已读状态或常驻工具栏。

选择回复会在输入框上方显示可取消预览；发送仅提交 `replyToMessageId`，由服务端验证目标并生成快照。附件和回复 ID 与原始幂等信封一起保留到确认，刷新不会自动重发。点击引用可跳至原消息；未加载时按现有历史分页最多读 8 页、等待 15 秒，可随时取消。找不到时保留引用内容并提示继续手动读取历史。

浏览器合成测试位于 `tests/e2e/web.spec.ts`，覆盖悬停/焦点、触屏、取消、提交、刷新重试和有界引用查找；这些 fixture 不代表真实数据库链路通过。
