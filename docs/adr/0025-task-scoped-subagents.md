# ADR 0025: Task-scoped subagents

Status: Accepted scope, implementation under verification, 2026-10-14.

The user approved asynchronous delegation, status/list, followup/send, bounded
wait and cancellation; fresh context by default, optional inherited context;
shared working files with main Memory maintained only by Mira; inherited model,
bounded concurrency and no nesting; existing run details rather than a new main
UI entry point.

## Reuse and boundaries

Mira already persists Pi 1.0.2 Agent/session entries in PostgreSQL. Child workers
therefore reuse `PiDurableRuntime.run` with independent durable transcript writers,
not a second WakeLoop, Mira persona, global Life, JSONL authority or job platform.
The database owner row for a child is a technical transcript writer identity.
There is one main Mira, Memory lifecycle and parent Wake queue.

Upstream references actually inspected:

- [Pi v1.0.2 subagent extension source](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/examples/extensions/subagent/index.ts): independent contexts, bounded parallel workers, inherited dispatch configuration and returned results.
- [Pi v1.0.2 license](https://github.com/earendil-works/pi/blob/v1.0.2/LICENSE): MIT. No example source copied; existing pinned public runtime APIs are reused.

The CLI/process example is not imported: its subprocess/session handling would
create a competing authority and does not supply Mira's restart/fencing semantics.
No tmux framework, approval engine, new user-facing persona or sandbox is added.

## Lifecycle

`subagent_spawn` returns a stable child UUID after saving the parent call-to-child
mapping. Child model/tool execution runs separately, while the main turn continues.
ADR 0026 raises the default to eight active slots, configurable from 1 to 32 at startup. Followups are persisted, deduplicated by
parent call ID and consumed after the current child turn. At most sixteen queued
followups per child are accepted. An idle or terminal child can receive a new turn.
Each turn retains its immutable terminal result; later work never overwrites it.
Status listing selects at most fifty metadata rows in SQL, without task/context/result
bodies. Individual status reads return the latest eight turns plus bounded pending
turns; call retries use indexed direct lookups, including older turns.

Parent ownership fences registry mutations. Children have separate transcript
writers, tool intents/outcomes, provider call identities and history UUIDs. Losing
the parent writer aborts child work as well. Restart marks queued/running turns
interrupted, publishing that fact without automatically executing them again.
Explicit followup first recovers the existing Pi transcript and its unknown or
not-started tool observations. The model can inspect before choosing a new action.

Completion and its sourced parent Event/Wake are one parent-writer transaction.
The normal Wake queue consumes the receipt once and wakes an idle parent. This is
not an exactly-once claim about external effects. A crash after a child's final
record but before parent completion may conservatively appear interrupted; its
original transcript remains available. Cancellation stops future work, preserves
results/evidence, and never claims already-started effects were rolled back.

`subagent_wait` is capped at ten seconds and normally defaults to one second.
Committed Web user messages release an outstanding wait without cancelling the
child. Child results remain ordinary queued Wake inputs; integration with live
steering does not make them fresh user instructions.

## Context and model

Default `fork=none` includes only the delegated task and worker contract.
`fork=all` means the current projected parent context as frozen role-labelled text,
including an existing compaction summary. It is not lossless cloning of original
history: hidden reasoning and provider metadata are excluded, and parent tool
calls remain quoted evidence rather than child protocol messages. The returned
metadata gives the frozen version/head, scope and byte count. Oversized snapshots
are rejected with the required byte count; constraints are never silently trimmed.
The absolute limit is 128 KiB, lowered conservatively for small model contexts.

The exact injected parent transport is used for each started child turn, with
model identity and a configuration fingerprint in the durable specification.
Credentials/functions are not persisted in child metadata. Followup rejects a
changed model configuration. The first version does not add model-selection UI.
ADR 0030 enables child automatic compaction with task-only summary instructions,
using the same durable SDK checkpoint path and independent child transcript. It
does not apply the main Mira/Memory summary prompt or grant Memory access.

## Tools, files and observations

Workers receive ordinary Pi file/search/shell tools and read-only access to their
own transcript history. They do not receive delegation, attachment publication,
parent-history mutation, Memory lifecycle, extension management or user delivery
tools. The natural-language worker contract excludes main Memory/private app state
writes and asks for explicit file ownership. Shared filesystem/OS access is not a
security sandbox; ordinary tools are not path-confined. Mira reviews results and
maintains Memory. Worker output and inherited third-party content cannot authorize
action or impersonate the user.

Terminal text is capped at 16 KiB in the completion Event. Larger output is saved
through the existing ordinary input-spool writer with a full-file path and explicit
truncation marker. Tool status exposes recent results. ADR 0026 replaces the initial
parent-page child-history projection with independent bounded child/run details,
explicit public titles/progress and real runtime start/end observations. Only
linked child tasks create compact Timeline cards; they do not automatically
publish worker results as a Mira reply or expose arbitrary result files. Parent
ownership loss does not disable read-only history inspection.

## Verification

See [subagent acceptance](../acceptance/subagents.md). Offline Pi mechanics,
PostgreSQL/restart/service integration, browser UI and live model behavior are
separate claims. No live provider call is made by this feature's tests.

## Combined feature assembly

The integrated server passes the claimed Wake to tool assembly. `subagent_wait`
checks that run's durable pending supplemental input as well as committed input
notifications, so the interval between tool intent and execute cannot lose user
attention. Completion stays an ordinary queued result and does not clear a failed
parent run. Child `loadSkills` uses the ordinary source/Mira-home/user-global (`~/.agents/skills`) metadata loader
and a standalone durable system section; it does not render the main Mira persona,
load main Memory, or read skill bodies automatically.
