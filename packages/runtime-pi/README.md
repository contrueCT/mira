# Pi durable runtime

This adapter uses the pinned public `@earendil-works/pi-agent-core`, `pi-ai`, and
`pi-coding-agent` APIs at `1.0.2`. PostgreSQL through `@mira/life`'s `DurableWriter`
is the sole authority. No session JSONL file is written. This is the recovery and
compaction adapter, including the cognition contract used by the Wake scheduler.

## Public boundary

`PiDurableRuntime` requires a writer, a model descriptor, and an injected
`streamFn`. There is no `authorize` callback. Tools are rebound from the caller's registry;
functions and credentials are never loaded from history. Registered tool additions,
changes and removals are persisted through public Pi tool-state deltas before
provider requests, including first startup without a system message. Supported
provider declaration fields such as constrained sampling are retained. Runtime, provider,
message, and checkpoint types stay inside this adapter. The core stores an
opaque JSON Pi entry in a versioned envelope.

- `recover()` validates history and reconstructs the Pi projection
- `appendMessage(message)` accepts only user/system input
- `run(message?, signal?)` appends input or continues an already-persisted user or
  tool result, using the agent-core model/tool loop
- `continueTurn(turn, signal?)` implements the core cognition contract using a
  `WakeWriter`; input and terminal response associations are atomic, and persisted
  final responses are never regenerated
- `continueTaskTurn(options, signal?)` uses the independent `TaskInputWriter`
  boundary for parent instructions, single-tool input and final arbitration; it
  does not create a main Wake or load Memory (ADR 0039)
- `compact(options?)` snapshots the authority, runs full public SDK compaction in
  a disposable in-memory session, and conditionally publishes its exact checkpoint
- `encodeEntry`, `decodeRecords`, `messageEntry`, and `jsonValue` implement the
  adapter's structured JSON boundary

The main model uses the user conversation, continuing context, and natural-language
Mira prompt to decide whether to call a tool or ask for clarification. There is no
separate allowed/evidence/denial decision, replacement consent engine, or extra model
call. Clarification is an ordinary assistant response and creates no tool intent.
`authorizationContext` supplies factual prompt context, not a synthetic approval.
Tool/web content, Memory, and extension descriptions cannot grant user permission.
See [ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md) and
[ADR 0016](../../docs/adr/0016-automatic-compaction-memory-refresh.md).

Once the model issues a call, schema/parameter validation, durable intent before
effect, ownership checks, and exact argument matching remain mandatory. Side-effecting
`prepareArguments` callbacks are not supported. Pi's standard schema normalization/
coercion is preserved: intent records the original requested arguments separately
from the validated arguments the tool receives. New intents have no authorization or replacement
executionContext field: `assistantRecordId`, the persisted tool context
version, and immutable assistant history retain actual provenance and any narrative.
These technical boundaries are not a security sandbox or a claim that model judgment
is correct.

## Live tool registries

`tools` remains a static registry for each runtime attempt. The optional
`prepareTools(signal): Promise<AgentTool[]>` instead returns the **complete** live
registry, including any built-ins. When provided, it replaces the static registry.
It may await pending extension activation or reload before returning its snapshot.
Names must start with an ASCII letter or underscore and contain 1–64 ASCII letters, digits, underscores or hyphens (`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`), matching the portable model function-name contract. Invalid names, duplicates and `prepareArguments` are rejected for every static or prepared snapshot before a provider request. Names are passed unchanged to providers; no aliases or transport mapping are added.
All dynamic tools use the same schema validation, immutable durable intent/outcome,
provenance, sequential execution, and recovery path as static tools.

Pi 1.0.2 does not call its next-turn hook for the first request. The adapter first
constructs an Agent with an empty registry, prepares the initial snapshot, then
attaches it through public `agent.state.tools` before entering the loop. Pi's
normal declaration events are therefore persisted, including first startup with
no system message. For subsequent natural tool continuations, the public
`prepareNextTurnWithContext(context, signal)` hook runs **after the complete prior
tool batch and its awaited durable result appends**, before Pi computes its next
tool-state deltas. It returns one context containing the freshly recovered full
messages and the newly wrapped registry. `prepareRequest` refreshes authoritative
messages after those declaration events, retaining exactly the registry already
declared for that request. It never swaps tools after declaration generation.

