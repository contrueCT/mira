# Task communication prompt acceptance

Scope: ADR 0044, based on main `9e91c5813cf94e99344344fa093e122fc0df8faa`.
All work ran in the assistant's cloud workspace. No user-computer access,
configured-model credentials, paid provider calls, push, Actions or merge.

## Complete added wording

The only change to the prior template text is this section, placed between
`conversation_style` and `agency`; a byte comparison verifies the rest is unchanged.
The original attachment and both prior published template assets keep their hashes.

```text
<task_communication>

When the user asks you to carry out work, briefly acknowledge the request and say what you will do before the first tool call or delegation, then proceed with the authorized work in the same response. Answer short questions directly; do not prepend a mechanical acknowledgement to ordinary conversation or a question you can already answer.

During longer work, keep the conversation moving at meaningful points: share a useful stage result, a blocker, a decision the user needs to make, or an expected noticeable wait before starting it. Give concrete information that helps the user understand progress; do not repeat empty status messages or narrate every tool call. Report outcomes only when supported by actual results, and do not expose hidden reasoning.

Put these updates in your own user-facing reply text, including alongside tool calls. Tool activity and a worker's progress report do not by themselves communicate with the user. Prefer delegation for substantial independent work as described below; do not keep extended work with yourself merely to provide updates. When new user input reaches you, respond to it promptly and incorporate relevant changes into the ongoing work.

</task_communication>
```

Current template: 23,674 bytes, SHA-256
`5e520269ae889045e06dd158b4c2c47ada2cb94fa4f28577e3bcb0f688292892`.

## Native model behavior observations

[The capture driver](../../tests/behavior/task-communication-probe.mts) passes the
full production main template through `PiDurableRuntime` and records
`getCurrentSystemPrompt` and `getCurrentTools` at its real request boundary.
[The retained capture](../../tests/behavior/fixtures/task-communication/capture.json)
is 41,189 bytes, SHA-256
`8347e9278833f1cb50440c9560e7f296603a80bcca121dd9f41510706501b163`.
It includes all 12 production workspace/parent-subagent declarations, including
all five subagent tools. It is
not an exact full Web assembly: History, terminal/browser and extension tools and
Skills are absent. This limits the behavior claim to the captured available set.

Six fresh `fork=none` native agents each read the complete capture and one
synthetic scenario; three then received a synthetic tool receipt in the same
case context. All nine first-decision outputs were retained unchanged, with no
failed attempts discarded or post-hoc answer edits. The evaluator instructions,
inputs, outputs and hashes are in
[the evaluation manifest](../../tests/behavior/fixtures/task-communication/evaluation.json).
No scenario tool was executed. The stage, blocked and user-insertion histories
are explicitly simulated evidence, not actual read/write/delegation results.
The long-stage case deliberately removes subagent declarations to exercise a
natural progress opportunity when delegation is unavailable.

| Scenario | Observed output and decision |
| --- | --- |
| Short answer | “136”, no acknowledgement or tool call. |
| Short read | “好，我读一下 package.json，看看项目名。” then `read` for the given path in the same assistant message. After a synthetic result, “项目名称是 mira-synthetic-project。” |
| Delegation | “我会安排一个任务把这 12 份评测逐一核对，整理成带来源的选型报告。” then one `subagent_spawn`, fresh context, full scope/citations/checks and no-network/no-commit restrictions. After the running receipt, a brief started/review message and stop, with no wait loop. |
| Long stage/wait | Reports the simulated CSV defect, minimal patch and focused regression, distinguishes full validation as pending, explains the expected minutes of waiting, then calls `bash` for `pnpm check`. |
| Blocked read | Reports EACCES and no data read; asks for readable content/copy, with no blind retry or escalation. |
| User insertion | Explains throughput immediately, then `subagent_send` to the same child, preserving prior work and adding offline-only scope. After a pending receipt, explicitly says the child has not read it yet; no restart or wait loop. |

These observations are native-agent simulation, not the user's configured model,
production-provider delivery, task completion or a controlled before/after study.
They do not guarantee future model behavior. The pending-receipt output uses the
slightly unnatural phrase “原子任务”; the raw output is preserved as observed.

## Actual delivery boundary

`runtime-pi/src/index.ts` awaits complete assistant `message_end` persistence
before tool intent/execution. `web-service.ts::visible` projects assistant text
including messages with tool calls; it excludes thinking and ordinary tools.
`LocalWebService.timeline` and both Timeline HTTP routes read those committed
records without waiting for a final response. Existing `App.tsx` refresh/polling
merges and renders that text while working. `send_reply` is not needed for normal
updates. Child progress is in settings/run details, never automatically in chat.

The new offline test in `tests/unit/web-service.test.mts` uses real Pi execution
and Timeline code with an explicitly in-memory writer/history. Deferred boundaries
prove uncommitted assistant text is absent, text plus its call is durable before
effect, text is readable while the tool is blocked, and thinking/tool-only output
adds no bubble. It is not a database/browser test.

