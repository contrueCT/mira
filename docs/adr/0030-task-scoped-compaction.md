# ADR 0030: Task-scoped child compaction

Status: Approved scope; implementation under verification, 2026-10-14.

## Decision

Long delegated tasks and repeated followups use the existing Pi 1.0.2 durable
compaction path on the child's own transcript. This supersedes ADR 0025's initial
decision to disable child automatic compaction. The normal model-derived budget,
threshold, output reserve, retained tail, strict reduction/fit checks and one
context-overflow recovery attempt apply. Oversized or irreducible input still
fails safely; this is not an unlimited-context guarantee.

`PiRuntimeOptions.compactionScope: 'task'` selects a versioned, hash-checked
worker continuation prompt through the same public `session_before_compact`
hook. The default remains the approved Mira summary prompt. Task scope rejects
`miraPrompt`, including a main Memory loader, at construction. It supplies the
worker contract as quoted reference data and a null Memory snapshot. It preserves
assignment scope, sources, permission limits, unresolved effects and unfinished
work without treating the child as the main assistant. There is no extra runtime,
summary service, provider fallback, Memory loading or Memory-writing tool.

The SDK still owns cut selection and legal protocol pairing; the same fenced
PostgreSQL checkpoint atomically publishes summary/system/tail. All original
records and known/unknown tool evidence remain durable. The existing ordinary
file spool is passed to children for referenced attachment evidence. A failed or
cancelled summary cannot publish a partial checkpoint or fall back to Pi's coding
summary; the turn becomes failed/interrupted/cancelled under existing lifecycle
rules. Only explicit followup resumes after failure or restart. Already executed
tools are never replayed by compaction.

Followups arriving while summary generation is running remain queued in the
existing child registry. They are consumed in order after the current turn, not
injected into its frozen summary candidate. Restart interrupts in-progress turns
and explicit followup reloads the committed child checkpoint. Child checkpoint
rows use the child stream ID; main transcript versions, main compaction counts
and Dreaming's main-stream query remain separate. Child completion still queues
its normal sourced parent result, but does not itself become a fresh user
experience or a main compaction.

Summary dispatch records content-free model start activity; completion is reported
only after the checkpoint is durably confirmed. Child details label this as
context compaction. Failure/cancellation reports its actual terminal state, and
ambiguous append responses consult the authoritative checkpoint before declaring
interruption. An activity write failure stops further provider work.

## Validation and limits

Offline dispatcher tests drive actual Pi requests and the public summary hook
with deterministic synthetic completions. They check bounded repeated followups,
queued input during summary, main-Memory exclusion, history preservation after
summary failure/cancellation and explicit continuation. PostgreSQL tests verify
checkpoint/restart and main-stream isolation. Browser coverage exercises the
existing delegation and details UI on the same service path. These are mechanism
tests, not live-provider or natural-language summary quality validation. No paid
model request is part of this change.