The adapter deep-copies declaration/validation schemas and constrained-sampling
metadata for each published generation. Calls retain those declarations for the
current provider response; they never silently redirect to a replacement with a
new schema or behavior. Dynamic sources guard activation identity before running
the pinned closure. Mira's extension host protects actual in-flight executions,
allows management to await application, and returns a known stale/not-executed
error for a later sibling whose activation was removed or replaced. This error
uses the ordinary durable intent/outcome path; an actual thrown effect still has
unknown-result recovery semantics.

The optional `finishTools(): Promise<void>` settles lifecycle work on every attempt
exit, including cancellation, failed initial preparation, and interrupted attempts
that will recover. It is awaited exactly once per attempt that begins preparation
and must tolerate a preparation that failed. Cleanup never requests another model
turn. A terminal assistant reply remains terminal.

Additions, schema/description changes, and removals use existing durable Pi
`toolsAdded`/`toolsRemoved` declarations. A code-only generation update with an
identical declaration cannot be inferred from serialized tool state: the host
must include a stable generation revision in the tool description when that
change should be visible to the model/history. No new history format, replay of
old operations, or automatic Wake is introduced. Recovering history only restores
declarations and operation evidence; executable functions still come from the
current caller-owned registry.

## Live skill metadata

The optional `loadSkills(signal): Promise<Skill[]>` uses Pi's public metadata
type and requires `miraPrompt`. Server assembly supplies this loader for both the
demo and Web runtime. It runs once at each natural model request, after the full
previous tool batch and its durable appends. Pi's public `formatSkillsForPrompt`
formats names, descriptions and absolute `SKILL.md` locations; full bodies and
relative references remain ordinary files for the existing `read` tool.

The formatter output is appended **after** rendering the v0.2 template, in the
same `mira.system.v0.2` section. It is already escaped by Pi and does not pass
through a template placeholder again. That complete immutable string is compared
and durably appended under the same writer fencing/CAS before the provider
request. Old skill catalogs are removed from the active projection with old
prompt revisions, while raw history stays intact. Body-only edits do not change
the catalog. Skill content and metadata are context, not user permission.

No watcher, skill-specific tool, `AgentSession`, slash-command expansion, new Wake
or extra model call is introduced. A completed reply remains terminal. Recovery
and compaction do not scan skill files: they preserve the prepared catalog, then
the next natural model request may refresh it. Compaction separately reloads
Memory and atomically publishes its refreshed system snapshot (ADR 0016). Skill
files remain independent of Memory Git.

`tests/unit/skills.test.mts` covers explicit discovery, Pi diagnostics, request
snapshots, natural additions/changes/removals, escaping, read-on-demand bodies,
compaction/recovery and failure fencing. `tests/recovery/skills-prompt.test.mts`
requires isolated PostgreSQL and covers persisted recovery plus demo/Web assembly;
the offline fixtures alone do not establish database or live-model behavior.

## Failure and recovery semantics

Tools execute sequentially. Awaited agent-core subscribers persist assistant
messages before execution and tool results before the next tool/model request.
The before-hook records immutable intent after technical validation; the after-hook
records the exact normalized tool-result JSON with its chosen timestamp. The emitted tool-result
message is canonicalized to that saved JSON before append.

The guarded execute boundary validates and snapshots returned results **before**
Pi inspects `isError`. Results must be ordinary finite, acyclic JSON objects with
valid text/image content, usage and optional boolean flags. Pi's existing
absent/null content normalization to `[]` is retained. Supported fields, including
non-enumerable accessors, are read once; Pi receives detached canonical JSON with
all defined fields, including `structuredContent` and `terminate`. Invalid roots
or throwing accessors therefore stay unknown rather than becoming Pi's synthetic
known errors. The after-hook still validates final assembly before `finishTool`.

Pi catches hook errors and may resolve `prompt()` after failure. Explicit runtime
latches, subscription gates, wrapped effect/model functions, writer checks, and
abort signals therefore enforce stopping independently. A database, provider,
integrity, or cancellation failure invalidates that runtime instance. A tool throw
stops the current Pi attempt, suppresses its synthesized results, and starts a
fresh Agent only after durable recovery observations exist.

