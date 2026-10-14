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
Four children can occupy active slots. Followups are persisted, deduplicated by
parent call ID and consumed after the current child turn. At most sixteen queued
followups per child are accepted. An idle or terminal child can receive a new turn.
Each turn retains its immutable terminal result; later work never overwrites it.

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
Child automatic compaction is disabled: the existing request budget fails safely
rather than applying the main Mira/Memory compaction prompt to a worker. Long tasks
can report a blocker and be redelegated with explicitly selected materials.

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
truncation marker. Tool status exposes recent results. Existing run details show
child identity, lifecycle state and safe execution projections from the latest ten
child history records (explicitly labelled latest activity), without raw task payload, hidden reasoning or
system prompts. Normal Timeline never publishes a child's result automatically;
only Mira decides what to relay.

## Verification

See [subagent acceptance](../acceptance/subagents.md). Offline Pi mechanics,
PostgreSQL/restart/service integration, browser UI and live model behavior are
separate claims. No live provider call is made by this feature's tests.
