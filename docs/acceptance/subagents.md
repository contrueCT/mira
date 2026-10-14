# Subagent verification

## Current presentation: ADR 0031 (2026-10-14)

Main chat no longer contains child cards, child entry points or child-only empty
Timeline rows. Activity and read-only details remain in Settings → Run records.
The backend child tools, durable association, independent management reads and
completion Wake semantics remain unchanged.

Offline coverage includes real service Timeline projection with synthetic history:
ordinary user/assistant text, user attachments, later explicit attachment publication,
history cursors and zero child metadata reads. HTTP tests reject unexpected child
metadata in both Timeline read methods. The existing PG service regression also
checks ordinary parent replies and the absence of child-only rows.

The real capabilities browser suite now navigates through the existing settings
and exact parent run for child activity, progress, completion, compaction and restart.
It captures `main-chat-no-child-cards-running-desktop.png` / `mobile.png`,
`settings-child-running-desktop.png`, `settings-child-progress-mobile.png`, plus
completed conversation and child detail screenshots. The fixture suite covers
identity/error/followup, Escape/focus, Back/Forward and narrow layout through settings.
These tests require exact-head CI; prior screenshots do not establish this UI.

Local `pnpm check` passed 912 foundation/offline tests and 46 web-state tests,
all type/boundary checks and the production build. Final Pi/E2E typechecks passed;
Playwright discovery found the 40 fixture and 5 real capabilities cases. An initial
standalone typecheck used a new test filename outside the existing Pi-consumer
configuration and failed on upstream declarations; moving that test to the
already-configured `web-service.test.mts` path fixed the classification without
changing compiler exceptions. Independent review follows final stack integration.
PostgreSQL/Chromium remain blocked in this environment; no socket restriction is
bypassed, no mock image substitutes for browser evidence, and no live model is used.

## Previous extension: ADR 0026 (2026-10-14)

The historical verification notes below describe the original four-worker feature
and its former mixed parent-page child projections. ADR 0026 supersedes that
UI/configuration behavior: default eight workers, startup `1..32`, compact child
cards only when delegation exists, independent read-only child/run observation,
real model/tool activity plus explicit worker progress, and OS-home global skills.

Current local verification: `pnpm check` passed 810 foundation/offline tests and
44 web-state tests, type/boundary checks and build before final cleanup. Skills
focused tests passed 22/22; runtime/live-input/diagnostic/subagent regression
passed 176/176. New HTTP projection tests verify private assignment/protocol/spool
fields are excluded and exact child/run identity is required.

A fresh isolated PostgreSQL 18.6 start was attempted on 2026-10-14. It failed
creating its Unix socket with `Operation not permitted`; no socket restriction
was bypassed and no previous data directory was used. Therefore new PG and
Chromium tests are pending exact-head CI, not locally claimed as passed.

New real-service browser coverage requests spawn → a real blocked `bash` tool →
explicit public progress → model generation → completion → reopened detail and
restart. It checks global skill metadata on main/child and ordinary child read,
keeps the main failed-run/live-input behavior and verifies no duplicate effects.
Separate UI fixture coverage checks two child identities, failed refresh retaining
confirmed evidence, mismatched identity rejection, unknown tool outcome wording,
terminal-to-followup refresh, focus restoration and desktop/narrow screenshots.
PG regressions cover 8/9 capacity, 40-event bounds, rejected raw fields,
run-scoped 55-child paging, owner loss and restart current-activity cleanup.

Fresh independent `gpt-6.1-sol`/`max` review is in progress. Its initial findings
identified terminal-card followup refresh and run-scoped cursor ownership; both
are being corrected and independently rechecked before delivery. Exact-head CI
and actual screenshot inspection will be recorded here when available.

## Historical implementation and verification


Implementation branch, 2026-10-14. Status is recorded per actual command, not inferred
from test presence.

## Offline Pi runtime

`tests/unit/subagents.test.mts` uses real Pi runtime/Agent calls with deterministic
provider responses and a test-only in-memory registry. Fourteen focused tests passed:

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
- Followup cannot exceed the concurrency cap while cancelled effects are still settling
- Followup during cancellation cleanup preserves the old cancelled result and starts once cleanup settles

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


## Independent review and followup

A fresh independent `gpt-6.1-sol` / `max` review of `d0f1c0d` found two P2 issues:
run details used the failed owner's writer for child metadata, and bounded UI output
was preceded by an unbounded lifetime-registry read inside the parent transaction.
The revision introduces a separate scoped read-only reader, SQL metadata pagination,
direct call lookups, page-scoped management projection and bounded recent/pending
turn reads. New PostgreSQL regressions cover 55 children, thirteen turns, payload
omission, owner-loss reads and ordinary/child run details after terminating the owner.
A fresh rereview and revised-head CI remain required.

The earlier `d0f1c0d` passed complete CI run 38515268026, including PostgreSQL,
SIGKILL/atomic rollback and all browser gates. That success does not establish the
later review fixes; their exact-head result will be recorded separately.