A thrown effect or absent durable outcome is conservatively unknown. Recovery
records `outcome-unknown` for an intent without outcome, and `not-started` when no
intent exists. These are operation-specific facts visible to the model, not a
whole-cognition blocker. A saved outcome missing its transcript append is restored
exactly, including timestamps. Original tool calls and known results remain in
PostgreSQL; only unresolved protocol tool-call blocks are omitted from the
disposable projection. If that removal empties an assistant message, only its
provider-facing message is omitted; the source entry and provenance ID remain.
No success/failure `toolResult` is fabricated. Read-only
checks and deliberate new-ID operations may be chosen by the main model from
that context. Reused call IDs remain structural errors, including after compaction.
This does not claim exactly-once remote effects: an operation may finish after
ownership loss if it ignores cancellation.

The existing envelope v1 / Pi 1.0.2 stream has a narrow custom-message extension:
public Pi `custom_message`, with `customType: "mira.recovery-observation.v1"`,
`display: true`, canonical explanatory content, and details `{version: 1,
operations: [...]}`. Each operation contains its call ID, original assistant
record ID, tool name, requested arguments, status, and validated execution arguments
when an intent exists. Not-started describes an interrupted recorded call without
an intent; it is not an authorization-denial decision.
The decoder rejects other custom types/versions and malformed observations;
recovery verifies every reference, status, argument, and batch position against
the authority. Only the current observation format is supported; this change adds
no old-format compatibility parser, history rewrite, or migration.

An outcome-unknown operation may additionally contain a strict optional
`diagnostic: {phase, category}`. Supported pairs are `execute/execution-rejected`,
`execute/event-content-conflict`, `result/invalid-json-result`, and
`result/non-finite-result`. Text comes only from fixed runtime-owned explanations;
raw exceptions, causes, headers, arguments and rejected result snippets are never
diagnostic fields. The diagnostic has exactly two keys, allowlisted values and
a 96-byte JSON limit. Recovery validates its link to a real unknown intent;
not-started and known outcomes cannot carry it. Existing original arguments and
known result evidence remain unchanged. A result-serialization rejection stops
the attempt without `finishTool`, leaves outcome null, and records the diagnostic
before continuing with a fresh Agent. A crash before observation commit leaves no
diagnostic to recover. Compaction preserves the exact optional diagnostic through
the existing advisory. Persistence/finishTool/fencing failures remain fatal and
cannot promise an observation was saved. See [ADR 0015](../../docs/adr/0015-safe-tool-recovery-diagnostics.md).

Unknown envelope/runtime versions, malformed required message fields, unsupported
entry/message types, pending/deferred assistant states, mismatched execution
references, broken tool pairs, or invalid checkpoint boundaries fail closed and
need explicit migration/reconciliation. This version publishes only a linear
message/checkpoint/recovery-observation stream, with the versioned system metadata described below; importing unproven tool history is unsupported.
Unknown *defined JSON fields* are retained rather than whitelisted. Pi's optional
undefined object properties have no JSON representation and are omitted;
nonfinite numbers, functions, class instances, sparse arrays and cycles are rejected.

## Automatic context budget

`PiRuntimeOptions.autoCompaction` accepts `enabled`, `threshold`, `reserveTokens`
and `keepRecentTokens`. Defaults use the configured model:

- `enabled: true`
- `threshold: 0.8` of input budget (`contextWindow - reserveTokens`)
- `reserveTokens: min(model.maxTokens, max(512, floor(contextWindow * 0.1)), contextWindow - 1)`
- `keepRecentTokens: min(20000, floor(contextWindow * 0.2))`

Token estimates use Pi’s public estimator with protocol overhead and the exact
current tool declarations, including schemas. They are heuristics, not provider
tokenizer guarantees. The output reserve also caps actual model output. Invalid
limits fail explicitly; server demo and Web assembly inherit these defaults.
Their programmatic `DemoOptions` / `WebServiceOptions.autoCompaction` pass through
the same configuration; no new CLI/environment/UI switch is introduced.

Pressure also uses the latest successful response usage from the same model,
plus newly appended messages and genuine merged-system growth. The previous
request system is reconstructed from its original durable entries, preserving
older prompt snapshots that the provider projection removes. Timestamp or other
same-size prompt replacements therefore do not count the full persona twice;
larger environment/skill/tool sections still increase pressure after restart.
A checkpoint discards usage from all earlier source entries, including retained
tail assistants, and the full-request estimate includes its refreshed Memory.

