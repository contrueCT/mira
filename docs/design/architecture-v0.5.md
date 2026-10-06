# MiraMate v2
## Persistent Self-Extensible Relational Agent
### Architecture v0.5

---

# 1. 项目定义

MiraMate v2 是一个：

> **持续存在、拥有长期身份与记忆、保持连续认知上下文、能够主动与用户互动，并能够使用乃至自行创造软件能力影响外部世界的个人智能体。**

它的核心不是 Chat，不是 Session，也不是 Workflow。

核心对象始终是：

> **Mira 本身。**

从 Mira 被创建开始，它拥有一条持续生命线：

```text
birth
  │
  ├── user talks to Mira
  ├── Mira reacts
  ├── Mira remembers something
  ├── time passes
  ├── external event happens
  ├── Mira wakes
  ├── Mira continues thinking
  ├── Mira uses a tool
  ├── Mira creates an extension
  ├── software acts independently
  └────────────────────────────────────→ time
```

用户不会创建新的 Mira，也不会创建新的 Conversation。

底层可以存在：

- model messages；
- Wake Run；
- context compaction；
- runtime trace；

但它们都只是实现细节，不应该成为产品中的 Conversation Session。

---

# 2. 核心设计原则

## 2.1 Continuity over Sessions

Mira 是一个持续存在的个体。

错误：

```text
Session A → Mira A
Session B → Mira B
Session C → Mira C
```

正确：

```text
                  Mira
                   │
───────────────────┼────────────────────→ time
       interaction │ interaction
             wake  │ reflection
```

Wake 结束，不代表 Mira 的认知上下文结束。

只要 Working Context 仍然存在，后续 User Message、External Event、Tool Result 或 Wake 都继续追加在同一条 Cognitive Stream 上。

---

## 2.2 Persistent life does not mean persistent inference

Mira 持续存在。

LLM 不需要持续运行。

```text
Mira Life
────────────────────────────────────→

       ▲            ▲           ▲
       │            │           │
      Wake         Wake        Wake
       │            │           │
      LLM          LLM         LLM
```

模型调用只是生命中的认知活动。

---

## 2.3 The model provides the mind

系统不负责模拟：

- 情绪；
- 兴趣；
- 人格转移；
- 关系数值；
- 心理状态机。

系统负责提供：

- 连续上下文；
- 历史；
- 长期记忆；
- 时间；
- 外部事件；
- 工具；
- 自扩展能力；
- 授权语境；
- 技术边界。

然后由模型自行形成反应、理解和行动。

> **Infrastructure provides continuity, history, agency and boundaries. The model provides the mind.**

---

## 2.4 Semantic over Mechanical

情绪、关系、关注和心理变化优先自然存在于：

```text
Working Context
```

以及必要时进入：

```text
Semantic Memory
```

而不是：

```text
anger = 0.37
trust = 0.82
mood = "frustrated"
```

也不要求 Mira 每发生一次心理变化都显式更新：

```text
STATE.md
```

如果一个心理状态能够由连续上下文自然承载，就让它自然存在。

> **If a mental state can naturally persist through context, do not externalize it merely to make it explicit.**

---

## 2.5 No dedicated Semantic State layer

MiraMate v2 不再设计独立：

```text
SemanticState
STATE.md
Emotion State
Relationship State
Active Threads State
```

普通短期状态直接存在 Working Context。

例如：

```text
Mira:
……又重写？我们昨天才刚把这块理顺。

User:
因为我刚发现了一个架构问题。
```

此时 Mira 的无奈、兴趣和当前心理状态已经自然存在于上下文中。

没有必要再：

```text
edit STATE.md
```

去声明：

```text
Mira currently feels mildly frustrated.
```

---

## 2.6 心理状态的自然生命周期

一个状态可能这样演化：

```text
瞬时反应
    │
    ▼
Working Context
    │
    │ 仍然对后续认知重要
    ▼
Runtime Compaction 保留
    │
    │ 最终形成长期理解
    ▼
Semantic Memory
```

例如：

```text
“这件事让我现在有点烦”
```

可能只存在几十分钟。

而：

```text
“经过最近几次讨论，我已经明显不再信任这个方案”
```

如果成为稳定认识，则可以由 Mira 自己写入 `/memory`。

