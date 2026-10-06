# 模型目录、自定义连接与发现

状态：本增量提供离线目录、显式配置、模型列表发现和可注入 `PiDurableRuntime` 的真实协议 transport。`pnpm demo` 仍是原有假 provider 演示；没有交互 CLI、HTTP/UI、自动压缩策略、OAuth／云账号登录或部署入口。尚未配置用户凭据，也未执行真实付费模型调用。

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

## 显式配置

配置文件放在源码仓库之外；使用绝对路径更容易确认。只保存环境变量名字，不保存 API Key，不加载默认 auth 文件、不执行取密钥 shell 命令、不扫描其他环境变量、不读取云凭据文件。以下是格式示例，数字仅用于展示配置结构，实际值必须按供应商资料填写。

```json
{
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

发现返回模型 ID／可选名称及 endpoint，不能证明 ID 支持选定推理协议，也不提供虚构的 context、输出限额、图片／推理能力或价格；这些仍需用户确认后填入配置。

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
});
```

该片段展示现有组装接口，需要调用方持有真正 writer 与应用配置，不是独立可运行的新服务。创建 transport 不读取 Key，只有执行其 streamFn 才读取指定变量并调用网络。`description` 只含非秘密模型信息；凭据不进入 model、Prompt 或历史 metadata。自定义 provider 用独立 `createProvider` 和确切协议 adapter map，无内置 headers、OAuth、云配置、环境回退；选定 transport 固定模型和 endpoint，调用时不能覆盖为其他模型或传入任意 Key/headers/fetch。最终 HTTP headers 从当前请求的 Key、内置静态 metadata 和 Pi 生成的 Anthropic beta 列表重新构造，SDK 自动加入的 `OPENAI_CUSTOM_HEADERS`／`ANTHROPIC_CUSTOM_HEADERS`／organization／project 不会透传到服务器；不通过临时修改全局环境实现隔离。OpenAI 两种协议若存在 `OPENAI_LOG`、Anthropic 若存在 `ANTHROPIC_LOG`，会在创建和请求时拒绝，避免 SDK 在清理前把响应、请求 headers 或 Key 写入原始 debug 日志；需移除该变量使用本组装的简洁诊断。

本阶段 transport 只向调用方输出完整的终止消息事件，上游 SSE 分片在内部消费；不暴露实时 text/thinking/tool delta，避免跨分片拼接泄露凭据。未来交互 CLI 若需要逐 token 显示，应单独设计凭据安全的流式接口；当前不会用一套脆弱的增量替换规则改写有效 payload。

transport 通过 Pi `Models.streamSimple` 调用，Runtime 保持注入接口、同轮工具、持久 intent/outcome、恢复与显式压缩路径；不把 provider registry/auth 搬进 life/context/runtime-pi，不增加授权门禁。模型重试设为零，不自动重发不确定的网络调用；取消沿用 runtime signal。采样参数仅保留 runtime 显式 temperature/reasoning/maxTokens，没有本阶段新增默认采样策略。Pi 组装完成的实际 output token 字段必须存在，并按协议再次校验上限（包括 Mistral 和 Google 的相应字段）；如果协议把低限额自动放大（例如 Responses 最低 16），超过配置／请求上限会在发出前失败，不悄悄扩大限额。

自定义价格明确为 unknown。Pi Model/usage 要求数值 cost，当前内部零值仅为满足 SDK 的计算占位，绝不是免费或实际账单；消费者不能用这些零值做费用报告。内置也只提供目录估计。HTTP 错误响应和异常细节不会直接输出，避免服务器回显密钥；诊断只提示 endpoint／协议／模型／凭据类别；清理最终消息的原始错误／diagnostics；如果完整内容、工具参数或其它返回字段回显当前请求 Key，整条响应失败，不静默改写成不同的可执行工具调用。取消仍报告 aborted。

## 验证边界

离线测试使用注入 fetch，把真实 Pi adapter 发出的 HTTP 请求与合成 SSE 响应配对，覆盖三种协议的路径、headers、独立密钥、body、输出解析、完整 Prompt、同轮工具及重启延续；不是实际供应商联通。发现测试不访问真实网络。`pnpm check` 验证类型、包边界、离线回归和工具构建；真实 PostgreSQL 仍由精确提交的批准 CI 执行，不能把 mock 或跳过的测试算作真实模型验收。
