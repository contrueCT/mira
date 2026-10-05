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
disposable projection. No success/failure `toolResult` is fabricated. Read-only
checks and deliberate new-ID operations may proceed under the normal decision
callback. Reused call IDs remain structural errors, including after compaction.
This does not claim exactly-once remote effects: an operation may finish after
ownership loss if it ignores cancellation.

The existing envelope v1 / Pi 1.0.2 stream has one narrow additive extension:
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
message/checkpoint/recovery-observation stream; importing unproven tool history is unsupported.
Unknown *defined JSON fields* are retained rather than whitelisted. Pi's optional
undefined object properties have no JSON representation and are omitted;
nonfinite numbers, functions, class instances, sparse arrays and cycles are rejected.

## Compaction and cancellation

Every summary response must complete normally and contain nonempty text, including
each split-turn response. This is a structural safety check, not a summary-quality
guarantee. The SDK owns preparation, repeated summary handling, system-state preservation,
cut selection and projection. No private compaction code is copied. The compactor
has no tools, external resources, credential discovery, or model-network fallback.
It cannot modify Memory or State. A stale context version rejects publication.
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

`tests/unit/runtime.test.mts` is offline fault-injection coverage, not database
proof. `tests/recovery/postgres-recovery.test.mts` requires an isolated real
PostgreSQL service and covers fresh-process recovery and crashes around a
synthetic local counter effect. The suite injects every model response and makes
no live model calls. Detailed limits and test setup are in
[`tests/recovery/README.md`](../../tests/recovery/README.md).
