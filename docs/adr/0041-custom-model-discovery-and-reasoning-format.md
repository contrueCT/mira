# ADR 0041：自定义模型发现与推理格式

状态：Accepted。2026-10-17 用户批准保存配置时自动测试参数格式；取代此前只手动选择格式的决定。实际供应商是否应用推理强度仍需服务端证据。

## 问题与边界

自定义模型的 `reasoning: true` 声明模型能力，但不能独立证明代理接受哪个请求参数。标准 Chat Completions 使用 `reasoning_effort`；部分兼容服务采用其他字段。LiteLLM 的 UnsupportedParamsError 也可能来自其模型映射/参数支持表，仅凭该错误不能确定替代字段。不能把不发送推理参数当作保持推理强度的修复，正常聊天不自动开启 drop_params 或换格式重试。配置测试仅在明确的参数不支持响应后尝试另一种格式。

Mira 已固定 Pi 1.0.2，其公开 `OpenAICompletionsCompat.thinkingFormat` 支持不同 wire 格式。新增自定义模型可选 `reasoningFormat: "openai" | "openrouter"`，只用于 `openai-completions`。显式格式分别使用 Pi 原生适配发送 `reasoning_effort` 或 `reasoning: { effort }`；两者都是 effort 格式，不把只有开关的 thinking 协议伪装成多档强度。不给用户任意 payload JSON 编辑器，不拷贝 Pi 的协议实现。

- Web 设置默认“自动测试并保存”。保存当前选中的推理 Chat Completions 模型时，若未指定格式，先调用 `POST /api/models/probe`；按 OpenAI、OpenRouter 顺序验证，成功后把明确格式放入原 `PUT /api/settings`，沿用 revision CAS。已指定格式及其他协议不自动探测。
- 每种格式最多一个简短请求，总计最多两个、30 秒、每次最多 1024 输出 token（同时受模型上限限制），不附带对话、工具或 Memory。使用当前有效推理强度；偏好为 off 时只在探针使用 low，保存偏好保持 off。界面提前说明会调用模型并可能产生少量费用。
- 只有 HTTP 400/422 明确拒绝当前推理字段才换下一种。401/403、限流、网络故障、服务错误、无效参数值及无关参数错误停止测试，保留草稿；不自动重试或去掉控制字段。
- 探针使用 Pi 公开 compat 和实际 transport，密钥保持服务器闭包，诊断沿用脱敏机制。返回成功只表示接口接受该请求，不证明代理没有忽略字段，也不保证实际推理强度。
- 探针不写配置。保存前检查草稿代次及取消信号，关闭/Escape/返回撤销后续保存；已发出的测试可能已计费。HTTP 断连、服务关闭及 writer ownership 失效取消在途探针。设置版本冲突不能覆盖。
- 成功格式与模型配置一起保存在私有文件中。编辑连接地址/协议或模型 ID 清除对应格式，下一次保存当前模型重新测试；其他未选中的模型在被选中保存时测试。手动选择仍可用。
- 普通聊天、child、Dreaming 沿用已保存格式，不探测或切换。未经 Web 重新保存的旧配置和 CLI 缺字段仍沿用 Pi 默认行为，不迁移或清理数据。内置目录、Responses 与 Anthropic 保持原有语义。

## 发现与编辑

继续由服务器使用已配置/草稿凭据请求同源目录，保留原有鉴权、重定向禁止、15秒/2MB/页数上限及错误脱敏。目录返回的明确限额、text/image输入、reasoning布尔能力经白名单校验后用于草稿，具体字段见 [模型说明](../development/models.md)。不依据模型名、owned_by 或公共内置目录推测代理能力；不自动导入推理请求格式或价格。

发现下拉框是可重复使用的选择动作；选择条目即填入已知字段，已有同ID profile优先保留原值。未知 token 限额仍留空并明确要求按服务文档填写，不能伪造精确容量。新草稿默认以文本模式配置，未声明推理能力可后续编辑。目录为空、未支持发现或请求失败均保留手动输入。没有新增主界面入口。

## 验证

- `tests/unit/model-probe.test.mts`：真实 Pi 序列化、逐格式拒绝/成功、强度与输出上限、凭据绑定/脱敏、版本冲突、取消、失败不保存。浏览器 fixture 覆盖保存顺序、失败草稿、重复点击及迟到响应。所有 provider 响应均为合成，不宣称 live 路由联通。

- `tests/unit/custom-model-setup.test.mts`：真实回环 HTTP 目录、私有文件保存/重读、真实 Pi runtime payload；合成端点拒绝旧 effort 字段而不触发重试，显式选择另一兼容格式后保留 high；验证密钥不回填、不进入错误、旧配置不静默关闭推理、非法跨协议格式拒绝。
- 既有 reasoning-settings 三种协议序列化/恢复测试保持；新增多档格式 wire 检查与发现字段校验。
- `tests/unit/web-http.test.mts` 验证实际 HTTP 响应保留元数据白名单且丢弃原始字段/凭据。`tests/e2e/management-real.spec.ts` 覆盖真实浏览器→HTTP发现→选择保存→服务重启→PostgreSQL/runtime→合成模型 HTTP 的完整路径。
- 浏览器 fixture 覆盖直接选模型、缺失限额、保留旧模型、格式选择与保存重开、空/错误手动兜底、窄屏/桌面截图；它不等同真实供应商验收。

参考 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[LiteLLM reasoning](https://docs.litellm.ai/docs/reasoning_content)、[OpenRouter 模型目录](https://openrouter.ai/docs/api/api-reference/models/get-models)。实际 wire 依固定安装的 Pi 1.0.2 公开类型和 adapter 源码验证。
