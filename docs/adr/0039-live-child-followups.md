# ADR 0039: Parent instructions at the child's live boundary

Status: Accepted scope, implementation under verification, 2026-10-15.

The user approved Mira's followups entering an already-running delegated task
without waiting for its whole turn. The current individual tool is allowed to
settle; long-running tools can still delay delivery. This is the parent-to-child
layer, separate from ADR 0037's child-terminal-result delivery to Mira.

## One task and explicit source

`subagent_send` keeps the existing child and transcript. An already-admitted queued or running child task with no committed final
receives an ordered supplemental parent instruction. Inputs accepted before
initial claim join that task too, so later running inputs cannot overtake them. Idle work,
terminal work, and sends losing the final-publication race retain the existing
queued-turn behavior. There is no new child, nested delegation, main WakeLoop,
Memory access, Dreaming activity, UI entry point or separate scheduler.

Parent assignments and supplemental instructions carry immutable task/parent-call
provenance in the child transcript. Pi's user-role input carrier is a transport
role, not a claim that a human authored the instruction. The rendered source says
it is a parent-agent instruction for the same task, not independent user permission.
No system instruction or authorization evidence is synthesized. Summary candidates
retain the same task-only prompt and frozen source history.

## Durable arbitration

`TaskInputWriter` is a child-transcript capability, distinct from `LiveInputWriter`
and main Wake tables. Child turns have immutable input/final record links; the
ordered task inbox stores the parent call ID, original instruction, receipt time,
consumption record and terminal delivery state. One immutable call ledger covers
both queued-turn and live routes, so a retried parent call cannot change target,
content or route. Consumption and transcript append share one child writer CAS
transaction; an acknowledgement lost after COMMIT never authorizes reexecution.

The parent writer fences registry admission. The child writer fences transcript
publication. Both lock the same child identity row for task admission, input
consumption, tool-intent start and final publication. No child transaction awaits
a parent-connection RPC. Input-first prevents final publication and old sibling
intent admission; final-first leaves the new instruction queued for a later turn.
Each child retains one running turn and at most sixteen pending followups. Receipt
order comes from the database, independent of source timestamps.

Generic checkpoint, recovery and known-tool-outcome publication retain their own
child fencing/CAS. They do not acquire the parent-admission lock or alter the
approved late-summary/cancellation evidence rules in ADR 0030. Final arbitration
is performed only when a successful no-tool assistant reply is published through
the task boundary, not inferred from a transient model event.

## Runtime and lifecycle

`continueTaskTurn` reuses Pi's existing attempt lifecycle, request yielding,
sequential tool gates, unknown-effect recovery and automatic compaction. Committed
notification hints may abort an in-flight model request; partial output is discarded.
A running tool is not cancelled. Its exact known outcome and result are saved
before pending input is consumed, and unstarted old siblings receive ordinary
not-started recovery observations. Durable reads close missed-notification windows.

Instructions arriving during summary generation stay pending outside the frozen
candidate. After its checkpoint commits, the runtime reads the inbox before the
next natural model request. It does not rerun the summary solely to insert input,
reload main Memory or lose legal tool pairing.

Cancellation, failure and restart preserve consumed evidence and terminalize unread
receipts with their actual delivery state. They never silently start the unread
instructions or replay uncertain effects. An explicit later followup continues the
preserved transcript under the existing lifecycle. Cancellation does not undo
already-started effects. A committed final may be validated on recovery without
regenerating it; startup still conservatively interrupts active registry work.

## Receipt and verification

The send result reports the admitted route, target turn, and durable receipt state.
Pending means accepted, consumed means appended to the worker's context, and neither
means the worker has completed or even acted on the instruction. No immediate-kill
or long-tool latency promise is made. Main Mira remains free to continue useful work.

- `tests/unit/task-live-input.test.mts` drives actual Pi with an offline task writer
  through streaming yield, ordered inputs, single-tool sibling suppression, final
  arbitration and unknown-effect recovery.
- `tests/unit/subagents.test.mts` covers dispatcher receipts, same-task continuation,
  cancellation, model transport and task-only summary behavior.
- `tests/recovery/task-live-persistence.test.mts` checks the real PostgreSQL ownership,
  admission, immutable-call identity, receipt order, CAS and terminal races.
- `tests/recovery/task-live-runtime.test.mts` combines the real manager, PostgreSQL,
  child Pi runtime and controlled tool/provider boundaries, including restart
  evidence and one terminal result.

Provider responses are synthetic. Real database checks require the existing CI
PostgreSQL service; local socket restrictions are not bypassed. Offline checks do
not establish database success, live model quality or external-tool connectivity.
