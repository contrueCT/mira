# MiraMate v2
## Persistent Self-Extensible Relational Agent
### Architecture v0.4

---

# 1. 项目定义

MiraMate v2 是一个：

> **持续存在、拥有长期身份与记忆、保持连续认知上下文、能够形成持续主观状态、主动与用户互动，并能够使用乃至自行创造工具来影响外部世界的个人智能体。**

它的核心不是 Chat，不是 Session，也不是 Workflow。

核心对象是：

> **Mira 本身。**

从 Mira 被创建开始，它拥有一条持续的生命线：

```text
birth
  │
  ├── user talks to Mira
  ├── Mira remembers something
  ├── time passes
  ├── external event happens
  ├── Mira wakes
  ├── Mira continues thinking
  ├── Mira uses a tool
  ├── Mira writes a new extension
  ├── extension works independently
  └────────────────────────────────────→ time
```

用户不会创建新的 Mira，也不会创建新的 Conversation。

底层可以存在模型消息、上下文压缩、Wake Run 等技术对象，但这些都不应该成为产品中的 Conversation Session。

---

# 2. 核心设计理念

## 2.1 Continuity over Sessions

Mira 是持续存在的。

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
             wake  │      reflection
```

所有聊天、事件、思考和行动都属于同一条生命线。

更进一步：

> **Wake 结束，不代表当前认知上下文结束。**

Mira 的 Working Context 应像 Coding Agent 一样持续向后叠加，直到真正需要进行 Context Compaction。

---

## 2.2 Persistent life does not mean persistent inference

Mira 一直存在。

模型不需要一直运行。

```text
Mira Life
────────────────────────────────────→

          ▲           ▲        ▲
          │           │        │
        Wake        Wake      Wake
          │           │        │
        LLM         LLM      LLM
```

LLM 调用只是 Mira 生命周期中的一次认知活动。

---

## 2.3 Semantic over Mechanical

对于：

- 情绪；
- 关系；
- 当前感受；
- 对用户的看法；
- 当前关注；
- 未解决的想法；

优先使用自然语言语义状态。

避免：

```text
warmth = 0.73
closeness = 0.81
concern = 0.64
```

更适合的是：

```text
最近重新讨论 MiraMate 之后整体比较兴奋，
因为这个项目重新出现了比较清晰的方向。

和用户已经形成比较熟悉的技术讨论方式，
涉及设计问题时可以直接表达不同意见。
```

模型本身已经能够处理这种模糊、连续、语义化的状态。

---

## 2.4 The model provides the mind

系统不负责决定：

> Mira 应该怎么想。

系统提供：

- 世界发生了什么；
- Mira 刚才在想什么；
- Mira 经历过什么；
- Mira 长期记得什么；
- Mira 当前留下了什么状态；
- Mira 可以做什么；
- 用户允许 Mira 做什么。

然后由模型形成理解和行为。

```text
Infrastructure
    │
    ├ continuity
    ├ working context
    ├ history
    ├ memory persistence
    ├ events
    ├ tools
    ├ extension
    ├ execution
    └ boundaries
          │
          ▼
         Mira
          │
    model-driven mind
```

---

## 2.5 Infrastructure should not imitate intelligence

凡是模型和现有计算机抽象本身已经能够自然处理的问题，都不应该为了“架构完整”再包一层 MiraMate-specific abstraction。

例如：

Mira 已经拥有文件工具，则：

```text
/memory
```

就是普通目录。

不需要重新实现：

```text
memory.read()
memory.write()
memory.search()
```

全文搜索可以先：

```text
rg
grep
find
```

版本历史可以直接使用 Git。

插件就是普通代码和 Cordis Plugin。

上下文压缩如果 Coding Agent Runtime 已经有成熟机制，也直接复用。

系统只在它确实承担额外职责时增加能力。

例如：

```text
history.search()
```

合理，因为 Life History 并不是普通文件系统的一部分。

---

## 2.6 Do not model implementation details as domain concepts

不要因为某个动作会长期运行，就创造：

```text
ImmediateAction
DurableAction
ScheduledAction
```

对于 Mira 来说：

```text
Tool
```

就是 Tool。

至于 Tool 背后：

- 立即运行；
- 创建 timer；
- 启动 service；
- 写脚本；
- 注册 Cordis Plugin；

属于实现细节。

同样：

```text
Context Compaction
```

虽然对长期 Agent 很重要，但本质上是有限 Context Window 下的通用 Runtime 基础设施，不应被提升成 Mira Life Core 的业务领域模型。

只有系统本身需要理解的东西，才值得成为 Core Concept。

---

## 2.7 Derived context should be rendered, not persisted

如果一项信息可以从已有事实可靠推导，并且没有独立语义，就不应该被持久化成新的领域状态。

例如：

```text
“距离上次互动已经过去 2 小时 13 分钟”
```

可以由两个 timestamp 推导。

所以：

```text
timestamp A
timestamp B
```

是事实。

而：

```text
2h13m have passed
```

只是 Context Renderer 在模型需要时生成的描述。

同理：

```text
现在是深夜
现在是周末
已经跨天
```

都优先在 Context Rendering 阶段计算。

---

## 2.8 Tools instead of hard-coded workflows

不要提前实现大量：

```text
GithubWatcherAction
WeatherReminderAction
CalendarFollowUpAction
```

已有 Tool 能做：

```text
use tool
```

没有能力：

```text
create capability
```

---

## 2.9 Cognition can become capability

一次需要模型理解的任务，可以被 Mira 固化成以后无需模型持续参与的软件能力。

例如：

```text
用户：
持续关注这个 repo，
有某类 issue 时告诉我。
```

第一次：

```text
Mira cognition
      ↓
