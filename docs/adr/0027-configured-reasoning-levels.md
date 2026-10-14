# ADR 0027：模型默认推理强度

状态：Accepted scope，2026-10-14。用户批准先实现推理配置、模型瞬时错误恢复、child 压缩和工具输出预算，并分草稿 PR 交付。本文只记录推理配置；不升级 Pi、不增加付费调用、部署、模型自行升档或主聊天入口。

## 问题与决定

固定 Pi 1.0.2 的 Agent 在未传 `initialState.thinkingLevel` 时使用 `off`。模型的 `reasoning: true` 只声明能力，不能自动开启推理。Mira 现在显式传入档位，让设置真正到达 provider 请求。

- Web 既有模型设置及 CLI/程序化 configuration 新增可选 `defaultThinkingLevel`，支持 `off | minimal | low | medium | high | xhigh | max`。未配置时采用 `medium`。
- 能力只来自固定 Pi 公开 `getSupportedThinkingLevels` / `clampThinkingLevel`；非推理模型实际 `off`。自定义模型沿用明确声明的 reasoning 布尔能力及 Pi 默认档位，不凭发现结果猜能力、额外协议字段或极高档支持。
- 保存的是默认偏好；实际档位按当前模型适配。例如无 xhigh 的模型使用 high，不能关闭推理的模型会使用其最低支持档位。Pi 的公开规则优先找不低于请求档位的支持项，再向下找；界面展示当前可选档位及保留的偏好。它是确定性的能力适配，不是模型或工具可触发的升档策略。
- 主 Mira、child 与 Dreaming 通过相同 runtime 接收实际档位。一个运行中的实例保留启动时快照，新 Wake/child turn 使用组装时设置；不改变正在执行的工具、不新建 Wake。偏好通过原私有设置文件和 revision CAS 保存，重启继续读取；不新增数据库表、迁移或日志。
- Runtime API 为 `PiRuntimeOptions.thinkingLevel`。`createModelTransport` 返回解析后的 `thinkingLevel`，组装必须一起传入 runtime。单独直接调用 `streamFn` 仍只遵循显式请求 options，不隐藏地填入会污染压缩的会话默认值。

## 压缩和输出预算

压缩使用独立固定策略，选择该模型最低支持档位，通常是 `off`，必要时为最低非关闭档。它不继承主会话的 high/xhigh/max，不受摘要内容或模型自行决定影响；主会话压缩后恢复自己的原档位。模型价格、内部算力和真实思考量不由这个字段保证。

既有 `maxTokens` 总输出上限继续包括推理和答案。预算型 Anthropic 的 Pi adapter 会先给 maxTokens 加上思考预算；最终 payload hook 将总量限制回原调用上限，并把 `thinking.budget_tokens` 限于 `max_tokens - 1024`。至少保留 1024 答案 tokens；总上限不足 2048 时明确失败且不发请求。不会为使请求成功偷偷扩大 cap，也不会静默关闭已配置的推理。若模型强制预算型推理且摘要 reserve 太小，摘要同样明确失败，最低档策略不承诺所有模型都能在 512 tokens 内生成摘要。自定义连接需要按文档配置足够输出上限；runtime 仍受 context reserve 限制。

因此档位是 provider 的相对努力偏好，预算型模型的实际 token 预算可能低于该档位的 Pi 默认预算。适配后的 high 不意味着固定 16384 思考 tokens，更不代表账单承诺。Adaptive Anthropic 使用其原生 effort 映射；其他协议继续由真实 Pi adapter 序列化，在现有 payload cap 检查下运行。

## UI 与边界

控制只放在既有设置窗口的模型标签。非推理模型展示关闭并禁用调整；切换模型不会抹掉原默认偏好。保存前支持取消、关闭、Escape、浏览器返回/前进、标签草稿、revision 冲突与重读；未保存的密钥仍按原规则清除。不在 Timeline 显示隐藏推理、采样详情或费用估计。

不增加模型调整档位的工具、不解析模型输出来升档，也不把用户任务类别映射成更昂贵档位。不引入额外模型请求、凭据或传输目标。

## 验证

- `tests/unit/reasoning-settings.test.mts`：真实 Pi Chat Completions / Responses / Anthropic SSE 序列化及 Google SDK fetch 拦截；覆盖高/关闭/非推理、能力适配、预算上限、过小 Anthropic cap 的零请求失败、恢复后档位、压缩独立档位、私有设置重启/CAS/非法输入。所有凭据与响应均合成，没有付费请求。
- `apps/web/tests/reasoning.test.ts`：浏览器当前档位预览。
- `tests/recovery/reasoning-settings.test.mts`：生产 Web service、真实 PostgreSQL、主/child/Dreaming 与设置重启链路，只有模型输出合成。必须由 `pnpm test:integration` 使用隔离 `mira_test` 库执行，不跳过。
- `tests/e2e/web.spec.ts`：现有真实 Chromium UI fixture 覆盖切换能力、取消、保存去重、浏览器历史、窄屏截图、冲突与重读；它不是 PG 或真实供应商验收。

本地离线通过不代表 PostgreSQL、浏览器或真实模型验收。该执行环境的 PG/Chromium 启动受 Unix socket EPERM 阻塞，不改变隔离规则规避；真实 PG 与浏览器验证以精确提交的 CI 结果为准。未执行真实供应商付费调用。