A second fresh review of `b0f8cf7` confirmed both earlier fixes and found two more
P2 issues: pre-first-input interruption could lose the original assignment/frozen
constraints on explicit followup, and run-record pagination could retain stale
child statuses. The revision uses durable child user-input presence rather than
turn sequence for initial reference injection, and monotonic child-turn merging.
Offline regressions cover empty/system-only transcripts in fresh/inherited modes;
PostgreSQL covers restart before first input, and web tests cover older/gap pages
and stale responses. A further fresh review and exact-head CI are required.
The known completion/error-latch guard and child skill discovery are assigned to
the combined integration branch and must be verified there before merge.

`b0f8cf7` subsequently passed complete CI run 38516468348 (PostgreSQL and all
browser gates included). This predates the second review fixes above and is not
evidence that those later fixes passed.


A third fresh review of `361212a` verified the previous fixes and found that an
active child's queued followup reused its initial transport closure after a
same-model settings refresh. The dispatcher now retains each accepted turn's
transport only in process memory, selects it at claim time, and clears it when
claimed/cancelled/closed. No credentials are persisted. The regression queues two
followups with distinct same-model transports and verifies each runs with its own
accepting parent-turn transport. Further fresh review and exact-head CI remain
required; the known integration error-latch guard remains assigned as above.

The same third review also found repeated latest-child activity could falsely
bridge disjoint parent cursor windows. Child projections are now explicitly
supplemental; parent pagination frontiers and insertion anchors exclude them.
A web regression preserves the gap across repeated child rows and verifies all
parent records remain reachable in durable order.

`361212a` passed full CI run 38517250051, including the newly added pre-first-input
PostgreSQL recovery case and all browser gates. This predates the transport and
supplemental-pagination fixes and does not establish their acceptance.

A fourth fresh review of `3677294` found two remaining UI P2s: loaded child turns
outside the latest parent page stopped refreshing, and transient child-reader
errors were retained as immutable execution rows. The revision returns a stable,
Mira/run-scoped page refresh boundary and re-reads at most one loaded pending-child
page per existing poll, rotating pages and dropping terminal turns. Refresh reads
do not move parent pagination frontiers. Transient child-read failures are current
response notices, retried through the same bounded path and cleared on success.
The HTTP whitelist now explicitly retains supplemental/refresh metadata.

Added checks cover exhausted history with more than fifty newer parent records,
HTTP projection fields, independent metadata/activity failure recovery, and a
real PostgreSQL stable-refresh-boundary regression. The focused suite now has
fourteen actual-Pi runtime tests plus one read-only LocalWebService fixture test;
none of those offline fixtures claim a PostgreSQL or browser execution result.
A fresh rereview and exact-head CI are still required.

`3677294` passed full CI run 38518115266 before these UI refresh fixes. Its green
PostgreSQL/browser gates do not stand in for validation of the newer revision.

The fifth fresh review reproduced a precise cursor-boundary P2 with actual
sequential Pi tool calls: a fabricated next-version refresh bound can admit the
next result, or a sibling intent at the current version, and shift a full page.
Refresh cursors now preserve the exact observed tuple inclusively; ordinary
four-field history cursors keep their strict semantics. The PostgreSQL regression
starts with a full page whose oldest reference is a child spawn, then verifies
both later-intent and later-result boundaries preserve the exact original page.
Malformed inclusive markers and cross-Mira cursors remain rejected.

CI run 38519409997 at `d8ba4ff` failed two PostgreSQL cases: the new refresh-boundary
case confirmed the inclusive-boundary bug, and the pre-input recovery case exposed
a cleanup race. The dispatcher released its tracked active slot before awaiting a
last registry read, so close could miss that read and its owner could stop early.
The revision keeps the slot through awaited cleanup and remembers followups that
arrive while that cleanup is settling. Controlled offline regressions cover both
close waiting for the last read and a followup arriving during that read. These
failures are retained here; the corrected exact-head CI remains required.

The first ADR 0026 independent review additionally reproduced an actual Pi
commit-then-abort observation race. Runtime finalization now reloads authoritative
outcomes, preserving confirmed success/error instead of downgrading them to
unknown. It also identified long provider call-ID truncation during restart
reconciliation. The persisted activity link now uses the exact tool History UUID,
resolved from the untouched protocol ID within the child stream. New regressions
exercise both windows. Shutdown also waits for capacity admission and actual
actors before interrupting any remaining queued turns; accepted but not-started
work cannot remain falsely queued after an orderly close.

CI run [38533105175](https://github.com/contrueCT/mira/actions/runs/38533105175)
at `56bfc64` passed 816 offline and 42 web-state tests, then ran 209 real-PG
checks: 207 passed and two failed. Both failures were old down-migration tests
that still expected the child registry to disappear on the first down, before
accounting for new migration 0008. The PostgreSQL feature/recovery cases ran;
Chromium steps were skipped after this failure and are not claimed as passed.
The down/up tests now explicitly verify the activity/association-column slice
before removing child/scheduling slices. This failed run is retained as evidence.

Further independent review found that a newly followed-up older child could be
missed after exhausting run-child pages. Run membership now uses an immutable,
fenced first-association sequence on existing turns, independent of child age and
wall-clock time. Browser page merging inserts into the correct cursor window,
including more than fifty new members and multiple disconnected windows. PG and
UI regressions exercise these cases; exact-head CI is required again.
