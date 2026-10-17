# 模型目录、自定义连接与发现

状态：本增量提供离线目录、显式配置、模型列表发现和可注入 `PiDurableRuntime` 的真实协议 transport。`pnpm demo` 仍是原有假 provider 演示；本地 Web 设置直接接收并保存 API Key，见 [安装与使用](local-web.md)；下述环境变量 JSON 与命令是独立 CLI／程序化接口。没有交互 CLI、自动压缩策略、OAuth／云账号登录或公网部署入口。尚未配置用户凭据，也未执行真实付费模型调用。

## 内置目录

```sh
pnpm models --help
pnpm models list
pnpm models list openai
pnpm models details openai '<model-id-from-list>'
```

输出为普通 JSON。目录直接消费固定依赖 `@earendil-works/pi-ai@1.0.2` 的 `providers/all` 现代 `Models` API，不复制模型注册表，不调用 `/compat` 的弃用全局函数，也不刷新网络目录。生成时间由上游返回；供应商及 chat 模型数量从实际包数据计算，不承诺永远固定。独立 image/classifier 模型不用于 Mira 主认知流。

每个模型列出供应商、ID、名称、友好协议名及确切 `model.api`、目录 base endpoint、上下文／输出上限、reasoning、input 和上游价格估计。同一供应商可以混用多个协议，不能用供应商名推测协议。目录 endpoint 不保证等于最终请求 URL，适配器会追加路径，有些云服务还需要账户配置。不能把未知／零价项理解为免费。

能列出不代表已经有凭据、模型权益或可用账户。普通 API Key 接入需要显式配置；内置 OpenAI 仅接受其 `sk-` API Key 路径，拒绝 Pi 会解释成 ChatGPT access token 的其它凭据格式，不能借此绕过本阶段未接入的 OAuth 流程；需要云账号、项目／账户参数或订阅登录的条目仍可查看，但会明确标注本阶段不支持该配置流程。当前延期供应商为 Amazon Bedrock、Azure、Cloudflare 两种服务、GitHub Copilot、Google Vertex、OpenAI Codex、Radius。普通 Google Gemini API Key 可使用原生 Pi 适配器；该适配器不支持注入 fetch，因此不支持 mock fetch，且不能改成自定义地址。进程若设置了 `GOOGLE_GENAI_USE_VERTEXAI` 或 `GOOGLE_GENAI_USE_ENTERPRISE`，此 Gemini 组装明确拒绝启动／请求，需先移除这些模式变量；不会偷偷切换到云协议或修改进程环境。

## CLI／程序化显式配置

配置文件放在源码仓库之外；使用绝对路径更容易确认。只保存环境变量名字，不保存 API Key，不加载默认 auth 文件、不执行取密钥 shell 命令、不扫描其他环境变量、不读取云凭据文件。以下是格式示例，数字仅用于展示配置结构，实际值必须按供应商资料填写。

```json
{
  "defaultThinkingLevel": "medium",
  "builtinCredentials": {
    "openai": { "apiKeyEnv": "MIRA_OPENAI_KEY" }
  },
  "customConnections": [
    {
      "id": "my-gateway",
      "name": "My gateway",
      "baseUrl": "https://gateway.example/proxy/v1",
      "api": "openai-completions",
      "apiKeyEnv": "MIRA_GATEWAY_KEY",
      "models": [
        {
          "id": "manual-or-discovered-id",
          "contextWindow": 8192,
          "maxTokens": 1024,
          "reasoning": false,
          "input": ["text"]
        }
      ]
    }
  ]
}
```

`readModelConfiguration(file)` 和 `parseModelConfiguration(value)` 验证普通 JSON。自定义连接必须明确提供以下内容：

