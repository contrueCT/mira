# Activation and teardown

The [host README](../../../packages/extension-host/README.md) and
[implementation](../../../packages/extension-host/src/index.ts) define the current
Cordis behavior. Do not substitute an imagined generic plugin lifecycle.

## One generation owns its resources

`apply` may be async. Validate config, obtain required services, and register tools,
services, listeners, timers, and cleanup while that activation is live. Resource
creation is fenced once unloading starts. Existing service reads, `publish`, and
event/Wake submission remain usable by the leased generation until its cleanup
finishes. Do not retain the context for use after retirement.

The host publishes a complete immutable registry for each model/tool batch. The
whole batch leases its generations, including tools not currently executing.
Queued changes take effect only after the previous batch releases; the next
`prepare()` waits for known lifecycle work before publishing the new registry.
`finish()` releases a terminal/error batch. These are host operations, not SDK calls.
A tool must not wait for a management change that requires its own batch to end.
Return the accepted receipt, then inspect after a natural batch boundary.

On provider teardown, the host withdraws provided services and drains dependent
generations before stopping provider timers/listeners. User cleanup runs after
those registered resources drain. This allows a still-leased consumer to finish
using the service. Consumers should capture their service in `apply`; providers
must leave its underlying resource usable until their cleanup runs.

Cordis cannot find detached work. For every async timer/listener operation:

1. Register cleanup before starting it
2. Retain the promise and attach rejection handling immediately
3. Serialize or explicitly bound overlap; an interval's `void` callback does not
   await a returned promise
4. Stop new starts, cancel using a signal or native close operation, then join the
   promise before releasing state it uses
5. Preserve observable failure information. Expected cancellation is different
   from a poll, delivery, or actual resource-release failure

For sockets/watchers, unregister listeners and close the resource in cleanup;
await closure and any work already in progress. Respect cancellation in the
underlying I/O. If it ignores cancellation and never settles, joining cannot finish;
fix the adapter or its real I/O timeout rather than declaring cleanup complete.
Cleanup errors appear in diagnostics/receipts. Source code should not swallow them
or claim teardown succeeded. Import-time side effects cannot be scoped by `apply`.

## Example watcher

[watch-and-wake.ts](../examples/watch-and-wake.ts) is a default-exported extension
requiring a `watch-source` service. Implement that provider for the requested data
source using its authorized access; the example itself has no network or credentials.
Copy the example into an ordinary template workspace and keep its SDK package import.
Supply `{ "intervalMilliseconds": 60000, "targetStatus": "failed",
"statusToolName": "watch_status" }` or task-specific values. Choose a unique tool
name per installed watcher. Delays must be integers from 1 to 2147483647
milliseconds; larger values would be clamped by Node timers, causing rapid polling.

The `WatchSource` interface specifies stable source/record/revision IDs and source
occurrence time. `poll(signal)` must honor abort and return a bounded batch of
observations. The example captures that service, skips interval ticks while busy,
software-matches a configured status, and uses stable event/Wake IDs across retries.
It records nonmatches with `emitEvent`; matches go directly through `requestWake`.
If durable ingestion succeeded but the response was lost, re-observing the same
fact is safe for this ingestion path. This does not generalize to arbitrary effects.

A failed batch stops at its first failure; the source must return undelivered facts
again, rather than irreversibly acknowledging them during `poll`. The example keeps
no durable cursor and does not promise delivery if the source drops records. It also
revisits already ingested observations and relies on host deduplication. A changed
filter does not retroactively Wake on a fact already saved as a nonmatch; define a
separate reconsideration event if the user's task actually needs that behavior.

Its configurable status tool reports completion/failure counts and the failed
phase without source data or exception messages, which may contain secrets. It
does not request a Wake every time polling fails. Choose any failure-notification
policy according to the actual task. Pending delivery cannot be aborted by the SDK,
so cleanup joins it; aborting only controls the source operation. The deterministic
[tests](../../../tests/unit/extension-authoring-example.test.mts) exercise these
contracts without timers sleeping, accounts, live models, or network calls.

## HMR and generated versions

Manual HMR uses official Cordis file watching and Node 24 `--expose-internals`.
Tracked transitive ESM and CJS imported through ESM reload; nested CJS `require()`
edges are not tracked. Change the tracked entry or restart for those edges. File
watching is asynchronous, not an activation barrier. Manual `reload` restarts the
currently imported module; it is not cache invalidation. Framework dependency edits
can make upstream Loader exit the process; do not promise an in-process recovery.

Import/validation failure can preserve an old instance. Apply failure occurs after
old disposal and is not atomic rollback. Inspect the actual tools, activation and
diagnostics. The host exposes waiting/loading/active/failed/unloading/disposed,
plus disabled/import-failed states; `waiting` usually means a missing service.

Generated files are excluded from HMR. Every activation/reload uses a fresh complete
copy with new module paths, including local dependencies. Update is explicit;
editing a source workspace does not change an active release. A saved rollback
revision selects old code and config in another fresh activation and preserves the
current enabled state. It does not reverse files sent, emails, or other external
effects. Follow [workflow](workflow.md) for state and receipt inspection.
