# ADR 0041：自定义模型发现与推理格式

状态：实现范围，2026-10-15；通过草稿 PR 审查，不代表真实代理联通已验收。

## 问题与边界

自定义模型的 `reasoning: true` 声明模型能力，但不能独立证明代理接受哪个请求参数。标准 Chat Completions 使用 `reasoning_effort`；部分兼容服务采用其他字段。LiteLLM 的 UnsupportedParamsError 也可能来自其模型映射/参数支持表，仅凭该错误不能确定替代字段。不能把不发送推理参数当作保持推理强度的修复，也不能默认开启 drop_params 或在 400 后换格式重试。

Mira 已固定 Pi 1.0.2，其公开 `OpenAICompletionsCompat.thinkingFormat` 支持不同 wire 格式。新增自定义模型可选 `reasoningFormat: "openai" | "openrouter"`，只用于 `openai-completions`。显式格式分别使用 Pi 原生适配发送 `reasoning_effort` 或 `reasoning: { effort }`；两者都是 effort 格式，不把只有开关的 thinking 协议伪装成多档强度。不给用户任意 payload JSON 编辑器，不拷贝 Pi 的协议实现。

- 格式默认“自动（沿用接口适配）”，缺字段继续使用 Pi 原生协议/URL兼容行为。标准 Chat Completions 通常使用 `reasoning_effort`；仅在服务文档明确要求时选择 override，不把 URL 推断当成已验证后端支持。
- 未声明格式的已有配置原样有效，继续沿用 Pi 的协议/URL默认行为，不偷偷丢失已设置 effort。设置面板直接显示自动选项，可编辑选择；不能声称自动识别了未知代理。
- 内置目录、Responses 和 Anthropic 原生适配及强度语义保持不变。非 Chat Completions 配置声明该格式会在网络请求前被拒绝。
- 格式随模型元数据通过既有私有文件、revision CAS、公开无密钥投影持久化；取消/关闭不保存。更改连接地址时保留所有模型及打开草稿的显式格式；切换到非 Chat Completions 协议时清除不适用的格式。无额外确认或迁移状态。
- 只做请求前确定性映射，不根据错误自动改变格式，不修改代理或用户账户，不调用真实付费模型。

用户实际路由适用哪个字段仍需要该服务的文档或成功请求证据；新增 OpenRouter 兼容选项不是对未知 LiteLLM 路由的修复声明。

## 发现与编辑

继续由服务器使用已配置/草稿凭据请求同源目录，保留原有鉴权、重定向禁止、15秒/2MB/页数上限及错误脱敏。目录返回的明确限额、text/image输入、reasoning布尔能力经白名单校验后用于草稿，具体字段见 [模型说明](../development/models.md)。不依据模型名、owned_by 或公共内置目录推测代理能力；不自动导入推理请求格式或价格。

发现下拉框是可重复使用的选择动作；选择条目即填入已知字段，已有同ID profile优先保留原值。未知 token 限额仍留空并明确要求按服务文档填写，不能伪造精确容量。新草稿默认以文本模式配置，未声明推理能力可后续编辑。目录为空、未支持发现或请求失败均保留手动输入。没有新增主界面入口。

## 验证

- `tests/unit/custom-model-setup.test.mts`：真实回环 HTTP 目录、私有文件保存/重读、真实 Pi runtime payload；合成端点拒绝旧 effort 字段而不触发重试，显式选择另一兼容格式后保留 high；验证密钥不回填、不进入错误、旧配置不静默关闭推理、非法跨协议格式拒绝。
- 既有 reasoning-settings 三种协议序列化/恢复测试保持；新增多档格式 wire 检查与发现字段校验。
- `tests/unit/web-http.test.mts` 验证实际 HTTP 响应保留元数据白名单且丢弃原始字段/凭据。`tests/e2e/management-real.spec.ts` 覆盖真实浏览器→HTTP发现→选择保存→服务重启→PostgreSQL/runtime→合成模型 HTTP 的完整路径。
- 浏览器 fixture 覆盖直接选模型、缺失限额、保留旧模型、格式选择与保存重开、空/错误手动兜底、窄屏/桌面截图；它不等同真实供应商验收。

参考 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[LiteLLM reasoning](https://docs.litellm.ai/docs/reasoning_content)、[OpenRouter 模型目录](https://openrouter.ai/docs/api/api-reference/models/get-models)。实际 wire 依固定安装的 Pi 1.0.2 公开类型和 adapter 源码验证。