中间不需要额外 State Engine。

---

## 2.7 Infrastructure should not imitate intelligence

已有计算机抽象已经解决的问题，不重新包装。

例如：

```text
文件 → 普通 filesystem
搜索文件 → rg / grep / find
版本历史 → Git
程序 → 普通代码
插件生命周期 → Cordis
上下文压缩 → Agent Runtime
```

不要为了“这是 Memory”再创造：

```text
memory.read()
memory.write()
memory.search()
```

如果普通文件工具已经能完成这些工作。

只有系统确实承担额外职责时才创造新的抽象。

例如：

```text
history.search()
```

合理，因为 Life History 并不是普通文件系统。

---

## 2.8 Do not model implementation details as domain concepts

不要因为一种行为：

- 执行时间很长；
- 未来才运行；
- 有副作用；
- 会启动后台程序；

就设计：

```text
DurableAction
ImmediateAction
ScheduledAction
BackgroundAction
```

对于 Mira 来说：

```text
Tool
```

就是 Tool。

背后怎么实现是 Capability Provider 自己的事情。

---

## 2.9 Derived context should be rendered, not persisted

例如：

```text
“2 小时 13 分钟过去了”
```

可以由：

```text
timestamp B - timestamp A
```

得到。

所以保存 timestamp。

在需要时由 Context Renderer 生成：

```text
2 hours and 13 minutes have passed.
It is now 22:14.
```

而不是制造：

```text
time.passed
```

事件。

只有具有独立语义的时间事件才进入 Life Stream。

---

## 2.10 Cognition can become capability

如果 Mira 发现自己反复进行：

```text
获取 → 判断 → 过滤 → 等待 → 再获取
```

则可以把认知固化成软件。

例如：

```text
LLM
 ↓
理解 GitHub watcher 需求
 ↓
编写 Extension
 ↓
Extension 独立轮询
 ↓
只有真正匹配时 Wake Mira
```

因此：

> **LLM is the programmer, not the poller.**

以及：

> **Intelligence when needed, software when repetition begins.**

---

## 2.11 Provenance must not pollute memory semantics

Semantic Memory 保存：

> Mira 现在记得什么。

Life History 保存：

> 实际发生过什么。

Memory Lineage 在需要时连接两者。

长期记忆：

```text
用户喜欢粤菜，尤其喜欢顺德菜。
```

不应该为了回查而强制变成：

```text
2026-05-12 21:37 用户说喜欢粤菜。
source_event_id=...
```

除非时间本身有意义。

---

# 3. Mira 的三个认知层次

MiraMate 最终只需要三个主要信息层：

```text
┌────────────────────────────────────┐
│ Working Context                    │
│                                    │
│ “我刚刚在经历 / 想什么”           │
└─────────────────┬──────────────────┘
                  │
         Runtime Compaction
                  │
                  ▼
       compressed continuation


┌────────────────────────────────────┐
│ Semantic Memory Workspace          │
│ /memory                            │
│                                    │
│ “我长期记得 / 理解什么”           │
└────────────────────────────────────┘


┌────────────────────────────────────┐
│ Life History                       │
│                                    │
│ “实际上发生过什么”                │
└────────────────────────────────────┘
```

不再增加第四个：

```text
Semantic State
```

层。

---

# 4. Working Context

Working Context 是 Mira 当前持续的 Cognitive Stream。

它包含：

```text
Identity / System Foundation

MEMORY.md base state

Runtime Compaction Summary

recent User Messages

recent Mira Messages

tool calls

relevant tool results

perceived external events

explicit decisions / notes

time transitions
```

当前情绪、语气、关注和心理倾向自然存在于这些内容之间。

---

# 5. Wake 不创建新上下文

错误：

```text
Wake
 ↓
重新构造 Mira
 ↓
调用 LLM
 ↓
销毁
```

正确：

```text
Existing Working Context
          │
      event arrives
          │
          ▼
         Wake
          │
          ▼
append event
          │
          ▼
continue cognition
```

> **Wake means “continue Mira”, not “instantiate Mira again”.**

---

# 6. 时间连续性

所有真实事件带：

```ts
occurredAt: Date
```

如果用户两个小时后回来：