- `id`：唯一小写连接 ID，运行时 provider 为 `custom:<id>`；即使叫 openai 也不会覆盖内置 openai
- `baseUrl`：HTTP(S) 地址，可带任意路径前缀，不接受用户名、密码、query、fragment 或占位符
- `api`：`openai-completions`（Chat Completions）、`openai-responses` 或 `anthropic-messages`；无任意协议名伪装
- `apiKeyEnv`：仅为此连接读取的环境变量；必须存在非空、无空白/控制字符的 API Key，OAuth token 不适用；无密钥本地服务尚未支持
- `models`：可为空以便先发现；实际调用需手动选择模型并填写正整数 `contextWindow`／`maxTokens`，输出不能超过上下文；`reasoning` 和 `input` 必须明确
- 可选 `modelsUrl`：同 origin 的完整模型列表 endpoint；保留尾部 `/`，不接受 query/fragment/URL 凭据，不允许改往另一个域名发送密钥

HTTP 可用于用户明确配置的本地或可信服务，但不会加密 API Key；远程服务应使用 HTTPS。本阶段不自动判断主机是否值得信任，用户需要确认自己的目标服务器。配置本身不读取密钥、不发送请求，也不保存发现结果。

## 地址与发现

```sh
pnpm models custom /absolute/path/models.json
pnpm models discover /absolute/path/models.json my-gateway
```

`custom` 只列出已配置的自定义连接与模型，不读取密钥。`discover` 是唯一联网的目录命令，会用指定连接自己的 Key 发 GET。

地址使用对应 Pi/SDK 的明确约定，保留用户路径，不自动剥离 `/coding`、`/anthropic` 或跳到其他 host：

| 协议 | 配置 baseUrl 示例 | 推理 endpoint | 默认模型列表 endpoint |
| --- | --- | --- | --- |
| Chat Completions | `https://host/prefix/v1` | `/prefix/v1/chat/completions` | `/prefix/v1/models` |
| Responses | `https://host/prefix/v1` | `/prefix/v1/responses` | `/prefix/v1/models` |
| Anthropic Messages | `https://host/prefix` | `/prefix/v1/messages` | `/prefix/v1/models` |

OpenAI 兼容协议不会猜测并补 `/v1`。如果供应商不遵循该路径，填写 `modelsUrl`；这只改变发现 endpoint，不改变推理 baseUrl。Anthropic 使用 `x-api-key` 与 `anthropic-version: 2023-06-01`，OpenAI 两种协议使用 Bearer。