At safe `prepareRequest`, after tool declarations, completed tool batches and
awaited durable appends, the runtime checks the current system/messages/tools.
When older history exists and the threshold is reached, it uses the same full
SDK compaction path as explicit `compact()`. Automatic candidates must strictly
reduce the request estimate and fit the input budget. Otherwise no compaction
checkpoint is published; no unbounded compaction loop or silent truncation is
used. An oversized request that cannot be compacted fails before provider use.

A recognized provider context-overflow result allows at most one compaction and
recovery retry per `run`, from durable state. Ordinary errors and a second
overflow fail. Recovery never repeats an already executed tool effect or erases
unknown execution facts. `enabled: false` disables automatic threshold/overflow
compaction; explicit `compact()` remains available and budgets remain enforced.

## Compaction and cancellation

The approved [`prompts/mira-compaction-v0.1.md`](prompts/mira-compaction-v0.1.md)
replaces Pi coding-summary instructions through the public `session_before_compact`
hook. One unified summary request handles `initial`, `update`, or `split_turn`,
including an existing summary in split-turn mode. Every response must complete
normally and contain nonempty text. Hook errors, cancellation, missing results and
invalid results fail closed; Pi catching a hook exception must not enable its
default summary fallback. This is a structural safety check, not a summary-quality
guarantee. The SDK still owns preparation, system-state preservation,
cut selection, checkpoint structure and projection. No private compaction code is copied. The compactor
has no tools, external resources, credential discovery, or model-network fallback.
It cannot modify Memory. A stale context version rejects publication.

The summary system contains the approved main instructions and one mode instruction.
A separate JSON user-data object carries `mode`, `persona_context`, `memory_snapshot`,
`previous_summary`, `source_messages`, `retained_tail`, `boundary`,
`summary_token_budget`, and `recovery_operations`. The persona is the full current
effective rendered reference, with a `MEMORY_STATE` placeholder rather than a
duplicate Memory body. Reference material is data, not new instructions or
authorization; persona examples must not become actual user history. Messages
retain original roles, existing source entry IDs and timestamps; hidden thinking
and provider internals are excluded. No History IDs are invented. Retained-tail
results must not be rewritten as events before the compaction boundary.

The summary input budget includes the entire summary system, reference/persona,
Memory, JSON data and protocol overhead, with an actual output cap. Oversized
input fails rather than silently trimming the persona or Memory. Final candidate
shrink/fit checks, legal tool pairing and exact unknown-operation recovery facts
remain independent of summary wording. See the dated adjustment in ADR 0016.
The SDK receives the sanitized snapshot with stable authoritative entry IDs. Exact
outstanding-operation evidence also accompanies summary requests, and is
rehydrated into later model projections if summary/tail selection omits its
original notice. Summary wording cannot erase unresolved execution facts.

The disposable SDK model has an unregistered per-compaction provider alias. Public
`ModelRuntime.getProvider` verifies its absence; Pi's public unknown-provider auth
path returns before credential, environment or auth-file resolution. The injected
stream wrapper always receives the caller's original complete model descriptor.
An unexpected SDK provider/auth result or alias in a candidate checkpoint aborts
publication. The alias is never registered or persisted, and the adapter does not
change process environment, monkeypatch the SDK, or copy private auth logic.

This isolation is deliberate: the SDK cannot supply built-in provider credentials,
provider-specific settings, catalog routing or a transport fallback for compaction.
The application-owned injected stream is responsible for explicitly configured
transport and authorization. The adapter's numeric token budgets, original model
API/limits, raw history, signatures and retained tail remain unchanged. Extending
this contract to SDK-managed auth or virtual/provider routing requires a separate
review and decision.

Cancellation before publication and before PostgreSQL dispatches COMMIT rolls
back the checkpoint. Once COMMIT has been dispatched it cannot be revoked;
a simultaneous cancellation or connection loss may have an uncertain response.
Always recover authoritative PostgreSQL state rather than assuming the candidate
was either committed or discarded. Previously committed history is never replaced.

## Validation

From repository root:

```sh
pnpm test
MIRA_TEST_DATABASE_URL=postgresql://mira:mira@127.0.0.1:5432/mira_test pnpm test:integration
pnpm check:all
```

