# 公开技能与按需工具验收

范围：ADR 0023；基线 `a7eda5f83f7d6d56b8555c11b003ad833934aed8`。本记录区分代码机制、实际脚本运行与模型文字模拟；不代表生产 provider 或真实用户资料验收。

## 已执行的真实验证（2026-10-14）

- 使用官方 GitHub Contents API 获取固定版本公开 OpenAI pdf/doc/transcribe 与 agent-browser；完整 Apache-2.0 许可、上游 SHA256、修改标记在源码中保留。没有引用私有运行环境技能。
- `tests/unit/bundled-skills.test.mts` 经真实 Pi loader 发现五项技能，并经实际 PiDurableRuntime 的普通 read 工具逐个读取。system 初始只有元数据、没有技能正文；五次 read intent/outcome 进入原有持续上下文。provider 回复是确定性合成。
- 同一测试实际运行官方 `transcribe_diarize.py`，使用 stdlib 生成静音 WAV，`python3 -S` 无 SDK、隔离 HOME、无凭据环境。dry-run 返回默认参数；缺密钥、错误 diarization 参数、缺文件返回真实错误。没有转写或音频上传。
- 使用环境已有的 reportlab/pypdf/python-docx，实际生成公开合成 PDF/DOCX 并提取文本/回读段落。官方未改动的 `render_docx.py` 经已有 LibreOffice/Poppler 生成 PNG；实际检查了 DOCX 与 PDF PNG。Poppler 出现不可写字体缓存警告，渲染仍产生结果；这些是简单 fixture，不声称覆盖所有字体、扫描件或复杂版式。
- 隔离临时 venv 实际安装 PyPI `tavily-cli==0.1.8`，21 个依赖包；运行 `tvly --version`、`tvly search --help`、`tvly extract --help`。两个实际安装命令的帮助都确认支持无 key 限额访问。未运行 init/login、未读真实用户配置、未发起 live 查询。另用安装后的真实 Click CLI 注入合成 keyless cap、禁用 socket connect，验证 `search --json` 输出明确错误且 exit 3；这是合成响应协议检查，不是 live 搜索。
- npm registry 验证 `agent-browser@0.39.1` 可用，源码 tag 对应 `1165952d74ceed98fdc2dd97190ad41f44dd0e24`。包解压约 114 MiB；本次未下载/安装 CLI 或 Chrome、未真实启动浏览器，不能把源码命令核查写成浏览器成功。

## 首次失败和修正

- 普通 pnpm 在默认不可写用户缓存失败；指定本轮工作区缓存后，离线安装又因缺少 registry metadata 失败。正常锁定安装通过供应链检查；未跳过检查、未改锁文件。首次聚合检查中嵌套命令仍从 PATH 调到了旧 pnpm，743/745 通过，两个工具链测试因版本解析失败。把仓库指定 pnpm 11.28.4 放到 PATH 首位后重跑，不修改测试或忽略失败。
- 新测试起初未归入现有 Pi 的 Bundler 类型检查配置，导致第三方 NodeNext 类型报错；将测试纳入既有 tsconfig.pi 并从基础配置排除后，类型检查通过。
- 首轮真实技能读取测试使用原有小 contextWindow fixture，读取完整技能期间触发压缩预算错误；扩大该 fixture 到 131072 后通过，未修改产品压缩机制。
- 依照源码 pyproject 尝试安装 Tavily 0.1.9，registry 实际无该版本，uv 返回无法解析。`pip index versions` 确认最高可安装为 0.1.8；改为实测的 0.1.8，未把未发布源码版本写成安装成功。
- 先前研究阶段的文字模拟据交接报告曾在小依赖安装前过度要求确认；原始临时记录当前不可取得，只保留该报告结论，不重建或冒称可复查的原始模拟。现版统一说明常规小依赖用户态按需准备，不反复确认；系统权限、大下载和外发/费用另看实际用户语境。

## 聚合检查