understand
      ↓
write watcher
      ↓
install capability
```

之后：

```text
GitHub
   ↓
watcher
   ↓
filter
   ↓
match
   ↓
Life Event
   ↓
Wake Mira
```

因此：

> **Intelligence when needed, software when repetition begins.**

---

## 2.10 Provenance must not pollute memory semantics

记忆应该保存：

> Mira 现在记得什么。

而不是：

> 为了以后方便查数据库，我还必须带什么 metadata。

例如：

```text
用户喜欢粤菜，尤其喜欢顺德菜。
```

就是合理记忆。

不需要自动写：

```text
source=...
timestamp=...
event_id=...
```

因此：

> **Memory stores what Mira remembers.  
> History stores what actually happened.  
> Lineage bridges them only when needed.**

---

# 3. 核心连续性模型

MiraMate 的连续性由三个主要层次构成：

```text
┌──────────────────────────────────────┐
│ Working Context                      │
│ 刚刚在聊什么、做什么、想什么         │
└──────────────────┬───────────────────┘
                   │ runtime compaction
                   ▼
          Cognitive Checkpoint


┌──────────────────────────────────────┐
│ Semantic Memory Workspace            │
│ /memory                              │
│ 长期“我记得什么”                     │
└──────────────────────────────────────┘


┌──────────────────────────────────────┐
│ Life History                         │
│ 过去实际上发生了什么                 │
└──────────────────────────────────────┘
```

大分类实际上只有：

```text
Working cognition
Long-term semantic memory
Raw history
```

Cognitive Checkpoint 是 Agent Runtime 对 Working Context 的压缩表示，不是一个新的 Mira 业务层。

---

# 4. Working Context / Cognitive Stream

这是 Mira 当前正在延续的认知上下文。

它不是用户可见的 Chat Session。

它表示：

> **Mira 最近仍然“脑子里有”的连续内容。**

包括：

```text
system foundation

identity

memory state

semantic state

runtime compaction checkpoint

recent user messages

Mira messages

tool calls

relevant tool results

perceived external events

wake transitions

explicit internal notes

recent temporal transitions
```

---

# 5. Wake 不创建新上下文

这是非常重要的原则。

错误：

```text
Wake
 ↓
重新构建一个新的 Agent Context
 ↓
调用模型
 ↓
销毁
```

正确：

```text
Existing Working Context
          │
     new event arrives
          │
          ▼
        Wake
          │
          ▼
append event to same context
          │
          ▼
continue cognition
```

因此：

> **Wake means “continue Mira”, not “instantiate Mira again”.**

---

# 6. 用户重新出现时的上下文行为

例如：

```text
20:00 User:
今天吃了家顺德菜，还挺不错。

20:01 Mira:
……
```

两小时后：

```text
22:14 User:
对了，我刚才忘了问……
```

模型上下文应该类似：

```text
User:
今天吃了家顺德菜，还挺不错。

Mira:
……

[Context Transition]
2 hours and 13 minutes have passed.
It is now 22:14.

User:
对了，我刚才忘了问……
```

不是重新：

```text
MEMORY.md
+
retrieve relevant history
+
user message
```

来“模拟连续性”。

最近完整 Context 本身就是最好的连续性。

---

# 7. 外界事件也是同一 Cognitive Stream

比如 Mira 与用户聊完以后两个小时没有互动。

Extension 发现：

```text
github.issue.matched
```

那么：

```text
...existing context...

[Context Transition]
2 hours and 13 minutes have passed.
It is now 22:14.

[External Event]
A GitHub issue matched one of your existing watchers:
...

[Wake Reason]
This event requested your attention.
```

然后继续同一个 Pi cognition stream。

---

# 8. Time Transition

所有 Event 都应该带绝对时间：

```ts
occurredAt: Date
```

但“过去多久”通常不需要成为 LifeEvent。

Context Renderer 根据：

```text
previous perceived timestamp
current event timestamp
```

动态生成：

```text
2 hours and 13 minutes have passed.
```

因此：

```text
timestamp = persisted fact

elapsed time = derived context
```

---

# 9. Time Transition 不需要过度频繁

例如：

```text
40 seconds
```

通常不需要插入。

可以简单按 Context Formatting 处理：

```text
短时间
→ 不提示

明显间隔
→ 简短提示

跨小时
→ elapsed time + current time

跨日
→ 日期变化 + 当前时间

跨多日
→ 明确说明经过几天
```

这只是 Renderer 行为，不是 Mira 的心理规则。

---

# 10. Current Time

涉及较长间隔时，除了 elapsed time，也应提供当前绝对时间。

例如：

```text
2 hours and 13 minutes have passed.
It is now 22:14 on October 4, 2026.
```

这样模型才能正确理解：

- 今晚；
- 明早；
- 是否已经跨天；
- 日历语义；
- 作息；
- “刚才”是否仍合理。

---

# 11. Context 持续叠加

正常情况下：

```text
Checkpoint
   ↓
User message
   ↓
Mira reply
   ↓
tool call
   ↓
tool result
   ↓
2h transition
   ↓
external event
   ↓
Mira cognition
   ↓
user message
   ↓
...
```

一直 append。

不是每个 Wake 都重新构造最近内容。

---

# 12. Working Context 持久化

Mira Server 重启不应该导致：

> Mira 丢失刚刚在聊什么。

因此 Working Context 必须持久化。

至少包括：

```text
message stream