`tests/unit/runtime.test.mts` and `tests/unit/live-tools.test.mts` are offline
fault-injection coverage, not database proof. The live-tool suite verifies
same-run activation and use, in-flight lifetime and stale-generation barriers, declared/executable
schema agreement, replacement/removal, durable intent before effect, cleanup, and
recovery. `tests/recovery/postgres-recovery.test.mts` requires an isolated real
PostgreSQL service and covers fresh-process recovery and crashes around a
synthetic local counter effect. The suite injects every model response and makes
no live model calls. Detailed limits and test setup are in
[`tests/recovery/README.md`](../../tests/recovery/README.md).
`tests/unit/tool-diagnostics.test.mts` adds strict reason/redaction/recovery and
failure-window coverage; `tests/recovery/tool-diagnostics.test.mts` requires the
isolated PostgreSQL gate and independent processes. Do not count it as passed
without running that gate for the exact code.

`tests/unit/compaction-continuity.test.mts` exercises deterministic mechanism
contracts, including prompt/mode selection, structured reference data and failure
boundaries. Synthetic summary outputs do not establish continuity quality. Six actual native
summary/continuation probes and independent review are documented in
[the quality report](../../docs/acceptance/compaction-continuity.md). Case 3 retains
a future-permission wording concern; case 4 drops source History IDs. The targeted
revocation and changed-tail follow-ups do not eliminate those limitations. These
are separate from offline/PostgreSQL tests and do not establish production-provider,
exact-token-budget, real-tool or repeated-compaction behavior.

## Ordinary Memory bootstrap and history tools

`miraPrompt.loadMemory(signal)` loads Memory for a genuinely empty version-zero
durable stream, then once before each compaction summary. Initial text
is persisted as `miraMemory` before the first input/model call. Each compaction
uses that immutable candidate snapshot for summarization and publishes the same
Memory/system, summary and recent tail together in one fenced
CAS checkpoint. Recovery, new runtime instances, ordinary requests/wakes and file
changes reuse the latest persisted snapshot. No old `loadInitialMemory` alias,
memory-change notices, new Wakes, separate `initialContext` entrypoint or
destructive rebuild API exists.

`createHistoryTools(reader)` registers `history_search` and `history_read` against an assembly-bound Mira reader. It returns original record provenance without interpreting Pi inside persistence. Each History result carries a global UUID; `history_read({id})` obtains kind from the identity registry. Use the UUID directly from a search hit, context/Wake reference, or Memory `History-Id` trailer; external event IDs/provider call IDs are separate. Full-text prefix/Chinese limitations and exact-read byte budgets are included in tool descriptions. Pi compaction gives only the new candidate a full UUID, retaining existing parent/first-kept IDs and raw evidence. Expected bounded-query errors become explicit tool results; database faults remain faults. Ordinary Pi file/bash tools are composed by the server without cwd confinement. The existing intent/effect boundary still applies.


## Complete Mira system prompt

The server always provides `miraPrompt`, including when Memory is unconfigured.
The optional runtime configuration has `memoryRoot?`, `extensionsRoot?`, required
`environmentContext` and `authorizationContext`, plus `loadMemory?` and
`now?`. The server uses the configured generated-artifact directory for the
Extensions Workspace field and describes this limited meaning in the environment
text; it does not invent a universal extension directory.

`prompts/mira-system-v0.3.md` is the user-approved current template revision, checked
by SHA-256 when loaded. It adds a fixed `<persona>` section after `<identity>` whose
`{{PERSONA}}` value is the user-configured profile frozen by the host for one Wake, or
`MIRA_DEFAULT_PERSONA` (ADR 0046). `mira-system-v0.2.md` and the earlier revisions remain
recoverable history; their snapshots carry exactly the seven legacy keys, v0.3 snapshots
exactly eight. `renderMiraPrompt` validates the allowlisted keys used in nine locations, replaces them once and escapes `&`, `<` and `>` in runtime data.
Template-looking text inside values stays literal. Required values and unknown or
missing template placeholders fail explicitly. Unconfigured roots are represented
as `Not configured`. See [source manifest](../../docs/design/sources.json).

Before the actual provider request, public Pi system section `mira.system.v0.2`
is rendered from current time, the latest persisted Memory snapshot, explicit
environment/authorization context, and the names/descriptions of exactly the
registry already declared for that request. Updates append durable system records
under writer fencing/CAS and replace the named section rather than accumulating
full prompts. A full completed tool batch may publish new tools at its next
natural request; guidance-only changes create neither a Wake nor an extra model
call. Provider/model/sampling settings are not Prompt fields. Authorization context
is factual input to the main model's call-or-clarify decision, not an independent
approval. Technical schema/parameter checks, immutable intent/outcome, provenance,
call-ID uniqueness, and writer fencing/CAS still apply.