实现参考 [CC Switch 固定版本 model_fetch.rs](https://github.com/farion1231/cc-switch/blob/f68fe30fd963a33c4859ea7875ca4ac4be85e5c8/src-tauri/src/services/model_fetch.rs)。Mira 复用“按协议鉴权、拉取列表、手动选择”的方式，但不照搬路径剥离／探测回退。OpenAI 支持 `data[].id` 和可选 `name`，兼容响应在没有 data 时可用 `models[].slug`／`id`。Anthropic 需要 `data` 与布尔 `has_more`，用 `last_id`／`after_id` 翻页，不跟随服务端给出的任意 next URL。参考 [OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list) 和 [Anthropic models API](https://platform.claude.com/docs/en/api/models/list)。

发现有一次请求全过程的 15 秒超时、最多 20 页／10000 原始模型条目／累计 2 MB 响应限制；重复 ID 稳定去重，游标循环拒绝。重定向一律拒绝，包括同源重定向，不携带凭据探测其他主机。401、404、无模型列表、畸形响应和超限都明确失败，不返回伪造模型或悄悄保存半份列表。空数组是有效空结果。失败后仍可手动填写模型 ID。

成功响应的 ID／名称／翻页游标若包含连接 Key，发现会明确失败；不会把模型 ID 改写或返回误导性的空成功。endpoint 路径包含解析后的 Key 时也会在发送前拒绝。

发现返回模型 ID／可选名称及 endpoint；如果目录明确提供有效能力字段，选择模型时会填入可编辑草稿。支持 Mira 字段 `contextWindow`、`maxTokens`、`input`、`reasoning`，以及 [OpenRouter 目录](https://openrouter.ai/docs/api/api-reference/models/get-models)的 `context_length`、`top_provider.context_length`、`top_provider.max_completion_tokens`、`architecture.input_modalities`。只接受正整数限额和已支持的 text/image 输入；畸形字段忽略，最大输出超过已知上下文时留空。缺失值不根据 ID、owned_by、价格或其他目录猜测。标准 OpenAI `/models` 通常只提供模型身份信息，缺失的 token 限额仍须按该服务文档补充。已有同 ID 模型保留原配置，不被目录覆盖；空结果或错误仍可手动添加。

目录支持推理不等于当前 endpoint 支持某一种推理请求字段，发现不会自动启用协议扩展或改写连接。保存前可编辑、取消；发现本身不保存模型或密钥，不发送聊天/测试模型请求。

## 程序化组装

```ts
import { readModelConfiguration, createModelTransport } from '@mira/server';
import { PiDurableRuntime } from '@mira/runtime-pi';

const configuration = await readModelConfiguration('/absolute/path/models.json');
const transport = createModelTransport(configuration, {
  kind: 'custom', connection: 'my-gateway', model: 'manual-or-discovered-id',
});
// 内置选择为 { kind: 'builtin', provider: 'openai', model: '<catalog-id>' }
// writer、tools、miraPrompt 来自现有服务器组装及单写者生命周期。
const runtime = new PiDurableRuntime({
  writer, tools, miraPrompt,
  model: transport.model,
  streamFn: transport.streamFn,
  thinkingLevel: transport.thinkingLevel,
});
```

该片段展示现有组装接口，需要调用方持有真正 writer 与应用配置，不是独立可运行的新服务。创建 transport 不读取 Key，只有执行其 streamFn 才读取指定变量并调用网络。`description` 只含非秘密模型信息；凭据不进入 model、Prompt 或历史 metadata。自定义 provider 用独立 `createProvider` 和确切协议 adapter map，无内置 headers、OAuth、云配置、环境回退；选定 transport 固定模型和 endpoint，调用时不能覆盖为其他模型或传入任意 Key/headers/fetch。最终 HTTP headers 从当前请求的 Key、内置静态 metadata 和 Pi 生成的 Anthropic beta 列表重新构造，SDK 自动加入的 `OPENAI_CUSTOM_HEADERS`／`ANTHROPIC_CUSTOM_HEADERS`／organization／project 不会透传到服务器；不通过临时修改全局环境实现隔离。OpenAI 两种协议若存在 `OPENAI_LOG`、Anthropic 若存在 `ANTHROPIC_LOG`，会在创建和请求时拒绝，避免 SDK 在清理前把响应、请求 headers 或 Key 写入原始 debug 日志；需移除该变量使用本组装的简洁诊断。

本阶段 transport 只向调用方输出完整的终止消息事件，上游 SSE 分片在内部消费；不暴露实时 text/thinking/tool delta，避免跨分片拼接泄露凭据。未来交互 CLI 若需要逐 token 显示，应单独设计凭据安全的流式接口；当前不会用一套脆弱的增量替换规则改写有效 payload。

transport 通过 Pi `Models.streamSimple` 调用，Runtime 保持注入接口、同轮工具、持久 intent/outcome、恢复与显式压缩路径；不把 provider registry/auth 搬进 life/context/runtime-pi，不增加授权门禁。模型重试设为零，不自动重发不确定的网络调用；取消沿用 runtime signal。采样参数仅保留 runtime 显式 temperature/reasoning/maxTokens；推理默认值与能力适配见下节，其余采样不新增默认策略。Pi 组装完成的实际 output token 字段必须存在，并按协议再次校验上限（包括 Mistral 和 Google 的相应字段）；如果协议把低限额自动放大（例如 Responses 最低 16），超过配置／请求上限会在发出前失败，不悄悄扩大限额。

自定义价格明确为 unknown。Pi Model/usage 要求数值 cost，当前内部零值仅为满足 SDK 的计算占位，绝不是免费或实际账单；消费者不能用这些零值做费用报告。内置也只提供目录估计。HTTP 错误响应和异常细节不会直接输出，避免服务器回显密钥；诊断只展示下文约定的有界脱敏错误字段；清理最终消息的原始错误／diagnostics；如果完整内容、工具参数或其它返回字段回显当前请求 Key，整条响应失败，不静默改写成不同的可执行工具调用。取消仍报告 aborted。

## 验证边界

离线测试使用注入 fetch，把真实 Pi adapter 发出的 HTTP 请求与合成 SSE 响应配对，覆盖三种协议的路径、headers、独立密钥、body、输出解析、完整 Prompt、同轮工具及重启延续；不是实际供应商联通。发现测试不访问真实网络。`pnpm check` 验证类型、包边界、离线回归和工具构建；真实 PostgreSQL 仍由精确提交的批准 CI 执行，不能把 mock 或跳过的测试算作真实模型验收。

## 模型请求错误

模型失败不再统一隐藏为配置检查提示。transport 在凭据仍仅存在于请求闭包时，生成有界脱敏诊断，保留实际可用的 HTTP 状态、provider message/code/type、request ID，以及网络/TLS/超时 cause 的 message/code。HTTP 状态与 request ID 只从实际响应读取；没有证据时不推测鉴权、余额、模型或协议原因。取消仍单独显示。

HTTP 错误体在 Pi 截断前最多读取64 KiB并提取白名单字段；超限取消余下读取。只选取错误字段，不输出原始请求、headers、stack、任意响应对象或 HTML 错误页；诊断最长约 2 KiB，超长文本明确截断，超过解析上限的错误文本不展示。选中的 Key、常见 URI/form/base64 编码、认证字段及 URL 会隐藏。包含凭据的模型正文/工具调用仍拒绝整条响应，不把改写后的参数交给工具。没有原始错误日志开关。

相同的脱敏文本进入原有 assistant error 历史，并由 Web 状态显示；数据库、工具或其它未分类异常继续使用通用提示。安全诊断只对应实际失败的模型请求，不复用前一轮错误。修复配置本身和重复消息 receipt 不自动重试；重启或一条新消息会依原有 Wake 恢复语义继续未完成输入。测试使用注入 fetch/合成 SSE，不代表真实 provider 联通或账户状态已验收。

### 工具名约定

直接采用扁平名称；复合名称用 snake_case，例如 `history_search`、`history_read`、`extension_inspect`、`extension_stage`、`extension_manage`。Pi 的 read/bash/edit/write/grep/find/ls、Codex 的 exec_command/write_stdin/update_plan、OpenCode 的 read/webfetch/todowrite 都采用这种直接命名习惯，而不是以点号模拟服务方法调用。普通服务 API 的属性名不属于模型工具名。

注册和动态扩展工具统一校验 `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`，以字母或下划线开头，后续仅字母、数字、下划线或连字符；不允许点号、空格或换行。[DeepSeek 官方规范](https://api-docs.deepseek.com/api/create-chat-completion/)允许这些字符，长度上限128；[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)上限64，因此使用共同的64字符界限；首字符同时满足受支持的 Gemini FunctionDeclaration 的字母/下划线要求。此规则在调用模型前检查，不靠 provider 报错才发现。

这是直接改名，不存在旧名称别名、协议映射或历史迁移。已保存的原始历史不改写；如果某条历史里已经有旧点号 assistant 工具调用，严格 provider 仍可能拒绝那段原始调用历史。新工具声明和新调用均使用当前名称，但不宣称旧调用已经迁移；程序不会为此删除、重置数据库或上下文。实际需要处理这种已有数据时须另行明确决定。

命名参考 [Pi 工具注册](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/index.ts)、[Codex 计划工具](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan.rs)、[OpenCode read](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/read.ts)。

## 默认推理强度

Web 既有模型设置及 CLI configuration 可保存 `defaultThinkingLevel`，允许 `off/minimal/low/medium/high/xhigh/max`，缺省 `medium`。这改变了此前 Agent 未传 thinkingLevel 时隐式 off 的行为。实际档位由固定 Pi 1.0.2 模型能力适配，非推理模型 off；目录响应的 `thinkingLevels` 给出支持项。自定义模型的 `reasoning` 必须明确提供，不从模型发现结果猜能力。

界面保留默认偏好并显示当前有效档位；例如 xhigh 在不支持该档位的模型上会变成 high。不能关闭的模型使用其支持项，Pi 能力适配可能选择高于请求值的最低支持档位；这不是模型自主升档。Main、child 和 Dreaming 都显式接收档位；已运行实例不被设置编辑改变，后续实例读取设置。程序化组装需同时传 `transport.thinkingLevel`，直接调用 `streamFn` 时仍需显式传 reasoning，避免会话默认污染独立摘要策略。

压缩固定选择最低支持档，通常 off，不继承 high/xhigh/max。更高档可能增加耗时与成本；相对努力档位不保证固定 token 数。预算型 Anthropic 的思考和答案共用原总输出 cap，思考预算会缩至最多 cap 减 1024；cap 小于 2048 明确失败且不发送请求，不放大 cap 或静默关闭推理。默认 runtime reserve 也限制总输出，可按既有程序化 autoCompaction.reserveTokens 配置；不改变现有上下文预算语义。详见 [ADR 0027](../adr/0027-configured-reasoning-levels.md)。

## Transient request failures

The explicit transport retries a buffered, not-yet-published model request up to
three attempts for verified transient HTTP/network failures. Backoff is 250 ms,
then 1 s; HTTP Retry-After can raise each wait to at most 10 s. Cancellation stops
backoff and prevents another dispatch. Partial responses do not enter history or
execute tools. Authentication, configuration, invalid output, unknown failures,
tool effects and persistence writes are not retried. SDK maxRetries stays zero.
The Web working indicator shows actual waiting/retrying state; exhaustion keeps
bounded sanitized first/last diagnostics separately from the last error used by runtime classification. A received permanent HTTP status vetoes retries even if its error body is interrupted. See [ADR 0029](../adr/0029-bounded-model-request-retries.md)
for exact codes, restart semantics and provider-observability limits.


SDK logging/cloud environment is checked after async credentials and immediately
before synchronous client construction through the pinned public eager adapters.
The SDK modules are loaded at startup, without credentials or network calls;
provider metadata and the public OpenCode routing wrapper are retained. Mistral's
unrelated provider dispatch is unchanged. Global environment/console values are
never modified to suppress SDK logging.

## 自定义推理参数格式

模型设置中的推理 Chat Completions 模型默认在保存时自动测试参数格式：先发送 `reasoning_effort`，仅在服务明确拒绝这个参数时改试 `reasoning.effort`，成功后保存对应 `reasoningFormat: "openai" | "openrouter"`。每种格式最多一个请求，总计最多两个、30 秒、每次输出不超过 1024 token 和模型上限，会产生少量模型调用费用。探针使用当前推理强度，偏好 off 时测试 low，保留保存偏好。请求接受仅说明格式可用，不证明代理实际应用了强度。

测试失败保留草稿；关闭设置取消测试和后续保存。鉴权、限流、网络及非参数兼容错误停止测试。也可按服务文档手动选择格式。编辑连接地址/协议或模型 ID 后重新测试当前所选模型。其他模型选中保存时才测试；无批量付费探测。

正常聊天使用已保存格式。旧配置或 CLI 缺字段仍沿用 Pi 原生默认；普通请求不自动切换或剥离字段。Responses/Anthropic 使用原生适配。详见 [ADR 0041](../adr/0041-custom-model-discovery-and-reasoning-format.md)。