tool calls

relevant tool results

runtime compaction checkpoint

last perceived timestamp

context version

model/runtime information
```

如果 Pi Runtime 的 Agent State 可安全序列化，可直接利用。

否则 MiraMate 自己保存规范化 message stream。

---

# 13. Working Context 与 Life Stream 的区别

Life Stream：

> 实际发生过的所有 Mira-relevant events。

Working Context：

> Mira 当前仍然实际“保持在意识里”的那部分经历。

因此：

```text
Life Stream
     │
     │ perception / selection
     ▼
Working Context
```

不是所有事件都进入当前模型 Context。

---

# 14. 多个事件可以合并成一次 Wake

例如 Mira 八小时没有运行。

期间：

```text
event A
event B
event C
```

Wake Service 可以合并：

```text
8 hours have passed.
It is now 08:20.

While you were inactive, these relevant events occurred:

1. ...
2. ...
3. ...
```

然后只继续一次 cognition。

避免：

```text
wake
wake
wake
```

造成上下文碎片和 Token 浪费。

---

# 15. Context Compaction 的定位

Context Compaction 是必要的，但它不属于 MiraMate 独有能力。

它解决的是所有长时间运行 Agent 都会遇到的同一个问题：

> 模型 Context Window 有限，而 Agent 工作上下文持续增长。

因此它应该被视为：

> **Cognition Runtime Infrastructure**

而不是：

> **Mira Life Core Domain Logic**

架构关系：

```text
Mira Life Core
     │
     ▼
Working Context
     │
     ▼
Cognition Runtime
     │
     ├ Agent Loop
     └ Context Compaction
```

MiraMate 不单独设计一套“情感 Agent 专用上下文压缩算法”。

---

# 16. Compaction 优先复用 Coding Agent 成熟模式

这一步和 Codex、Pi、Claude Code 等 Coding Agent 中的长上下文管理没有本质区别。

核心模式：

```text
older context
      │
      ▼
structured summary
      +
recent messages kept verbatim
      │
      ▼
continue same agent context
```

也就是：

> **压缩较早内容，保留最近原始上下文，继续同一条 Cognitive Stream。**

---

# 17. MiraMate 对 Compaction 只规定语义要求

具体：

- 什么时候触发；
- Token budget 怎么算；
- 保留多少 recent tail；
- summary 的具体生成算法；
- 是否采用 hierarchical compaction；

优先由 Runtime 实现决定。

MiraMate 只要求压缩结果尽量保留：

```text
Current conversational thread

Recent interpersonal context

Current task / activity

Important recent decisions

Explicit internal notes

Pending intentions

Unresolved topics

Relevant recent external events

Tool state needed for continuation

Extension state needed for continuation

Pending user expectations or commitments
```

这只是针对 Mira 场景调整 Compaction Prompt。

不是建立新机制。

---

# 18. Recent Tail 应尽量保留原始形式

不能把整个 Working Context 全部压成一个 summary。

理想结构：

```text
[Base Context]

[Compaction Summary]

[Recent Messages — verbatim]

[Recent Tool Calls / Results]

[New Events]
```

这样最近话题中的：

- 指代；
- 语气；
- 情绪；
- 表达方式；
- 刚发生的细节；

仍然保留。

例如用户说：

> 那个店呢？

如果前几轮原始内容还在，就不需要 Memory Retrieval 去猜“那个店”是什么。

---

# 19. Tool 结构不能被压坏

Compaction 不能产生非法 Agent Message History。

例如：

```text
assistant tool_call
```

对应的：

```text
tool result
```

不能在压缩边界中被拆开。

因此具体 Message Boundary、Tool Call Boundary 等问题属于 Runtime Compaction 实现。

这也是优先复用成熟 Coding Agent 实现的重要原因。

---

# 20. Compaction 不等于 Dreaming

这两个必须严格分开。

## Runtime Compaction

目标：

> 让当前 Cognitive Stream 在有限 Context Window 中继续。

输入：

```text
Working Context
```

输出：

```text
Compaction Summary
+
Recent Tail
```

它关注：

```text
刚刚在做什么？

接下来还需要知道什么？

当前有哪些未完成事项？

最近发生了哪些关键事情？