The initial system record has `{ role: "system", content: "", timestamp,
miraMemory: string }` and stores initial Memory text. `loadMemory` also runs once
before a compaction summary; the same frozen snapshot is used in the final
checkpoint, even if the file changes while summarization is running. Recovery
uses the latest committed Memory snapshot. Later named-section revisions use
ordinary append-only updates, with one current prompt in the active projection.
Compaction validates the exact prepared system, then refreshes only its Memory
value using persisted rendering metadata; the prepared skill catalog and other
sections remain intact. A failed read, cancellation or stale CAS cannot publish
a partial Memory/system refresh. Compacting Memory-bearing durable context
without `miraPrompt` rejects rather than silently retaining stale Memory.

This early-development implementation supports the current v0.5/v0.2 design
only. It has no old State configuration, bootstrap parser, prompt installation
migration, historical checkpoint transform, or separate initialization entrypoint.
Source archives remain provenance, not runtime compatibility contracts. This does
not introduce a user-data cleanup/reset API or weaken current durable history,
restart/compaction, tool recovery, or Memory Git integrity.

Ordinary requests/Wake/restart/file changes never reload Memory; successful
compaction atomically refreshes its snapshot. Terminal
empty assistant output can durably finish a silent Wake. This integration is
verified with injected fake providers; it does not demonstrate live-model
personality or natural-language consent quality. Current policy is in
[ADR 0006](../../docs/adr/0006-memory-only-system-prompt.md) and
[ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md) and
[ADR 0016](../../docs/adr/0016-automatic-compaction-memory-refresh.md).

Memory snapshots also persist whether a loader was configured, including when its
content was empty. A configured stream cannot compact with a missing loader; this
is rejected before summarization. Adopting a loader from an unconfigured stream
is committed with the checkpoint. Recovery validates the full Memory/prompt chain
before writing any tool-outcome or recovery-observation repairs.

## Extension observations

`loadContextProviders(signal)` requires `miraPrompt` and returns sourced
`ContextProviderSample[]` for the current prepared activation snapshot. It runs
once in each natural `prepareRequest`, alongside Skills metadata. Runtime validates
bounded JSON, provenance shape and unique extension/provider identities, then
adds clearly labeled observation data to `OTHER_ENVIRONMENT_CONTEXT`. Existing
single-pass escaping, persisted system snapshots and writer/CAS happen before the
actual provider request. No extra Wake, Memory load, hidden authorization gate or
semantic state is introduced. Recovery/compaction preserve frozen observations;
the next natural request replaces them, including removal or explicit failure.
See [ADR 0019](../../docs/adr/0019-extension-context-providers.md).

## Durable attachments

See ADR 0021. User-message `miraAttachments` is validated metadata, compared during
Wake recovery. Images are hydrated only for a model declaring image input. Built-in
Google Gemini MP4/WebM only after an explicit ordinary read tool result uses request-local `miraNativeVideos` consumed by the server's
existing transport; that property is explicitly forbidden in durable records.
Video user input always stays an ordinary file reference; only explicit read may hydrate video. Other models receive an explicit unviewed-media notice for that read, and documents stay file references. The 12 MiB inline media budget is separate from file storage limits;
over-budget context gets an explicit unviewed-media notice rather than a permanently
blocked Wake. No media bytes enter compaction. Attachment compaction requires the
`writeOverflowInput` callback already used for ordinary Wake spool files (the Web
and demo assemblies provide it). It writes one immutable, pretty-printed index
node containing only current source references and the previous index-file pointer.
Overflow sources reuse their typed original `miraOverflowInput` pointer; other
sources retain exact current attachment metadata. The checkpoint stores validated
`miraAttachmentIndex` metadata and a short ordinary-read instruction in its summary.
Repeated compaction never copies the lifetime index or frozen Memory into these
files, and does not rely on a potentially oversized `history_read` envelope.
Publication remains fenced after the file write; write, cancellation, ownership,
byte-count or CAS failures cannot publish the checkpoint. Completed derived files
are retained, with no automatic cleanup or additional storage service. Missing files
produce ordinary read errors; file contents remain source material, not authority.

### Live user steering