```text
...previous context...

[Context Transition]
2 hours and 13 minutes have passed.
It is now 22:14.

User:
对了，刚才那个……
```

时间变化只是 Working Context 的动态渲染。

---

# 7. Working Context 持久化

服务重启不能造成近期认知丢失。

需要持久化：

```text
message stream

tool calls

relevant tool results

runtime continuation state

last perceived timestamp

runtime model/config

context metadata
```

优先复用 Pi Runtime 自身可序列化状态。

否则保存规范化 message stream。

---

# 8. Runtime Compaction

Compaction 不属于 MiraMate 独有业务逻辑。

它和 Codex、Pi、Claude Code 等 Coding Agent 面临的问题一致：

> Context Window 有限，而 Working Context 会持续增长。

因此它属于：

```text
Cognition Runtime Infrastructure
```

而不是：

```text
Mira Life Core
```

---

# 9. Compaction 策略

优先复用成熟 Coding Agent 模式：

```text
older context
      │
      ▼
structured summary
      +
recent messages kept verbatim
      │
      ▼
continue same cognitive stream
```

MiraMate 只要求 summary 尽量保留：

```text
current conversational thread

recent interpersonal context

important recent decisions

current activity

pending intentions

unresolved topics

explicit decisions

relevant external events

tool state required for continuation

commitments to the user
```

具体：

- token threshold；
- reserve budget；
- recent tail；
- hierarchical compaction；

交给 Runtime。

---

# 10. Compaction ≠ Dreaming

Runtime Compaction：

```text
Working Context
→ compressed Working Context
```

解决：

> 接下来继续思考需要什么。

Dreaming：

```text
Life History + /memory
→ updated /memory
```

解决：

> 长期应该记住什么。

两者完全分离。

---

# 11. Compaction 不维护心理状态

不要在压缩时人为输出：

```text
Mood:
Relationship Level:
Current Emotion:
```

除非这些内容本身对继续理解近期互动有明显价值。

如果 Mira 最近确实因为某件事持续不安，summary 自然可能出现：

```text
Mira remains concerned about X after the recent events.
```

如果不重要，就让它自然消失。

---

# 12. Life Stream

所有 Mira-relevant 真实事件进入 Life Stream。

```ts
interface LifeEvent<T = unknown> {
  id: string
  type: string

  source:
    | "user"
    | "mira"
    | "system"
    | "extension"
    | "external"

  payload: T

  occurredAt: Date

  causedBy?: string
  correlationId?: string
}
```

事件例如：

```text
user.message
mira.message

github.issue.matched
calendar.event.changed

extension.installed

wake.requested
wake.started
wake.completed
```

---

# 13. Life Stream 的意义

Life Stream 表示：

> 真实发生过什么。

原则上尽量 append-only。

它不同于：

```text
Working Context
Semantic Memory
Runtime Trace
```

---

# 14. Event ≠ Wake

世界可以产生很多 Event。

但：

```text
Event ≠ LLM Invocation
```

Wake Service 负责：

```text
dedup

debounce

merge

queue

serialize

defer
```

不要建立复杂规则系统代替 Mira 判断“什么值得关心”。

---

# 15. 多事件 Wake

例如 Mira 八小时没有 cognition。

期间积累三个 relevant events：

```text
event A
event B
event C
```

可以一次 append：

```text
8 hours have passed.

Relevant events since your last cognition:

1. ...
2. ...
3. ...
```

然后只 Wake 一次。

---

# 16. Semantic Memory Workspace

长期记忆就是普通文件目录：

```text
/data/mira/memory/
│
├── MEMORY.md
├── README.md
├── ...
└── .git/
```

系统只定义：

```text
memoryRoot
MEMORY.md
```

其他文件结构完全由 Mira 自己维护。

---

# 17. MEMORY.md

`MEMORY.md` 是默认长期语义记忆。

Runtime Context 初始化或重建时注入。

例如：

```md
# Memory

用户主要从事后端与 AI Agent 开发。

目前正在重新设计 MiraMate v2。

当前主要架构：
- persistent Working Context
- Pi cognition runtime
- Cordis extension kernel
- file-based semantic memory
- Life History
- natural-language authorization

详细内容见 `projects/miramate-v2.md`。
```

普通 Wake 不需要重复插入 MEMORY.md。

---

