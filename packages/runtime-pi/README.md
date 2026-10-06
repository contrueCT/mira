# Pi durable runtime

This adapter uses the pinned public `@earendil-works/pi-agent-core`, `pi-ai`, and
`pi-coding-agent` APIs at `1.0.2`. PostgreSQL through `@mira/life`'s `DurableWriter`
is the sole authority. No session JSONL file is written. This is the recovery and
compaction adapter, including the cognition contract used by the Wake scheduler.

## Public boundary

`PiDurableRuntime` requires a writer, a model descriptor, an injected `streamFn`,
and a trusted `authorize` callback. Tools are rebound from the caller's registry;
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

Authorization is mandatory before intent and execution. The callback must return
an agent/application execution decision plus JSON evidence, or a reason to defer
the operation. The callback receives prior incomplete-operation evidence and the
current assistant narrative. Evidence can express natural-language user intent;
no approval button, approval-token format, tool risk class, or matching-arguments
veto is required. Deferral records why execution did not start and returns control
to cognition, which can ask the user or choose another action. Tool/web content is
not user authorization. This integration boundary is not a security sandbox or
proof that the caller-provided decision policy is correct. Side-effecting `prepareArguments`
callbacks are not supported. Pi's standard schema normalization/coercion is
preserved: durable intent records both the original requested arguments and the
validated arguments the callback approved and the tool receives.

## Live tool registries

`tools` remains a static registry for each runtime attempt. The optional
`prepareTools(signal): Promise<AgentTool[]>` instead returns the **complete** live
registry, including any built-ins. When provided, it replaces the static registry.
It may await pending extension activation or reload before returning its snapshot.
Duplicate names and `prepareArguments` are rejected for every prepared snapshot.
All dynamic tools use the same schema validation, natural-language authorization,
durable intent/outcome, sequential execution, and recovery path as static tools.

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

The adapter deep-copies declaration/validation schemas and constrained-sampling metadata for each published generation. A source must keep its
executable resources alive, through the full provider request and tool batch.
Replacement/removal is safe at the next preparation boundary; changing a registry
while the first sibling executes must not invalidate later siblings. The optional
`finishTools(): Promise<void>` releases the final snapshot on every attempt exit,
including cancellation, failed initial preparation, and interrupted attempts that
will recover. It is awaited exactly once per attempt that begins preparation and
must tolerate a preparation that failed before acquiring resources. The source
may drain pending lifecycle work there, but cleanup never requests another model
turn. A terminal assistant reply remains terminal.

Additions, schema/description changes, and removals use existing durable Pi
`toolsAdded`/`toolsRemoved` declarations. A code-only generation update with an
identical declaration cannot be inferred from serialized tool state: the host
must include a stable generation revision in the tool description when that
change should be visible to the model/history. No new history format, replay of
old operations, or automatic Wake is introduced. Recovering history only restores
declarations and operation evidence; executable functions still come from the
current caller-owned registry.

## Failure and recovery semantics

Tools execute sequentially. Awaited agent-core subscribers persist assistant
messages before execution and tool results before the next tool/model request.
The before-hook records authorized intent; the after-hook records the exact
normalized tool-result JSON with its chosen timestamp. The emitted tool-result
message is canonicalized to that saved JSON before append.

Pi catches hook errors and may resolve `prompt()` after failure. Explicit runtime
latches, subscription gates, wrapped effect/model functions, writer checks, and
abort signals therefore enforce stopping independently. A database, provider,
integrity, or cancellation failure invalidates that runtime instance. A tool throw
or application deferral stops the current Pi attempt, suppresses its synthesized
results, and starts a fresh Agent only after durable recovery observations exist.

A thrown effect or absent durable outcome is conservatively unknown. Recovery
records `outcome-unknown` for an intent without outcome, and `not-started` when no
intent exists. These are operation-specific facts visible to the model, not a
whole-cognition blocker. A saved outcome missing its transcript append is restored
exactly, including timestamps. Original tool calls and known results remain in
PostgreSQL; only unresolved protocol tool-call blocks are omitted from the
disposable projection. If that removal empties an assistant message, only its
provider-facing message is omitted; the source entry and provenance ID remain.
No success/failure `toolResult` is fabricated. Read-only
checks and deliberate new-ID operations may proceed under the normal decision
callback. Reused call IDs remain structural errors, including after compaction.
This does not claim exactly-once remote effects: an operation may finish after
ownership loss if it ignores cancellation.

The existing envelope v1 / Pi 1.0.2 stream has a narrow custom-message extension:
public Pi `custom_message`, with `customType: "mira.recovery-observation.v1"`,
`display: true`, canonical explanatory content, and details `{version: 1,
operations: [...]}`. Each operation contains its call ID, original assistant
record ID, tool name, requested arguments, status, and authorized arguments when
an intent exists. A not-started operation may carry an application defer reason.
The decoder rejects other custom types/versions and malformed observations;
recovery verifies every reference, status, argument, and batch position against
the authority. Existing valid v1 history remains readable, and prior readers fail
closed on the new custom entry rather than silently misinterpreting it.

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
same-run activation and use, full-batch lifetime barriers, declared/executable
schema agreement, replacement/removal, authorization, cleanup, and recovery. `tests/recovery/postgres-recovery.test.mts` requires an isolated real
PostgreSQL service and covers fresh-process recovery and crashes around a
synthetic local counter effect. The suite injects every model response and makes
no live model calls. Detailed limits and test setup are in
[`tests/recovery/README.md`](../../tests/recovery/README.md).

## Ordinary Memory bootstrap and history tools

`miraPrompt.loadInitialMemory(signal)` loads Memory only for a genuinely empty
version-zero durable stream. Its text is persisted as the frozen `miraMemory`
snapshot before the first input/model call. Recovery, new runtime instances,
ordinary wakes, file changes and compaction reuse that snapshot. No automatic
memory-change notices or new Wakes exist. There is no separate `initialContext`
entrypoint or destructive rebuild API.

`createHistoryTools(reader)` registers `history.search` and `history.read` against an assembly-bound Mira reader. It returns original record provenance without interpreting Pi inside persistence. Full-text prefix/Chinese limitations and exact-read byte budgets are included in tool descriptions. Expected bounded-query errors become explicit tool results; database faults remain faults. Ordinary Pi file/bash tools are composed by the server without cwd confinement. The existing intent/effect boundary still applies.


## Complete Mira system prompt

The server always provides `miraPrompt`, including when Memory is unconfigured.
The optional runtime configuration has `memoryRoot?`, `extensionsRoot?`, required
`environmentContext` and `authorizationContext`, plus `loadInitialMemory?` and
`now?`. The server uses the configured generated-artifact directory for the
Extensions Workspace field and describes this limited meaning in the environment
text; it does not invent a universal extension directory.

`prompts/mira-system-v0.2.md` is the byte-identical supplied template, checked by
SHA-256 when loaded. `renderMiraPrompt` validates seven allowlisted keys used in
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
call. Provider/model/sampling settings are not Prompt fields. Dynamic prose does
not grant permission: real tool schema validation and `authorize` still apply.

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
[ADR 0006](../../docs/adr/0006-memory-only-system-prompt.md).