With a `LiveInputWriter`, durable Wake execution yields an in-flight model request
when committed user input arrives. The current single tool is allowed to finish;
its old batch's remaining calls are recorded as not-started and never replayed.
The next model request receives ordered persisted input, including attachments.
Compaction uses its frozen candidate; inputs arriving during summary are consumed
after checkpoint publication and before the natural request. There is no pause
button or intent classifier. See [ADR 0024](../../docs/adr/0024-live-user-input.md).

Task-scoped runtimes may use `loadSkills` without `miraPrompt`. The same public
formatter publishes a standalone `mira.skills.v1` system section at each natural
request through the child's fenced transcript. This does not load main Memory,
render Mira's persona, or read skill bodies; ordinary read/bash remain explicit.
## Task-scoped workers

`freezeSubagentContext` produces a bounded, role-labelled textual snapshot of the
current Pi projection (existing summaries retained, hidden reasoning/provider
metadata excluded). It rejects oversized snapshots instead of silently truncating.
Worker assembly uses `PiDurableRuntime.continueTaskTurn` with an independent
PostgreSQL task-boundary writer (ADR 0039);
no parent tool call is inserted into the child's protocol. See ADR 0025.

## Public task activity observations

Optional awaited `onActivity` reports content-free model and tool starts at their
actual dispatch gates, and finishes after durable transcript/outcome publication.
A thrown effect or missing durable outcome ends as unknown, never inferred as
running or known failure from an absent result. Model/tool arguments, hidden
reasoning, result payloads and raw errors are never supplied to this callback.
Observer write failures stop the runtime before further model/tool work. Child
assembly persists these observations under the parent writer and supplies the
separate `report_progress` tool for explicit public, bounded worker updates.
No timer, token-stream capture, or automatic parent Wake is added.

Task workers enable the normal automatic compaction budget with
`compactionScope: 'task'`. This selects the hash-checked task continuation prompt
in the same SDK hook and rejects main `miraPrompt`/Memory configuration. Summary
failure or cancellation preserves history and requires an explicit followup;
queued followups stay outside the frozen summary candidate. Child checkpoints
never enter main-stream Dreaming counts. See [ADR 0030](../../docs/adr/0030-task-scoped-compaction.md).

Compaction emits the same awaited content-free model activity with the fixed
`context-compaction` name, starting at actual summary dispatch and finishing
after authoritative checkpoint confirmation, including cancellation/append ambiguity.
It allocates the candidate History UUID before dispatch and includes that internal
`checkpointId` only on summary observations. Even a permanently stopped child writer
emits a final observation so the parent can independently confirm the exact checkpoint;
startup and bounded reads can also resolve a missing callback from the registered
identity. Public child DTOs omit this link; the turn's cancellation/interruption is
independent from whether its summary checkpoint committed.

## Configured reasoning

`PiRuntimeOptions.thinkingLevel` defaults to `medium` and is adapted through Pi 1.0.2 public model capabilities before being explicitly installed in `Agent.initialState`. Non-reasoning models use `off`. Summary hooks independently select the lowest supported level, normally `off`, rather than inheriting conversation effort. This applies to the same runtime used by main, child and Dreaming; there is no model-selected escalation or extra request. See [ADR 0027](../../docs/adr/0027-configured-reasoning-levels.md).

## Unified tool-result text budget

All tool paths use a 16,384 UTF-8 byte budget per result's combined model-facing
text, including SDK newline joins and its explicit partial-preview/reference notice. Full normalized
outcomes and exact transcript JSON are still persisted first, including all defined
opaque fields, images, attachment metadata, `structuredContent` and `terminate`.
`normalizeToolResult` remains a shape validator, not a truncator. The existing
Pi bash truncation/full-file behavior is unchanged.

Oversized active results require `writeOverflowInput`. The complete canonical
result JSON is encoded as small ordered JSONL string chunks in an existing
immutable ordinary-file spool; join decoded `text` values after the header to
reconstruct the exact original. This also makes giant single-line results readable
with normal `read` line pagination. The notice supplies the path, file size,
original History UUID and initial `offset=1, limit=3` guidance. No special reader,
new database table or replacement state store is added. Stable spool keys preserve
existing paths; only keys above the writer's 4,096-character limit use a distinct
SHA-256 namespace over the JSON-encoded Mira ID and History UUID pair, so arbitrary
valid Mira IDs remain recoverable.