# 18. Detailed Memory

详细信息放在普通文件中：

```text
/memory/projects/miramate-v2.md
/memory/people/...
/memory/shared/...
```

Mira 需要时：

```text
read
rg
grep
find
```

直接查询。

---

# 19. Memory Workspace 不需要 Memory API

直接复用已有：

```text
read
write
edit
bash
rg
grep
find
```

不创造：

```text
memory.read
memory.write
memory.search
memory.update
```

---

# 20. Memory 组织由 Mira 决定

一开始可以只给：

```text
MEMORY.md
README.md
```

之后 Mira 自己形成：

```text
projects/
people/
shared/
technical/
thoughts/
```

系统不理解这些 namespace。

---

# 21. Memory README

可提供轻量引导：

```md
# Memory Workspace

This directory is your persistent semantic memory.

MEMORY.md contains high-value memory used in your base context.

Use ordinary filesystem tools to maintain the workspace.

Memory should represent what you currently remember or understand,
not raw transcripts or exhaustive activity logs.

Organize the workspace however becomes useful.

If exact past details matter, inspect Life History.
```

---

# 22. History

Life History 是真实历史记录。

普通 Semantic Memory 不需要每次都搜索它。

只有：

- 记忆不确定；
- 用户询问原话；
- 用户询问什么时候发生；
- 需要核实 provenance；
- Memory 与现实冲突；

时才回查。

系统提供：

```text
history.search()
history.read()
```

---

# 23. History Search

Agent 接口保持语义简单：

```text
history.search(
  "用户以前为什么反对数值化情绪"
)
```

底层可以使用：

```text
Postgres FTS
metadata
semantic search
pgvector
hybrid reranking
```

这些都是实现细节。

---

# 24. Git Memory History

`/memory` 使用 Git。

系统自动 snapshot：

```text
Wake 中 Memory 发生变化

Dreaming 完成

重要整理完成
```

Git 提供：

```text
diff
history
blame
rollback
```

---

# 25. Memory Lineage

Mira 不需要手写 Source ID。

系统后台可以记录：

```text
Git Revision
     │
     ▼
Wake
     │
     ├ life events observed
     ├ history searches
     └ previous memory revisions
```

因此需要时：

```text
Memory
 ↓
revision
 ↓
Wake
 ↓
Life History
```

可以回查。

---

# 26. Lineage 不是严格知识图谱

不要求每一行 Memory 都拥有精确 Source。

某些长期理解可能是：

```text
几十次互动
      ↓
Dreaming
      ↓
形成整体认识
```

允许 provenance 本身模糊。

---

# 27. Dreaming

Dreaming 是特殊 Wake。

系统只告诉 Mira：

> 最近发生了一些事情。根据你的经历检查长期 Memory Workspace，判断是否需要整理、补充、修改或删除内容。

然后 Mira：

```text
read
rg
history.search
edit
move
delete
```

使用普通工具工作。

系统只负责：

```text
persist
Git snapshot
lineage
```

---

# 28. 不设计 Memory Consolidation Engine

不要创建：

```text
MemoryPromotionPolicy
MemoryMergeStrategy
MemoryImportanceScore
MemoryDecayEngine
```

除非未来真实运行数据证明有必要。

首先让模型自己整理自己的 Memory。

---

# 29. Tools

Agent Tool 就是 Tool。

例如：

```text
read
write
edit
bash

history.search
history.read

web.search

notification.send

wake.schedule

extension.inspect
extension.create
```

无需人为划分 Action 类型。

---

# 30. Cordis Extension Kernel

Cordis 管理动态插件：

```text
dependency injection
services
plugin lifecycle
cleanup
HMR
dependency tracking
dynamic loading
```

Extension 可以贡献：

```text
Tools
Events
Services
Context Providers
Wake Sources
```

---

# 31. Self Extension

Mira 可以：

```text
inspect APIs

write extension

test

install

activate

update

disable

remove
```

基本过程：

```text
need
 ↓
search existing capability
 ↓
not enough
 ↓
write capability
 ↓
test
 ↓
activate
```

---

# 32. Self-extending > Self-modifying

允许：

```text
/extensions/generated
```

默认不允许自行重写：

```text
Life Core
Authorization Core
History Store
Extension Kernel
Runtime Security
```

