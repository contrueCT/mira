# ADR 0005：生成扩展的普通文件生命周期

状态：Accepted，2026-10-05。用户确认继续原始 §96，并在明确告知生成扩展测试、导入、执行能够访问宿主 OS 账号可访问的文件、网络、进程凭据及影响宿主稳定性后，确认本阶段也不要求产品隔离环境。

## 与原设计的关系

本决定调整原始 §72–73 的危险代码隔离、文件/网络/资源 scope 要求。原始设计文件的字节不变。生成代码不是天然安全代码，Cordis 也不是沙箱。执行使用当前 OS 身份；没有容器、权限缩减、凭据隔离或 CPU/内存边界。自然语言意图授权与实际 OS 权限仍有效；这不放宽开发助手自身的工具权限或安全规则。无需另设批准按钮、强制风险分类或固定重试否决。

默认生成工作流只编写独立扩展，不修改核心、授权、历史和 runtime security。SDK 是协作接口约束，不是阻止同进程程序越界的强制边界。source、releases、activations 的目录布局只是约定，不限制通用文件工具的 cwd 或可访问路径。

## 复用已有能力

仍用 Pi 原生 read/write/edit/bash、Node 测试和现有 TypeScript 编译器，不增加 LLM 编码框架、专用文件工具、npm 市场、自动依赖安装或注册数据库。模板复制到源码仓库外，通过明确本地链接访问私有 TS SDK、编译器和 Node 声明，安装脚本不执行。只有开发测试需要的本地依赖被显式准备。

`ArtifactStore` 和小 CLI 只管理普通版本文件及显式测试命令的内容证据。stage 完整复制 workspace 与已存在的符号链接依赖，不 import、不执行脚本。SHA-256 覆盖入口选择、所有文件字节/权限及私有链接图。依赖被复制为私有兄弟目录，以便 Node 在 node_modules 外擦除 TS；不是只给入口加 URL query。无效链接、循环和 release/source 嵌套拒绝。

显式 native test 在新副本中执行选定命令；结果记录 command、exit/signal、输出、before/after digest。成功表示命令退出成功且观测到的内容未变，不证明测试质量、安全性或真实模型生成能力。测试后改动不能继承旧 digest 的测试通过；未经测试版本仍可由授权意图选择激活，并如实显示 not-run。任意动态/绝对路径 import、网络、文件读取和可写 OS 身份的恶意修改不在内容证明范围内；此机制不宣称验证任意程序的完整运行环境。

## 状态与发布

普通配置 JSON 可选 `artifactsDirectory` 开启生成生命周期；每个生成 entry 保存当前 digest、revision 和包含 code digest/config 的历史。install 添加新 ID 并保持 disabled；activate/enable 激活；update 切换版本且保留当前启停状态；configure 形成新配置 revision；rollback 显式选择已保存 revision，恢复真实旧代码和 JSON 配置，保留当前启停状态。每次生成代码激活使用全新目录，刷新入口和本地传递 ESM/CJS 模块缓存。旧 release 保留。

所有运行变更复用 `requestChange` 和整批资源租约。工具调用返回 accepted；下一自然模型请求前等待 batch 结束、旧代及服务依赖消费者清理，再发布完整 registry/schema/dispatcher。声明同时包含 activation UUID 与生成版本 SHA，两者含义不同。生成 release 不进入 HMR watcher；手工扩展仍保留 ADR 0004 的官方 HMR 语义。

cleanup 异常保留在 receipt/宿主诊断；remove 即使已移除配置与身份也报告 cleanup failed，不把可能未释放的外部资源藏掉。

remove 默认只撤销注册、等待资源清理、删除 desired entry；保留 source、releases 和 activation 文件。没有永久删除命令或自动垃圾回收。移除后的配置历史不再作为已安装 revision 列表，需要保留配置副本才能按原配置重装。

## 失败与恢复

receipt 分开报告 artifact verification、test evidence、configuration persistence 和 runtime status。先验证内容，再保存 desired JSON，再清理/导入/apply。保存失败不改变运行实例；保存成功后 import/apply 失败保留新 desired state。artifact 在保存前验证失败时 persistence 为 not-attempted。保存之后旧代 cleanup 可能修改普通文件，激活时再次验证失败则保留 saved，但撤销早先的 verified/passed 证据并标记 test invalidated。配置、版本文件、Cordis、PG 和外部副作用不构成原子事务。

重启重新验证并按已保存 enabled/version/config 加载。disabled 版本不 import。保存之后、apply 之前崩溃会在重启按 desired state 初始化；这不是重放未知工具调用，但初始化本身可能再产生扩展副作用，扩展需自行处理。stage release 发布后、manifest 发布前崩溃可能留下未列出的普通目录；不自动执行它。普通文件不是抗恶意篡改证明，也不与外部编辑器构成 CAS。

未知结果继续由已有 durable intent/outcome 呈现给模型，不自动盲重试。显式 rollback 是另一次可能失败的激活，不能撤销邮件、文件写入等外部效果，不承诺原子恢复旧代。测试结果和过程内管理 receipts 不是第二套权威历史。

## 验收边界

见 [本阶段验收](../acceptance/generated-extensions.md)。仅假 provider CLI 与确定性模型测试，无 HTTP/UI、真实模型质量/自主生成闭环、市场、自动安装或部署。Memory 仍独立 Git，State 普通文件；不增加文件变更通知、Wake 或重注入。