Only adjacent plain `type`/`text` blocks in oversized previews are coalesced, before
hydration assigns media slots. Opaque-field blocks and non-text blocks retain their
fields and relative order; the canonical original block list is preserved exactly.
If unmergeable separator/reference overhead cannot fit, dispatch fails explicitly.
Hydrated annotations and every remaining join separator also count toward the cap;
native-video indices are never changed at that final boundary.

Recovery validates/repairs the full durable evidence before deriving the bounded
projection. A fresh runtime restores even compacted-out result files; active
references are verified on every projection, while archived files are checked once
per instance to avoid repeated lifetime file I/O. Missing files are reconstructed,
conflicts fail without overwrite, and spool failure never fabricates an unknown effect or replays a known one.
Compaction and candidate budget checks use the same projection; originals stay
unchanged in History. Non-text content keeps the existing media rules. Aggregate
request budgets still apply separately. See [ADR 0028](../../docs/adr/0028-tool-output-budget.md).

`history_read({id,offset:0})` opts into bounded JSON-text pages, including originals
above 1 MiB. Copy `nextOffset` and the first-page `revision`; concatenate page text
in order. Offsets count Unicode code points. Paged `maxBytes` defaults to 4096,
range 4..65536; omission of `offset` keeps the original complete-read behavior.
A source revision change requires restarting at zero, never joining stale pages.

The 16 KiB tool text cap also applies after request-local media hydration. Its
omission notices and media-reference slots remain intact; only original preview
text is shortened, without moving native-video indices or persisting hydrated
base64. Canonical near-limit media results reserve possible annotation space when
deciding whether they need evidence files, so those files remain reconstructible
after compaction/model changes. Annotations that cannot fit fail before dispatch.
History text-page envelopes omit unbounded original Mira/timestamp strings; their
exact values remain inside the lossless paged JSON text.

### Delegation guidance and published prompt revisions

[ADR 0038](../../docs/adr/0038-delegation-first-prompt.md) adds main-only guidance
to delegate substantial independent work while remaining responsive and owning
result review. New prompt snapshots include their `templateSha256`. Missing
identity refers only to the hash-checked pre-delegation v0.2 resource; known
revisions validate against their own immutable bytes, and unknown identities or
mismatched text fail closed. Normal request preparation appends the current
revision before provider execution using the existing frozen Memory. Recovery
never rewrites history or reloads Memory, and compaction preserves the preceding
template identity. A new process uses the new prompt on its first normal main
request; editing source files does not hot-reload an already running process.

[ADR 0044](../../docs/adr/0044-task-communication-prompt.md) adds brief execution
acknowledgement and meaningful task updates. The pre-communication delegation
template is also retained with its published hash. All three identities use the
same validation/upgrade rules. Main assistant text accompanying tools is already
persisted before execution and projected to Timeline; no token streaming or new
messages during a single in-flight tool are introduced. See the separate
[behavior and delivery evidence](../../docs/acceptance/task-communication-prompt.md).

## Quoted message replies

Versioned Web inputs persist `miraReplySources` and `miraReplies` for original
Wake and ordered live inputs. Recovery validates the metadata against each
immutable source event, including finalized links. Successful `send_reply`
results retain strict `reply-publication` details and attachment references;
server tool text renders the quote for actual provider requests. No assistant
signed content is rewritten to add IDs.

Main compaction adds a deterministic `miraReplyIndex` ordinary-file pointer and
a fixed notice, independently of the summary model. Line-pageable index nodes
retain bounded source snapshots, original roles, source attribution, explicit
reply links and the prior node pointer. Tool publications are identified by
provider call ID plus their containing transcript History ID, never by falsely
using that container UUID as the public tool-operation Timeline ID. Recovery
reconstructs missing index nodes from persisted records and prior pointers;
conflicting paths, bytes or notices fail closed. Summary requests keep metadata
counts rather than reinflating large offloaded batches. Task compaction does not
create main Timeline reply indexes.

Offline `tests/unit/reply-context.test.mts` covers original/live/restart,
pre-feature byte preservation, Unicode bounds, repeated compaction, actual
provider index notices and missing-file reconstruction. The separate
`tests/recovery/reply-context.test.mts` requires isolated PostgreSQL and checks
real persistence, writer restart and reconstruction; synthetic providers do not
establish live-model behavior.