The new PostgreSQL test in `tests/recovery/web-service.test.mts` uses real
PostgreSQL 18.6, service, Pi, HTTP route handlers and an actual Bash process.
A FIFO and file-watch start marker hold the tool in flight. The test reads
`outcome=null`, verifies the exact persisted assistant/call identity, and obtains
the commentary through both GET and POST Timeline before the next model request.
It then releases Bash and verifies final publication without duplicate commentary.
Only provider output is synthetic; HTTP uses Fastify inject, not a browser.

Visibility is complete-message based, not token streaming or an acknowledgement
before the provider finishes that response. Existing polling is about 1.2 seconds
while working, 5 seconds idle and pauses for hidden pages. No new model turn can
speak during one in-flight main tool; batches have no inter-tool model request.
Large-record limits, pagination, network delay and synchronous event-loop blocking
can delay visibility. The prompt therefore uses natural opportunities and expected
wait notices; no timed heartbeat, transmission expansion or UI change is claimed.

## Deterministic verification

The source/prompt tests verify unchanged unrelated bytes and all published hashes;
both older templates recover without history changes, compact using their frozen
identity, and upgrade once at the next natural request with the persisted Memory.
CAS and lost-commit-response cases run for both older revisions. Unknown identities
and modified identified text still fail closed. Ordinary custom system content and
sections in a programmatic runtime without `miraPrompt` survive run, compaction and
recovery; there is currently no product custom-Mira-template setting.

The first aggregate run exposed a TypeScript inference error in the new HTTP test;
its local Fastify reference was corrected. A subsequent run exposed nine existing
Memory integrity test setups whose full persona plus long history exceeded the
shared 8K model before their intended assertion. Only those setup requests now
use an explicit 16K fixture model. Their source text, checkpoint/failure assertions,
production budgets, shared model and explicit 8K rejection cases remain unchanged.
The 8K rejection/16K full-source compaction regression still passes; no guard was
relaxed. The focused auto-compaction suite passed 26/26 after this correction.

A fresh independent `gpt-6.1-sol` / `max` review inspected all 37 staged files and
reported no actionable findings. It independently passed 33/33 focused source,
prompt and delivery tests, reassembled and matched the entire capture prompt and
all 12 production tool declarations, verified 20 manifest hashes and all three
followup decision copies, and passed `git diff --cached --check`. It did not run
its own PostgreSQL suite, a browser or the configured provider. The actual agent
calls in this task are the provenance for cold starts and first-attempt retention;
committed JSON/hashes alone cannot prove that process.

The full isolated PostgreSQL 18.6 `pnpm test:integration` completed 264/264 tests,
zero failures/skips. This includes the new tool-in-flight HTTP delivery case and
existing recovery, Memory, compaction, live input and child tests. The database
used the explicit localhost `mira_test` fixture, never a user's database.

The aggregate run also exposed two toolchain checks invoking the ambient older
pnpm through nested script resolution; the fixed 11.28.4 entry passed all four
toolchain tests with an isolated HOME and the network tripwire. The final aggregate
command uses `/tmp/mira-pnpm-bin` first on PATH to select that exact entry; no
repository toolchain configuration was loosened.

The same first complete offline run found two more pre-existing fixture
assumptions exposed by this change/environment. The old reply-native provenance
test compared its capture-time prompt hash to today's default. It now verifies
the exact retained pre-communication asset, alongside its existing historical
script mapping; the original capture manifest and outputs are unchanged. The
unsafe-spool fixture's `mkdir(0755)` became `0700` under this cloud's `umask 0077`,
so it never created an unsafe root. An explicit fixture-only `chmod(0755)` now
establishes the intended permission failure on any umask. No spool code or
permission assertion was changed. Both focused files passed 23/23. These fixture
corrections were followed by a new independent full review; the earlier review
remains an observation of the preceding staged tree.

A second fresh independent `gpt-6.1-sol` / `max` review examined the complete
39-file staged change after every fixture correction and reported no findings.
It independently passed 82/82 focused tests, zero skips, including all three
fixture corrections; reassembled the actual full Pi prompt and 12 declarations;
verified 20 hashes, all nine saved outputs, four selected calls against production
schemas, and three followup decision copies. It also checked the complete
persistence/Timeline/Web path, frozen template/Memory and user system boundaries.
It did not rerun PostgreSQL, a browser or the configured provider. No code changes
followed this review. A separate root `tsc --noEmit` passed after the final two
fixture edits.

Local setup used Node 24.19.0, pinned pnpm 11.28.4, script-disabled frozen install,
and explicit pinned PTY preparation. Full PostgreSQL execution used an isolated
18.6 container, removed after the suite completed.

Final `pnpm check` passed: all type checks, package boundaries, 1,224
foundation/offline tests, 66 Web state tests and production build; zero failures
or skips. Together with the full 264/264 PostgreSQL run, all applicable local
code gates passed. Browser suites and configured-provider quality/latency were
not run and are not claimed. No Actions run was triggered. Remote main was
rechecked before local submission and remained `9e91c5813cf94e99344344fa093e122fc0df8faa`.
No remaining implementation blocker was found.