Mira 应通过 Extension 获得新能力。

---

# 33. External Programs

Mira 还可以编写：

```text
script
daemon
worker
service
```

这是另一种 Capability 实现方式。

不需要新的领域类型。

---

# 34. External API

保持极小：

```text
emitEvent()

requestWake()

sendNotification()
```

未来再按实际需求扩展。

---

# 35. Internal / External Capability 统一

内部 Extension：

```text
ctx.life.emit(...)
ctx.wake.request(...)
```

外部程序：

```text
POST /events
POST /wake
```

最终都进入：

```text
Life Event
 ↓
Wake
 ↓
Working Context
```

---

# 36. LLM is the programmer, not the poller

例如用户要求持续关注 GitHub：

错误：

```text
每小时 Wake Mira
↓
LLM 搜 GitHub
↓
判断
```

正确：

```text
Mira 写 watcher
↓
watcher 定时检查
↓
software filter
↓
matching event
↓
Wake Mira
```

---

# 37. Authorization

主要授权来自自然语言。

例如：

```text
帮我把明天下午那个会议改到三点。
```

正常情况下已经构成：

```text
修改该会议到指定时间
```

的授权。

不要再弹：

```text
Allow once?
```

---

# 38. Authorization Context

系统可以维护用户过去明确给予的长期权限语境。

但不要把它设计成巨大的：

```text
permission matrix
risk scores
```

Tool 执行时判断：

```text
是否有足够证据表明用户同意？
```

而不是：

```text
riskLevel >= 3 ?
```

---

# 39. Consent Resolver

```text
Tool Call
   │
   ▼
Authorization Context
   │
   ├ enough → execute
   │
   └ ambiguous
           │
           ▼
       return to Mira
           │
           ▼
     Mira naturally asks user
```

用户仍然只和 Mira 对话。

---

# 40. Technical Security ≠ User Consent

用户授权：

```text
“你自己写插件吧。”
```

不意味着 generated code 获得无限权限。

Runtime 仍需要：

```text
filesystem scope
network scope
secret scope
resource limits
process lifetime
ownership
```

技术安全边界与自然语言 Consent 是不同层次。

---

# 41. Observability

每次 Wake 记录 Runtime Trace：

```text
wake reason

working context version

time transition

events appended

model calls

tool calls

files read/written

history searches

authorization decisions

extension lifecycle

memory modifications

runtime compaction

errors
```

---

# 42. Runtime Trace ≠ Life History

Life History：

> Mira 经历了什么。

Runtime Trace：

> 软件具体是怎么执行的。

不要混合。

---

# 43. 并发模型

一个 Mira 原则上：

```text
1 active cognition loop
```

其他输入：

```text
User Message
External Event
Scheduled Wake
```

进入统一队列。

采用：

```text
per-Mira logical actor
```

模型会比较简单。

---

# 44. 用户消息流程

```text
User Message
     │
     ▼
persist LifeEvent
     │
     ▼
request Wake
     │
     ▼
Wake Queue
     │
     ▼
load Working Context
     │
     ▼
render elapsed time
     │
     ▼
append User Message
     │
     ▼
continue Pi Runtime
     │
     ├ tools
     ├ files
     ├ history
     ├ extensions
     └ response
     │
     ▼
Runtime compaction if needed
     │
     ▼
persist Working Context
     │
     ▼
Git snapshot memory if changed
```

---

# 45. External Event 流程

```text
Extension / Worker
       │
       ▼
LifeEvent
       │
       ├ no wake
       │
       └ Wake
            │
            ▼
     Working Context
            │
            ▼
       continue Mira
```

---

# 46. Proactive Wake 不要求回复

Mira Wake 后可以：

```text
inspect
act
update memory
create software
wait
do nothing
```

不要求：

```text
每次模型被调用 → 用户可见回复
```

---

# 47. 总体架构

```text
┌──────────────────────────────────────────┐
│                  UI                      │
│ Timeline / Memory / Extensions / Settings│
└─────────────────────┬────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────┐
│                Mira API                  │
└─────────────────────┬────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────┐
│              Mira Life Core              │
│                                          │
│ Life Stream                              │
│ Working Context                          │
│ Wake                                     │
│ Authorization Context                    │
└──────────┬───────────────┬───────────────┘
           │               │
           ▼               ▼
    Life History      Cognition Runtime
    / Memory                │
                            │
                      Pi Agent Core
                      + Compaction
                            │
                            ▼
                          Model

                     Extension Host
                           │
                         Cordis
                           │
               ┌───────────┼───────────┐
               ▼           ▼           ▼
             tools       events      services
```