`pnpm check` 使用固定 pnpm 11.28.4 的完整 PATH 通过：类型、包边界、745 个 Node 测试、42 个 Web 测试及工具/页面构建。加强逐技能正文断言及两项审查修复后，完整 `pnpm check` 再次通过，三项 focused 测试也再次通过。`git diff --check` 与新文档/技能相对链接核对通过。真实 PostgreSQL/浏览器全链路将以最终 head 的 CI 结果分别报告。

## 首轮独立模拟与审查

fresh gpt-6.1-sol/max 独立文字模拟使用实际技能、运行说明和产品 Prompt；另一个 fresh gpt-6.1-sol/max 独立判读与审查。A 文档小依赖自动准备、B 云转写必要选择点、D 已有 curl 只读表单的计划可接受；C 在 Tavily 429 后直接结束整项研究，被判为完成度失败。保留首次原件，未将它重写成全部通过。已澄清只禁止绕过同服务/目标限制，仍应利用已有工具读取已知独立官方公开来源；不能在合法步骤尚未尝试时早停。

审查另发现 agent-browser v0.39.1 官方 postinstall 即使在 local prefix 安装也可能改写已有 global symlink。隔离的合成函数探针复现该行为，未执行完整安装。命令已改为 `npm install --ignore-scripts --prefix`，并直接调用官方 Node launcher；源码确认 launcher 能处理包内可执行位、缺 binary 时安全失败。本次仍未验证114 MiB包的实际平台binary启动。

首轮审查的3项focused测试、typecheck、boundaries和diff检查通过；报告明确部分上游URL独立重读为cache miss，所有未改动文件仍以实际取回的上游字节做hash核对。修复后保留首次原件，单独续测 C：计划用现有 Python GET 已知 Node 官方页，读取真实内容后才核实支持状态，不假定已经成功。另一个 fresh gpt-6.1-sol/max 独立复审判定该行动计划纠正早停，确认两项 P2 已修、未发现新 P0–P2。该复审再次通过三项focused测试、类型、边界、链接/hash核对，重跑 Tavily 0.1.8 help/禁网合成cap、官方DOCX渲染并检查PNG；114MiB native CLI和live服务仍未执行。

## 首轮 CI 的既有附件 fixture 竞态

草稿 PR 首轮 head `5f0e2a9a10781858c606b86a78a3a69325e4f941` 的 [CI run 38515461477](https://github.com/contrueCT/mira/actions/runs/38515461477) 通过 `pnpm check:all`（含真实 PostgreSQL），浏览器 fixture 为 33/34 通过。失败断言把两个并发上传的请求到达顺序当成用户文件选择顺序；本次到达顺序相反，产品按选择顺序保留的信封反被误判。后续三个 joined browser gates 被跳过，未算通过。

获准后只修 `tests/e2e/web.spec.ts`：文件名固定映射 ID，挂起第一个文件的响应，等第二个文件显示且发送仍禁用，再释放第一个；断言选择顺序、刷新和显式重试信封保持一致。没有改生产上传/界面代码，也没有单纯重跑碰绿。修复经另一个 fresh gpt-6.1-sol/max 独立复核，无发现；逆序响应仍能让真实的完成顺序排序错误失败，且刷新不重发、显式重试同信封的断言保留。

本地类型检查通过。使用已有 `/usr/bin/chromium` 的本地 fixture 尝试因 sandbox Unix socket EPERM 未启动；正式提权执行器也在启动时因只读路径失败。没有下载浏览器、修改安全设置或绕过限制，因此不能把本地浏览器检查称为通过；新 head 的实际浏览器验证仍以 CI 为准。

## 尚未覆盖的验证

模型模拟不执行包安装、网络、解析或上传，不能替代以上实际检查。本地未执行本轮 PostgreSQL/浏览器全链路，最终提交的完整门禁以草稿 PR 对应确切 head 的 CI checks 为准。未实际验证 live Tavily、agent-browser 交互、OpenAI 付费转写、OCR 或大模型下载。
