# ADR 0037: Child terminal results at the current tool boundary

Status: Accepted scope, implementation under verification, 2026-10-15.

The user approved delivering completed delegated work while Mira is busy using
the existing live-input boundary: allow the current single tool to settle, then
let Mira review the result before the remaining old tool batch or turn finishes.
Mira decides what to tell the user and whether to continue the original work.

## Durable admission and source

`PostgresSubagents` publishes completed, failed, cancelled and interrupted turns
through a private supplemental-receipt callback, inside the same fenced owner
transaction as its immutable terminal result and sourced Event/Wake. If a main
Wake is active and has no final record, the receipt joins `wake_run_requests` and
`wake_live_inputs`; otherwise it stays queued for the next Wake. The original
claimed batch and its input remain frozen. No new schema or public ingress API
is introduced. Public `receiveLiveInput` still rejects non-user events. Ordinary
external and scheduled receipts retain their ordinary queued behavior.

Only the persisted child turn can reach this internal result path. Its Event
remains `source: system`, `type: subagent.result`, with the complete bounded
payload and explicit non-authorization instruction. Like ordinary Wake events,
its model input uses the sourced event envelope, not a claimed human message.
There is no new system instruction, delegated authority or automatic reply.

Terminal completion, cancellation and startup interruption emit hints only after
COMMIT. Duplicate terminal calls produce neither another receipt nor another
hint. Hint consumers cannot change acceptance; a lost hint or lost commit reply
is covered by authoritative pending reads after recovery. Cancellation still
preserves already-started effects and immutable terminal results.

## Existing loop, arbitration and recovery

The existing runtime consumes these receipts at the same single-tool boundary
as user input. Streaming requests yield; a running tool's signal is untouched.
Its known outcome is saved before insertion, while unstarted siblings retain
not-started observations. The existing `tryBeginWakeTool` and
`tryAppendWakeFinal` owner transactions arbitrate input against tools and final.
After final wins, new results cannot reopen that run and enter the next batch.

Only the existing main WakeLoop writes model context. Supplemental membership
prevents another batch from consuming the same receipt. Compaction candidates
remain frozen; pending receipts are consumed after the checkpoint before the
next natural request. Recovery does not replay child effects, completed results,
known tools or final inference. Child completion does not clear a failed parent
or automatically retry its inference; the receipt remains pending in that run.

`subagent_wait` can also release for another child's result, so its internal
notification/query names and early-return reason now say `live_input`, rather
than incorrectly calling all supplemental receipts user input. Waiting for the
child that just finished still returns its terminal state first.

## Presentation and verification

No chat card, detail pane or automatic child-result message is added. Main Mira
alone chooses what to relay through its ordinary response.

`tests/recovery/live-subagent-results.test.mts` exercises real PostgreSQL terminal
states, committed notifications, deduplication, source enforcement, ordered
user/result inputs, per-tool interruption, restart and final/idle fallback.
`tests/recovery/agent-capabilities.test.mts` covers actual service/child provider
completion during a real bash tool, old sibling suppression, one main Wake,
restart without replay and parent-error retention. Existing live-input tests
cover compaction and tool recovery gates. Providers are synthetic; these tests
make no live-model quality or external connectivity claim. Real PG results must
be reported from the exact tested CI commit, separately from offline checks.
