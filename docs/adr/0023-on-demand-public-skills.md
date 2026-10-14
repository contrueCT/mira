# ADR 0023：公开技能与按需工具

状态：Accepted，2026-10-14。用户要求优先复用现成能力、参考并直接使用 OpenAI 官方 PDF 等 skills，缺少工具由 Mira 运行时按需安装；不捆绑过多依赖，浏览器控制不采用 Playwright CLI。

## 实现

沿用 ADR 0011 的 Pi skill 发现、自然请求目录刷新及普通 read/bash。新增公开 OpenAI `pdf`、`doc`、`transcribe`，原样保留 doc 渲染脚本和 transcribe CLI/reference；新增 agent-browser 官方发现 skill，实际完整工作流由已安装 CLI 的 `skills get core` 提供。Tavily 用小型 Mira 命令指南直接调用官方 CLI search/extract，不另建搜索、MCP、包管理或解析服务。

上游源码固定到 commit，保留完整 Apache-2.0 通知；[来源清单](../../skills/upstream-sources.json)记录逐文件上游 URL、SHA256 和改动标记，各目录 UPSTREAM.md 解释适配。只引入公开授权内容，不复制运行环境内的私有技能。UI 装饰资源/其他 agent 专属元数据不进入 Mira。

适配仅涉及 Mira 工作路径、普通工具调用、按需依赖及自然语言说明。应用不自动读取 PDF/Word/音频内容；模型按任务主动读取 skill 再执行解析。用户文件/venv/输出在源码外，附件仍用已有引用与 send_attachment。源码依赖清单和锁文件不变。

## 运行选择

- 文档优先已有 Python/渲染工具；仅安装任务缺少的小依赖至用户态 venv。文本提取与版式验证分别报告。
- Tavily search/extract 有无凭据时行为和额度限制，以实际 CLI 返回为准；不自动 init、OAuth、配置密钥或启用认证型 research/crawl/map。
- agent-browser 普通 URL read 无需启动 Chrome；交互才使用浏览器，复用适当的已有 executable 或解释额外下载需求，不预装第二套浏览器、默认连接个人 profile 或引入第二层 chat 模型。
- OpenAI transcribe 是云端 API，不是本地免费模型。已有 SDK/密钥不等于已授权上传录音和费用；未具备相应意图时先说明，CLI dry-run 不上传。

[运行说明](../development/runtime-tools.md)集中说明小依赖常规准备与系统权限/大下载/收费/凭据的区别，避免对每个小依赖重复确认。判断仍由主模型结合实际用户语境完成，不增加硬风险规则、授权引擎或额外模型调用。

## 验证

新增测试通过实际 createSkillLoader、Pi system 元数据与普通 read continuation 检查五个技能；逐文件检查未修改脚本/许可证 hash；真实执行官方转写脚本 `--dry-run` 与参数/缺密钥错误，子进程无 SDK、用户 HOME、密钥和网络调用。模型为确定性 fixture，不代表自然语言判断质量。

实际文档渲染/提取、工具安装结果、首次失败与独立模型模拟分别记于[验收记录](../acceptance/on-demand-skills.md)。不把文字模拟当真实工具执行，也不把完整 CI 之前的局部检查称为完整通过。
