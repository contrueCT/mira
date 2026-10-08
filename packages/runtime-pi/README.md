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
See [ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md).

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
and compaction do not scan files: they preserve and verify the exact persisted
system, then the next natural model request may refresh its catalog. Skill files
are independent of the frozen initial Memory snapshot and Memory Git.

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

## Compaction and cancellation

Every summary response must complete normally and contain nonempty text, including
each split-turn response. This is a structural safety check, not a summary-quality
guarantee. The SDK owns preparation, repeated summary handling, system-state preservation,
cut selection and projection. No private compaction code is copied. The compactor
has no tools, external resources, credential discovery, or model-network fallback.
It cannot modify Memory. A stale context version rejects publication.
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

## Ordinary Memory bootstrap and history tools

`miraPrompt.loadInitialMemory(signal)` loads Memory only for a genuinely empty
version-zero durable stream. Its text is persisted as the frozen `miraMemory`
snapshot before the first input/model call. Recovery, new runtime instances,
ordinary wakes, file changes and compaction reuse that snapshot. No automatic
memory-change notices or new Wakes exist. There is no separate `initialContext`
entrypoint or destructive rebuild API.

`createHistoryTools(reader)` registers `history_search` and `history_read` against an assembly-bound Mira reader. It returns original record provenance without interpreting Pi inside persistence. Each History result carries a global UUID; `history_read({id})` obtains kind from the identity registry. Use the UUID directly from a search hit, context/Wake reference, or Memory `History-Id` trailer; external event IDs/provider call IDs are separate. Full-text prefix/Chinese limitations and exact-read byte budgets are included in tool descriptions. Pi compaction gives only the new candidate a full UUID, retaining existing parent/first-kept IDs and raw evidence. Expected bounded-query errors become explicit tool results; database faults remain faults. Ordinary Pi file/bash tools are composed by the server without cwd confinement. The existing intent/effect boundary still applies.


## Complete Mira system prompt

The server always provides `miraPrompt`, including when Memory is unconfigured.
The optional runtime configuration has `memoryRoot?`, `extensionsRoot?`, required
`environmentContext` and `authorizationContext`, plus `loadInitialMemory?` and
`now?`. The server uses the configured generated-artifact directory for the
Extensions Workspace field and describes this limited meaning in the environment
text; it does not invent a universal extension directory.

`prompts/mira-system-v0.2.md` is the user-approved current template revision, checked
by SHA-256 when loaded. `renderMiraPrompt` validates seven allowlisted keys used in
eight locations, replaces them once and escapes `&`, `<` and `>` in runtime data.
Template-looking text inside values stays literal. Required values and unknown or
missing template placeholders fail explicitly. Unconfigured roots are represented
as `Not configured`. See [source manifest](../../docs/design/sources.json).

Before the actual provider request, public Pi system section `mira.system.v0.2`
is rendered from current time, the persisted Memory bootstrap snapshot, explicit
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
miraMemory: string }` and stores the frozen Memory text. Only a genuinely empty
version-zero stream calls `loadInitialMemory`; recovery reads the snapshot from
the first record. Later named-section revisions use ordinary append-only updates,
with one current prompt in the active projection. Compaction retains the exact
current system and normal checkpoint consistency checks.

This early-development implementation supports the current v0.5/v0.2 design
only. It has no old State configuration, bootstrap parser, prompt installation
migration, historical checkpoint transform, or separate initialization entrypoint.
Source archives remain provenance, not runtime compatibility contracts. This does
not introduce a user-data cleanup/reset API or weaken current durable history,
restart/compaction, tool recovery, or Memory Git integrity.

Ordinary Wake/restart/compaction/file changes never reload the snapshot. Terminal
empty assistant output can durably finish a silent Wake. This integration is
verified with injected fake providers; it does not demonstrate live-model
personality or natural-language consent quality. Current policy is in
[ADR 0006](../../docs/adr/0006-memory-only-system-prompt.md) and
[ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md).