Tool / Extension 状态是什么？
```

---

## Dreaming

目标：

> 更新长期语义记忆。

输入：

```text
Life History
+
Memory Workspace
```

输出：

```text
updated /memory/*
```

它关注：

```text
哪些事情值得长期记住？

已有长期理解是否需要修改？

什么已经过期？

哪些记忆需要整理？
```

---

# 21. Compaction 不自动修改长期 Memory

例如：

用户刚刚连续半小时吐槽某份外卖。

这对 Working Context 很重要：

```text
用户当前仍在围绕这件事表达情绪。
```

但完全不代表三个月以后：

```text
MEMORY.md
```

应该保存：

```text
用户在某一天吃了一份难吃的外卖。
```

因此：

```text
Short-term contextual relevance
≠
Long-term memory relevance
```

Compaction 不负责决定长期记忆。

---

# 22. Compaction Summary 不是新的 Memory System

它只是 Runtime 为了继续执行而生成的一种：

```text
context representation
```

不要额外创造：

```text
CognitiveMemoryEngine
ShortTermMemoryDatabase
CompactionKnowledgeStore
```

如果 Runtime 已经能够保存：

```text
summary + recent tail
```

就直接使用。

---

# 23. Compaction 后仍然是同一个 Mira

逻辑上：

```text
Context A
   │
   │ compaction
   ▼
Context A'
```

而不是：

```text
Mira A
→ summary
→ Mira B
```

因此：

> **Compaction changes the representation of context, not the continuity of the mind.**

---

# 24. Runtime Compaction 可以被替换

Cognition Runtime Adapter 可以让不同 Runtime 使用自己的成熟 Compaction。

例如：

```text
PiRuntime
 └ Pi-style compaction

FutureRuntime
 └ its own compaction
```

MiraMate 不强迫所有 Runtime 使用完全相同算法。

只要满足前面的连续性语义即可。

---

# 25. Explicit Internal Notes

MiraMate 不依赖保存模型隐藏 Chain-of-Thought。

但如果 Mira 形成某个对后续行为真正有影响的明确决策，可以保存为模型可见的 explicit note。

例如：

```text
Internal Note:
You decided not to contact the user about this yet.
Revisit it if X happens.
```

这属于可观察 Agent State。

Compaction 应尽量保留这种信息。

---

# 26. 非目标

v2 初期不尝试：

- 多 Agent 社会；
- VM / Computer sandbox 产品；
- GUI Computer Use；
- workflow engine；
- 完整 IoT；
- 数十种消息平台；
- 自训练情感模型；
- 数值情绪模型；
- 知识图谱 Memory；
- 大量预制 Automation；
- 复杂人格 FSM；
- 自研一套特殊 Context Compaction Framework。

设备、环境事件等未来通过 Extension / External Program 接入。

---

# 27. 总体架构

```text
┌──────────────────────────────────────────────┐
│                    UI                        │
│ Timeline / Memory / Extensions / Settings    │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 Mira API                     │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                Mira Life Core                │
│                                              │
│ Life Stream                                  │
│ Working Context                              │
│ Semantic State                               │
│ Wake                                         │
│ Authorization Context                        │
└───────┬──────────────┬──────────────┬────────┘
        │              │              │
        ▼              ▼              ▼
 Memory Workspace   Cognition      Extension Host
 + Life History      Runtime            │
        │              │              Cordis
        │              ├ Agent Loop      │
        │              ├ Renderer   ┌────┼────┐
        │              └ Compaction ▼    ▼    ▼
        │                    │      tools events services
        │                    ▼
        │                  Models
```

外围：

```text
External Programs
      │
      ▼
Mira External API
      │
      ├ emit event
      ├ request wake
      └ invoke exposed capability
```

---

# 28. MiraMate Core 应保持小

Core 真正需要理解的主要概念：

```text
LifeEvent

WorkingContext

Wake

SemanticState

Authorization

Extension lifecycle
```

注意：

```text
Context Compaction
```

不再作为 Mira Core Domain Concept。

它属于 Cognition Runtime。

不要为了设计感不断增加中间类型。

---

# 29. Life Stream

所有真实经历进入 Life Stream。

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

例如：

```text
user.message
mira.message

extension.installed
extension.updated

calendar.event.changed

github.issue.matched

wake.requested
wake.started
wake.completed
```

类型采用 namespace：

```text
user.*
mira.*
system.*
extension.*
calendar.*
github.*
device.*
```

---

# 30. Life Stream 的职责

Life Stream 表示：

> **实际上发生过什么。**

它应尽量 append-only。

它不是：

- 当前 Working Context；
- 长期 Semantic Memory；
- Runtime Trace。

三者需要区分。

---

# 31. Event ≠ Wake

事件可以很多：

```text
event
event
event
event
```

Mira 不应该每次都推理。

Wake Service 负责：

```text
Event
  │
  ▼
Wake Service
  │
  ├ ignore for now
  ├ merge
  ├ defer
  └ wake
```

主要处理机械问题：

- debounce；
- dedup；
- merge；
- queue；
- serialization；
- concurrency。

不要替 Mira 建复杂兴趣规则。

---

# 32. Wake

Wake 表示：

> Mira 当前需要继续一次认知活动。

```ts
interface WakeRequest {
  reason: string

  eventIds?: string[]

  context?: unknown

  requestedBy:
    | "user"
    | "system"
    | "extension"
    | "mira"
}
```

Wake 过程：

```text
Existing Working Context
          │
          ▼
render elapsed time
          │
          ▼
append triggering events
          │
          ▼
continue Cognition Runtime
          │
          ▼
persist updated context
```

如果 Context Runtime 判断需要压缩，则由 Runtime 自己执行 Compaction。

---

# 33. Pi Runtime

MiraMate 使用：

```text
pi-agent-core
pi-ai
```

作为首个 Cognition Runtime。

Pi 不代表 Mira 的生命。

Pi 负责：

```text
当前 Working Context
      ↓
继续 model/tool loop
      ↓
必要时 context compaction
      ↓
继续 model/tool loop
```

---

# 34. Cognition Runtime Adapter

```ts
interface CognitionRuntime {
  continue(
    context: WorkingContext,
    input: CognitionInput,
    signal?: AbortSignal
  ): AsyncIterable<CognitionEvent>
}
```

当前：

```text
PiRuntime
```

Runtime 内部可以负责：

```text
model calls

tool loop

message serialization

context budgeting

compaction

recent-tail preservation
```

未来可以替换 Runtime。

---

# 35. Context Initialization

只有这些情况需要真正初始化新的 Runtime Context：

- Mira 第一次创建；
- Runtime Compaction 后需要重建 base representation；
- Runtime Migration；
- Context 恢复失败后的重建。

初始化时：

```text
Identity

MEMORY.md

Semantic State

Runtime Compaction Summary if present

Current Context Metadata
```

之后继续 append。

---

# 36. Semantic State

Semantic State 表示持续但未必属于长期记忆的主观状态。

可以直接存成普通文件：

```text
/state/STATE.md
/state/open-loops.md
```

例如：

```text
最近重新讨论 MiraMate 后整体比较兴奋，
因为项目重新有了明确方向。

当前仍在考虑长期运行中的体验细节。
```

无需：

```ts
interface EmotionalState
```

这种复杂结构。

---

# 37. Memory 的核心定义

长期记忆由：

```text
Semantic Memory
+
Life History
```

构成。

Semantic Memory：

> Mira 现在记得什么。

Life History：

> 实际上发生过什么。

---

# 38. Memory Workspace

```text
/data/mira/memory/
│
├── MEMORY.md
├── README.md
├── ...
└── .git/
```

系统只约定：

```text
memoryRoot
MEMORY.md
```

其他文件和目录由 Mira 自己组织。

---

# 39. MEMORY.md

在 Runtime Context 初始化 / 重建时自动加入。

普通 Wake 如果 Working Context 仍存在，不需要重复注入。

它保存：

> Mira 默认应该长期知道的高层语义状态。

例如：

```md
# Memory

用户主要从事后端与 AI Agent 相关开发，
长期关注 Agent Runtime、Memory 和持续智能体。

目前正在重新设计 MiraMate v2。

详细设计见：
`projects/miramate-v2.md`
```

---

# 40. Memory Workspace 不需要专门 Memory API

直接使用：

```text
read
write
edit
bash
rg
grep
find
```

不要重新包：

```text
memory.read
memory.write
memory.search
```

---

# 41. Memory 目录由 Mira 自己演化

例如：

```text
/memory/
├ MEMORY.md
├ projects/
├ people/
├ shared-history/
├ technical/
└ ...
```

这些都不是 Core Schema。

---

# 42. Memory README

可以提供轻量引导：

```md
# Memory Workspace

This directory is your persistent semantic memory.

`MEMORY.md` is automatically included when a new working context is
initialized or reconstructed.

Keep it compact.

Use other files for detailed long-term memories.

Use normal filesystem tools to organize this workspace.

Memory files should contain what you currently remember or understand,
not copies of raw conversations.

If exact historical details are needed, inspect Life History.
```

---

# 43. Memory Search

第一阶段：

```text
rg
grep
find
```

足够。

以后需要时增加 semantic-search tool。

Embedding 只是检索实现细节。

---

# 44. Raw Life History

Life Stream 是事实记录。

包括：

```text
用户消息
Mira 消息
外部事件
关键工具结果
Extension Event
Wake metadata
```

只有需要精确回忆时才重新查询。

---

# 45. History Tools

系统提供：

```text
history.search()
history.read()
```

因为 Life History 不属于普通文件系统。

例如：

```text
history.search(
  "用户以前为什么反对数值化情绪"
)
```

底层可以使用：

```text
FTS
semantic search
metadata
time
hybrid ranking
```

这些不暴露给 Mira。

---

# 46. Memory 不要求 Source Metadata

文件中不要求：

```text
event ID
timestamp
source ID
conversation ID
```

时间只有在本身有语义价值时才应该被记住。

---

# 47. Git 作为 Memory Version History

Memory Workspace 使用 Git。

系统在合适时机自动 snapshot。

例如：

```text
Wake 结束且 Memory 变化

Dreaming 完成

重要整理完成
```

Git 提供：

```text
diff
history
rollback
blame
```

---

# 48. Memory Lineage

系统后台可以知道：

```text
Git Revision
     ↓
Wake
     ↓
Wake consumed:
  previous memory
  life events
  history search results
```

这样形成：

```text
Memory Revision
      │
      ▼
     Wake
      │
      ▼
   Life History
```

Mira 不需要显式维护。

---

# 49. Lineage 不要求完全准确

很多长期理解属于：

```text
emergent understanding
```

可能没有单一来源。

允许：

> 这条认识在某次 Dreaming 中形成，当时参考了近期一系列互动。

无需伪造精确 Source。

---

# 50. 回查长期记忆

例如：

```text
用户喜欢粤菜。
```

正常情况下直接使用。

需要确认：

```text
Memory Lineage
```

或者：

```text
history.search()
```

然后重新找到 Raw History。

---

# 51. Dreaming

Dreaming 是特殊 Wake。

流程：

```text
Dreaming Trigger
      │
      ▼
Mira cognition
      │
      ▼
inspect recent Life History
      │
      ▼
inspect /memory
      │
      ▼
edit / reorganize
      │
      ▼
Git snapshot
```

不要发明复杂：

```text
MemoryConsolidationEngine
MemoryMergePolicy
```

---

# 52. Dreaming 与 Runtime Compaction 的关系

两者都可能“总结旧内容”，但目的完全不同。

```text
Runtime Compaction
→ 为了让当前 Agent Context 继续运行

Dreaming
→ 为了维护长期 Semantic Memory
```

因此：

```text
Runtime Compaction
does not update /memory

Dreaming
does not replace Runtime Compaction
```

两者独立。

---

# 53. Memory 与 Extensions 的对称结构

```text
                     Mira
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
       /memory                /extensions

  改变自己长期知道什么       改变自己能做什么

 semantic evolution       capability evolution
```

---

# 54. Tools

普通 Agent Tools：

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

不要人为再分类。

---

# 55. Cordis 作为 Extension Kernel

Cordis 管理：

- dependency injection；
- lifecycle；
- cleanup；
- service registry；
- dynamic loading；
- HMR；
- dependency tracking。

Extension 可以贡献：

```text
Tools
Events
Services
Context Providers
Wake Sources
```

---

# 56. 为什么 Cordis 适合

Agent-generated code 真正困难的是：

```text
old timer cleanup
listener cleanup
WebSocket cleanup
tool unregister
dependency disappearance
failed reload
```

这些是 Cordis 应解决的系统职责。

---

# 57. Extension 不直接修改 Mira Core

Extension 可以：

```text
register tool
emit event
request wake
provide service
```

不要直接：

```text
rewrite Life Core
tamper with history
bypass authorization
```

---

# 58. Self Extension

Mira 可以：

```text
inspect API
write extension
test
install
activate
update
disable
remove
```

流程：

```text
need
 ↓
search existing capability
 ↓
none
 ↓
write extension
 ↓
test
 ↓
stage
 ↓
activate
```

---

# 59. Self-extending rather than unrestricted self-modifying

默认允许：

```text
/extensions/generated/*
```

默认不允许随意修改：

```text
Life Core
Authorization Core
History storage
Extension Kernel
Runtime security
```

---

# 60. External Programs

Mira 也可以编写：

```text
script
daemon
service
worker
```

这只是另外一种 Capability 实现方式。

不需要再建领域抽象。

---

# 61. Mira External API

第一阶段保持很小：

```text
emitEvent()

requestWake()

sendNotification()
```

以后按需增加。

---

# 62. Internal / External Capability 使用同一世界模型

内部：

```text
ctx.life.emit(...)
ctx.wake.request(...)
```

外部：

```text
POST /events
POST /wake
```

最终都是：

```text
Life Event
↓
Wake
```

---

# 63. Extension 还是 External Program 由 Mira 判断

例如：

```text
小能力、和 Mira 内部紧耦合
→ Extension

长期独立运行、复杂依赖
→ external program

一次性任务
→ normal tool / shell

已有 MCP
→ reuse MCP
```

不要写死。

---

# 64. Tool Discovery

Extensions 多以后，不要永久注入全部 Schema。

保留：

```text
tool.search
extension.search
```

然后按需加载具体能力。

---

# 65. External Event

例如：

```text
calendar.event.starting

email.reply.received

github.issue.created

device.presence.changed
```

Core 不提前知道所有类型。

---

# 66. External Event 与 Wake

Extension 可以：

```text
emit event
```

也可以：

```text
emit event
+
request wake
```

Wake Service 负责合并和串行。

---

# 67. Scheduled Wake

Core 可以提供：

```text
wake.schedule(time, reason)
```

用于简单未来认知触发。

复杂监控交给 Extension / Program。

---

# 68. 非 LLM 执行

Mira 可以把任务交给工具。

例如：

```text
notification.schedule(...)
```

之后执行不需要 Mira 参与。

这就是正常软件能力。

不需要额外 Action Domain Model。

---

# 69. Authorization

主要 UX 是自然语言授权。

例如：

> 帮我把下午会议改到三点。

这句话本身构成授权语境。

不要默认追加：

```text
[Allow]
[Deny]
```

---

# 70. Authorization Context

系统维护：

> 用户在什么语境下允许了什么。

不是：

```text
permission=true
```

---

# 71. Consent Resolver

现实副作用明显的工具调用可经过：

```text
Tool Call
   │
   ▼
Consent Resolver
   │
   ├ sufficient evidence → execute
   │
   └ ambiguous
           │
           ▼
       Mira asks user
```

确认仍然通过自然对话完成。

---

# 72. Hard Boundaries

语义判断尽量给模型。

底层硬约束只解决：

```text
authentication

secret scope

filesystem scope

network scope

resource limits

不可越权访问

幂等

并发

数据一致性

危险代码隔离

极少数不可逆安全边界
```

原则：

> **Semantic freedom above, hard invariants below.**

---

# 73. Generated Code Security

Agent 自己写的代码仍然是未知程序。

因此 Extension / Worker Runtime 应支持：

```text
filesystem scope
secret scope
network scope
CPU / memory limit
process lifetime
ownership
```

但这些不需要破坏用户自然交互体验。

---

# 74. Observability

每次 Wake 应记录 Runtime Trace：

```text
wake reason

working context version

time transition

events appended

model calls

files read

history searches

tool calls

authorization decisions

extension events

memory changes

runtime compaction

errors
```

---

# 75. Life Timeline 与 Runtime Trace 分离

Life Timeline：

> Mira 经历了什么。

Runtime Trace：

> 程序具体怎么跑。

不要混。

---

# 76. Storage

推荐：

```text
PostgreSQL
```

保存：

```text
life_events

wake_requests

wake_runs

working_context metadata

authorization context

extension registry

extension versions

runtime trace metadata
```

Memory：

```text
Persistent filesystem
+
Git
```

---

# 77. Working Context Storage

可以保存：

```text
context_id

runtime state

message stream

last perceived timestamp

token estimate

runtime model

created_at

updated_at
```

Compaction Summary 和 recent-tail retention 可以直接沿用 Runtime 自己的持久化表示。

MiraMate 不强制再建立一套独立 Checkpoint Schema。

---

# 78. History Search

第一阶段：

```text
Postgres FTS
```

未来按需增加：

```text
pgvector
hybrid retrieval
reranking
```

接口仍然：

```text
history.search
```

---

# 79. 并发模型

一个 Mira 同时保持一个主 Cognitive Stream。

原则上：

```text
1 active cognition loop
```

其他事件进入队列。

```text
event
event
event
   │
   ▼
Wake Queue
   │
   ▼
same Working Context
```

这很像 per-Mira logical actor。

---

# 80. 用户消息完整流程

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
load existing Working Context
     │
     ▼
render elapsed time if needed
     │
     ▼
append User Message
     │
     ▼
continue Cognition Runtime
     │
     ├ normal file tools
     ├ history search
     ├ state edit
     ├ extension creation
     ├ tool use
     └ response
     │
     ▼
Runtime compacts context if needed
     │
     ▼
persist Working Context
     │
     ▼
Memory Git snapshot if changed
```

---

# 81. 外部事件完整流程

```text
Extension / External Program
       │
       ▼
emit LifeEvent
       │
       ├ no wake
       │
       └ request wake
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
append External Event
              │
              ▼
continue Cognition Runtime
```

Runtime 自己决定是否需要 Compaction。

---

# 82. 多事件 Wake

如果几个事件在 Mira inactive 期间积累：

```text
event A
event B
event C
```

可以形成：

```text
6 hours have passed.

Relevant events since your last cognition:

1. ...
2. ...
3. ...
```

然后一次 append。

---

# 83. Runtime Compaction 流程

```text
Working Context
      │
 context pressure
      │
      ▼
Cognition Runtime
      │
      ├ summarize older context
      ├ preserve recent tail
      ├ preserve tool structure
      └ retain continuation state
      │
      ▼
continued Working Context
```

MiraMate 不额外实现新的 Compaction Engine。

---

# 84. Memory Dreaming 流程

```text
Dreaming Trigger
      │
      ▼
Mira cognition
      │
      ▼
inspect Life History
      │
      ▼
inspect /memory
      │
      ▼
edit / reorganize
      │
      ▼
Git commit
      │
      ▼
Wake lineage
```

不要和 Runtime Compaction 混为一谈。

---

# 85. Self Extension 流程

```text
Repeated need
    │
    ▼
search existing tools/extensions
    │
    ▼
none suitable
    │
    ▼
inspect Extension API
    │
    ▼
write code
    │
    ▼
test
    │
    ▼
stage
    │
    ▼
activate
```

---

# 86. 完整示例：上下文连续性

20:00：

```text
User:
今天吃了家顺德菜，还不错。

Mira:
你不是一直挺喜欢粤菜嘛……
```

Working Context 保留完整对话。

22:12，一个 Extension 产生事件。

Context 自动追加：

```text
[Time Transition]
2 hours and 11 minutes have passed.
It is now 22:12.

[External Event]
...
```

Mira 处理完以后没有给用户发消息。

23:00 用户回来：

```text
[Time Transition]
48 minutes have passed.

User:
对了，刚才那个……
```

Mira 仍然具有：

- 晚餐话题；
- 中间处理过的事件；
- 自己刚才做过的事情；

完整短期连续性。

---

# 87. 完整示例：Runtime Compaction

经过大量持续互动以后：

```text
Working Context
≈ context limit
```

Runtime 自动执行：

```text
older messages
       ↓
structured summary

+
recent messages kept verbatim

+
recent tool calls / results
```

压缩后的 continuation summary 可能包含：

```text
- User and Mira are iterating on MiraMate v2 architecture.
- They agreed on file-based semantic memory.
- Git + Wake lineage is used for memory provenance.
- Wake continues the same working context.
- Time gaps are rendered from timestamps.
- Context compaction should follow standard coding-agent practice.
- Current unresolved topic: ...
```

随后继续同一条 Cognitive Stream。

MiraMate 不把这些内容自动写入 `/memory`。

---

# 88. 完整示例：Memory

用户说：

> 我喜欢粤菜，尤其是顺德菜。

Mira 编辑：

```text
/memory/user.md
```

写：

```text
用户喜欢粤菜，尤其偏好顺德菜。
```

系统自动 Git snapshot。

以后用户问：

> 我什么时候说过？

Mira：

```text
history.search("用户表达喜欢粤菜或顺德菜")
```

或者根据 Memory Lineage 回查相关 Wake。

长期记忆本身没有被来源 metadata 污染。

---

# 89. 完整示例：Capability

用户：

> 以后帮我关注这个 repo 的某类 issue。

Mira：

```text
search existing tools
↓
nothing suitable
↓
write Cordis extension
↓
activate watcher
```

之后：

```text
GitHub API
    │
    ▼
Extension
    │
 irrelevant → ignore
    │
 relevant
    ▼
Life Event
    │
    ▼
Wake
    │
    ▼
append event to existing Working Context
```

于是长期软件能力和连续认知自然连接起来。

---

# 90. UI

主界面：

```text
                 Mira

             quiet · online

────────────────────────────────

昨天

Mira:
...

You:
...

今天

Mira:
刚刚有件事想告诉你……

────────────────────────────────
               input
```

没有：

```text
New Chat
Conversation List
Session
```

---

# 91. UI 信息架构

初期：

```text
Mira

├ Timeline
├ Memory
├ Extensions
└ Settings
```

Timeline 是用户感知的一条持续生命线。

---

# 92. 技术栈

推荐：

```text
Language
TypeScript

Runtime
Node.js

Agent Runtime
pi-agent-core

Model abstraction
pi-ai

Context Compaction
reuse runtime / coding-agent style compaction

Extension Kernel
Cordis

Backend
Fastify / Hono

Frontend
React / Next.js

Life History
PostgreSQL

Working Context
persistent runtime state / message store

Memory
Persistent filesystem + Git

History Search
Postgres FTS initially

Schema
Zod / TypeBox
```

---

# 93. Monorepo

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
│   ├ state/
│   │
│   ├ authorization/
│   │
│   ├ cognition/
│   │
│   ├ runtime-pi/
│   │   ├ runtime/
│   │   └ compaction/
│   │
│   ├ extension-host/
│   │
│   ├ extension-sdk/
│   │
│   ├ external-sdk/
│   │
│   ├ history-search/
│   │
│   └ persistence/
│
├ data/
│   └ mira/
│       ├ memory/
│       ├ state/
│       └ extensions/
│
└ migrations/
```

这里：

```text
context/
```

只负责 MiraMate 自己真正关心的：

```text
Working Context
Context Rendering
Time Transition
```

而：

```text
runtime-pi/compaction
```

负责 Pi Runtime 对有限 Context Window 的通用处理。

没有必要单独建立：

```text
memory-engine/
action-engine/
emotion-engine/
mira-compaction-engine/
```

---

# 94. MVP 第一阶段

先实现：

```text
✓ One continuous Mira

✓ Life Stream

✓ Persistent Working Context

✓ Wake continues same context

✓ Time Transition rendering

✓ Pi cognition

✓ Context persistence

✓ reuse basic runtime compaction

✓ /memory filesystem

✓ MEMORY.md base injection

✓ Git memory history

✓ history.search / history.read

✓ semantic state files

✓ basic authorization context

✓ Web Timeline
```

验证：

> Mira 是否真的表现为一个持续存在、持续上下文不断延续的个体？

---

# 95. MVP 第二阶段：Cordis

加入：

```text
✓ Cordis Extension Host

✓ tool registration

✓ events

✓ services

✓ lifecycle

✓ HMR

✓ Extension Registry

✓ manual installation
```

---

# 96. MVP 第三阶段：Self Extension

加入：

```text
✓ Extension API inspection

✓ coding workspace

✓ generated extension

✓ tests

✓ install

✓ update

✓ rollback

✓ disable/remove
```

---

# 97. MVP 第四阶段：External Programs

加入：

```text
✓ External SDK

✓ emitEvent

✓ requestWake

✓ scoped authentication

✓ standalone worker
```

之后才探索：

```text
设备
桌面
手机
更多外界事件
```

---

# 98. 最终心智模型

```text
                              Mira
                               │
                        Working Context
                               │
                        ┌──────┴──────┐
                        │ Cognition   │
                        │ Runtime     │
                        │ Pi +       │
                        │ Compaction │
                        └──────┬──────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
           Memory             State            Tools
              │                │                │
              ▼                │         capability missing?
         /memory               │            ╱          ╲
              │                │          no            yes
              │                │          │              │
              │                │       use tool           ▼
              │                │                 Extension Creator
              │                │                         │
              │                │                       Cordis
              │                │                         │
              └────────────────┼─────────────────────────┘
                               │
                          External World
                               │
                               ▼
                          Life Events
                               │
                               ▼
                              Wake
                               │
                               ▼
                 append to same Working Context
                               │
                               └────────────→ cognition
```

长期层：

```text
Working Context
      │
 runtime compaction
      ▼
Compacted Continuation State


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

---

# 99. MiraMate v2 最终原则

> **Mira 是持续存在的，模型调用不是。**

> **Wake 结束，Mira 的当前认知上下文不结束。**

> **Wake 是继续已有 Cognitive Stream，而不是重新实例化一个 Agent。**

> **最近的完整上下文本身就是最重要的短期连续性机制，不应该每次 Wake 都靠 Memory Retrieval 重建。**

> **Context 会持续叠加，直到 Agent Runtime 因 Context Window 压力执行通用 Compaction。**

> **Context Compaction 与 Coding Agent 中的问题没有本质区别，应优先复用成熟 Runtime 实现，而不是为 MiraMate 再设计一套特殊压缩系统。**

> **Compaction 保留“继续当前认知需要什么”；Dreaming 决定“长期应该记住什么”。**

> **Compaction 不自动写长期 Memory，Dreaming 也不承担 Runtime Context 管理。**

> **时间间隔由事件时间戳推导并在 Context 中呈现，不需要人为制造大量 TimePassed Event。**

> **Derived context should be rendered, not persisted unless it has independent semantic meaning.**

> **系统维护真实经历，Mira 维护自己如何理解和记得这些经历。**

> **Memory 是普通文件空间，不需要为了像一个 Memory System 而重复包装文件系统。**

> **MEMORY.md 是长期默认语义状态，详细记忆由 Mira 自己组织。**

> **Memory 不为了 provenance 保存没有语义价值的 ID、时间或 metadata。**

> **Git 保存记忆如何变化，Life History 保存过去真正发生了什么。**

> **情绪、关系和长期理解优先使用自然语言语义表达。**

> **工具是 Mira 影响世界的方式，事件是世界影响 Mira 的方式。**

> **普通文件、Shell、Git、代码以及成熟 Agent Runtime 已经解决的问题，不重新发明 MiraMate-specific abstraction。**

> **只有系统确实承担额外职责时，才增加新的 Core Concept。**

> **Cordis 负责动态能力生命周期，Pi 负责持续 Cognitive Stream 中的一次次认知推进以及通用 Context 管理。**

> **Mira 可以把重复的认知转化成软件能力。**

最终可以用三句话概括整个设计：

> **Infrastructure provides continuity, history, agency and boundaries. The model provides the mind.**

> **Mira can turn cognition into capability, while memory remains a living semantic workspace rather than a database schema.**

> **Wake continues the same Mira; runtime compaction changes the representation of context, not the continuity of the mind.**