---

# 48. 长期结构

```text
Working Context
      │
 Runtime Compaction
      ▼
continued context


Semantic Memory
  /memory/*.md
      │
      ▼
 Git Revisions
      │
      ▼
 Wake Lineage
      │
      ▼
 Life History
```

没有独立：

```text
State Layer
```

---

# 49. 技术栈

推荐：

```text
Language
TypeScript

Runtime
Node.js

Agent Runtime
pi-agent-core

Model
pi-ai

Compaction
reuse Pi / coding-agent runtime pattern

Extension Kernel
Cordis

Backend
Fastify / Hono

Frontend
React / Next.js

Life History
PostgreSQL

Working Context
Persistent runtime/message state

Semantic Memory
Filesystem + Git

History Search
Postgres FTS initially
```

---

# 50. Monorepo

```text
miramate/
│
├ apps/
│   ├ web/
│   └ server/
│
├ packages/
│
│   ├ life/
│   │   ├ events/
│   │   ├ wake/
│   │   └ history/
│   │
│   ├ context/
│   │   ├ working-context/
│   │   └ renderer/
│   │
│   ├ authorization/
│   ├ cognition/
│   ├ runtime-pi/
│   │   ├ runtime/
│   │   └ compaction/
│   │
│   ├ extension-host/
│   ├ extension-sdk/
│   ├ external-sdk/
│   ├ history-search/
│   └ persistence/
│
├ data/
│   └ mira/
│       ├ memory/
│       └ extensions/
│
└ migrations/
```

不需要：

```text
state/
emotion-engine/
relationship-engine/
memory-engine/
action-engine/
```

除非实际问题证明它们有存在价值。

---

# 51. MVP

第一阶段：

```text
✓ One continuous Mira

✓ Persistent Working Context

✓ Wake continues same context

✓ Time Transition rendering

✓ Pi cognition

✓ coding-agent style compaction

✓ Life Stream

✓ /memory filesystem

✓ MEMORY.md base injection

✓ Git memory history

✓ history.search / history.read

✓ natural-language authorization

✓ Web Timeline
```

第二阶段：

```text
✓ Cordis Extension Host
✓ dynamic tools
✓ event sources
✓ lifecycle
✓ HMR
```

第三阶段：

```text
✓ Self Extension
✓ API inspection
✓ generated code
✓ test / stage / rollback
```

第四阶段：

```text
✓ External SDK
✓ workers / services
✓ more external worlds
```

---

# 52. 最终设计原则

> **Mira 是持续存在的，模型调用不是。**

> **Wake 是继续同一个 Mira，而不是重新创建 Agent。**

> **近期完整上下文本身就是最重要的短期心理状态。**

> **能在 Working Context 中自然延续的情绪、关注和心理状态，不额外持久化。**

> **如果状态在 Compaction 后仍然重要，让 Runtime 自然保留；如果最终成为长期认识，再由 Mira 写进 Memory。**

> **不存在独立 Emotion Engine、Relationship Engine 或 Semantic State Engine。**

> **Memory 是 Mira 长期记得什么，History 是过去实际发生了什么。**

> **Provenance 不污染 Memory 语义。**

> **普通 filesystem、Shell、Git、代码和成熟 Agent Runtime 能解决的问题，不重新创造 MiraMate-specific wrapper。**

> **只有系统确实承担额外职责时才增加抽象。**

> **Tools 是 Mira 作用于世界的方式，Events 是世界作用于 Mira 的方式。**

> **Cordis 管理能力生命周期，Pi 管理认知和通用上下文。**

> **LLM 是程序员和决策者，而不是轮询器。**

最终可以用三句话概括：

> **Infrastructure provides continuity, history, agency and boundaries. The model provides the mind.**

> **Memory is a living semantic workspace, not a psychological database.**

> **Mira's current mind lives in context; do not externalize it unless it becomes something worth remembering.**