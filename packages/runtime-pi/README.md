# Pi durable runtime

This adapter uses the pinned public `@earendil-works/pi-agent-core`, `pi-ai`, and
`pi-coding-agent` APIs at `1.0.2`. PostgreSQL through `@mira/life`'s `DurableWriter`
is the sole authority. No session JSONL file is written. This is the recovery and
compaction foundation, not a complete Mira server or Wake scheduler.

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
- `compact(options?)` snapshots the authority, runs full public SDK compaction in
  a disposable in-memory session, and conditionally publishes its exact checkpoint
- `encodeEntry`, `decodeRecords`, `messageEntry`, and `jsonValue` implement the
  adapter's structured JSON boundary

Authorization is mandatory before intent and execution. The callback must return
explicit allowance plus JSON evidence or denial. This is an integration boundary,
not a natural-language consent resolver, security sandbox, or proof that the
caller-provided authorization policy is correct. Side-effecting `prepareArguments`
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
abort signals therefore enforce stopping independently. Every failed runtime
instance must be discarded; create a new instance and recover the database.

A thrown effect or absent outcome is conservatively unknown. Recovery refuses
model and tool execution until reconciliation, with no automatic retry. A saved
outcome with a missing transcript append can be materialized exactly without
repeating the effect. An incomplete multi-call batch whose later calls lack
outcomes also blocks recovery. Reused call IDs are rejected even with Pi's
`replay: "never"` metadata. This does not claim exactly-once remote side effects;
an effect already started may ignore cancellation and finish after ownership loss.

Unknown envelope/runtime versions, malformed required message fields, unsupported
entry/message types, pending/deferred assistant states, mismatched execution
references, broken tool pairs, or invalid checkpoint boundaries fail closed and
need explicit migration/reconciliation. This version publishes only a linear
message/checkpoint stream; importing unproven tool history is unsupported.
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
