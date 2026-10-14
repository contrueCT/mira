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
interruption. The runtime allocates the new checkpoint UUID before summary dispatch,
records it only in the internal activity, and gives that same identity to the SDK's
new candidate without changing prior references. The parent registry confirms the
exact UUID, child stream ownership and checkpoint envelope kind through its own
connection, so a stopped child writer is never needed to prove a committed summary.

Turn outcomes and terminal rows remain immutable. If cancellation reaches the parent
before an already-dispatched child COMMIT, all late callbacks still stay ignored.
Bounded child reads use one batch query over the final interrupted summary identities
to project a durably committed summary as completed. They do not update its saved
activity, terminal result or timestamps, or enqueue another Event/Wake. This also
works after restart when no completion callback survived. Cancel-before-COMMIT with
no exact checkpoint remains interrupted; no timestamp or unrelated checkpoint is
accepted as evidence. Tool and management DTOs omit these internal checkpoint and
tool-history links. An activity write failure stops further provider work.

## Validation and limits

Offline dispatcher tests drive actual Pi requests and the public summary hook
with deterministic synthetic completions. They check bounded repeated followups,
queued input during summary, main-Memory exclusion, history preservation after
summary failure/cancellation and explicit continuation. PostgreSQL tests verify
checkpoint/restart and main-stream isolation. The separate
`tests/recovery/task-compaction-activity.test.mts` gate uses actual Pi and PostgreSQL
transactions with injected driver-response boundaries: cancellation before/after
COMMIT, cancellation winning the parent queue after child COMMIT dispatch, lost
COMMIT acknowledgement that permanently stops the child writer, missing completion
callbacks and immutable terminal-row/read-projection recovery. It also rejects
another stream's checkpoint and a same-stream message as summary evidence. The
offline production-registry SQL fixture covers these activity paths but is not a
substitute for that real database gate. Browser coverage exercises the
existing delegation and details UI on the same service path. These are mechanism
tests, not live-provider or natural-language summary quality validation. No paid
model request is part of this change.
