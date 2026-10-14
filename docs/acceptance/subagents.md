# Subagent verification

Implementation branch, 2026-10-14. Status is recorded per actual command, not inferred
from test presence.

## Offline Pi runtime

`tests/unit/subagents.test.mts` uses real Pi runtime/Agent calls with deterministic
provider responses and a test-only in-memory registry. Ten focused tests passed:

- Parent continues before child completion; isolated child transcript and asynchronous result
- Followup continues the same transcript; retrying a spawn call does not create another child
- Fresh context excludes unrelated parent text; inherited projection retains roles/constraints,
  excludes hidden reasoning, identifies frozen version/head, and rejects oversized input
- Bounded wait releases for user input; cancellation preserves unknown tool evidence
- Restart marks pending work interrupted without invoking the provider
- Full oversized result is spooled with a bounded explicit excerpt
- Four simultaneous children are independent; a fifth receives a capacity result
- Section-based system constraints and existing compaction summaries survive the projection
- Running-child followup queues once and cancellation does not overwrite completed results

These are runtime mechanics tests, not a live model quality claim or a PostgreSQL pass.

## PostgreSQL/service

`tests/recovery/subagents.test.mts` requires the existing explicit isolated
`MIRA_TEST_DATABASE_URL` and is included in `pnpm check:all`:

- Real parent intent, call-to-child mapping, terminal completion/Event/Wake transaction
  including forced rollback of both terminal metadata and receipt,
  duplicate spawn/completion, separate transcript and followup after reopen
- Real LocalWebService parent remains available while child runs; idle parent wakes
  once, main Memory content remains unchanged, Timeline does not publish child output,
  existing run details show child state, terminal restart does not replay
- Parent ownership loss and SIGKILL during a child effect, interrupted restart, explicit followup
  observes unknown evidence without repeating the effect

Local PostgreSQL was not executed in this environment because the task's local
service/socket route is unavailable. The exact-head CI run must establish this gate.

## Limits

No live model/provider quality test, deployment or merge is implied. Browser
interaction is exercised by the existing CI gates; the added UI field uses the
existing run-record layout and does not add a main-chat entry point. The shared
filesystem contract is not adversarial isolation and does not prevent a misbehaving
worker from using shell access to reach main Memory.


## First CI observation

The first PostgreSQL CI run at `b8af10c` executed 177 integration/recovery tests:
175 passed and two new child-recovery tests failed. Both expected the internal
`outcome-unknown` enum in the provider-facing text; the actual Pi conversion correctly
renders “no durable outcome exists” and keeps the enum only in durable observation
details. One assertion threw inside the synthetic provider and caused the second
test to wait for an impossible completed state. The tests now check the real
model-facing evidence and separately assert the durable enum; an offline regression
covers explicit followup without repeating the effect. This first failure is kept
here; the corrected exact-head PostgreSQL run is still required.
