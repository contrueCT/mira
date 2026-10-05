# PostgreSQL durable context

`@mira/persistence` implements the core-owned `DurableWriter` contract with `pg` 8.23.1. `node-pg-migrate` 9.0.0 owns SQL migration history and up/down execution. No ORM, model client, or Pi interpretation is used here.

## API

```ts
import { migrate, PostgresPersistence } from '@mira/persistence';
await migrate({ connectionString, direction: 'up' });
const store = new PostgresPersistence({ connectionString });
const writer = await store.acquire('mira');
try {
  const snapshot = await writer.load();
  // The runtime validates its opaque payload; records are never reconstructed here.
} finally {
  await writer.close();
}
```

A connection string is mandatory; environment/default database discovery is not used. Optional `schema` uses a restricted SQL identifier, and `applicationName` labels ownership clients in PostgreSQL activity. Run migrations as an explicit administrative step. `migrate({ connectionString, direction: 'down' })` is destructive, removes this slice's durable data, and is never called by the adapter automatically.

## Ownership and transactions

- Each writer owns one dedicated `pg.Client` and one session advisory lock for its full lifetime. Transaction-pooling proxies are unsupported; use direct PostgreSQL or session pooling
- A table-generated unique integer key, never a Mira-ID hash, identifies the lock. Initial registry insertion is separately protected by a global session advisory lock. Subsequent ownership acquisition does not consume new keys
- Acquiring an available lock increments a durable epoch. All record, receipt, intent and outcome writes use the exact locked connection
- The actual `pg_locks` session entry and epoch are checked before protected work and again before commit. Operations on one writer serialize short transactions. Models, tools and network effects run outside these transactions
- Connection error/end, missing lock, changed epoch or unknown database failure latches the writer's abort signal. A stopped writer never reconnects itself. Acquire a new owner, load history and reconcile uncertain executions before proceeding
- `assertActive()` is a synchronous local latch check; `verifyActive()` performs a database ownership check. Observe `signal` during work and verify again immediately before an external effect. Database fencing cannot revoke a remote request already sent or guarantee exactly-once effects
- Tables in different schemas share advisory-lock namespaces, so independent installations in one database can conservatively contend on equal registry keys. Use separate databases for independent installations

## Durable semantics

- `append(expectedVersion, record, optionalSignal)` inserts an immutable envelope and atomically advances version/head by CAS. Parent IDs form one append-only chain; duplicates and wrong parents are rejected
- A caller cancellation is checked before dispatch, before mutations and immediately before COMMIT. Cancellation observed before commit rolls back without stopping a healthy owner. Cancellation or connection loss after COMMIT dispatch can have an uncertain outcome; recover the authoritative database history before deciding what to do, never assume rollback
- `load()` returns all exact JSON envelopes and incremental tool executions. It validates chain/version metadata and rejects unknown envelope versions instead of dropping/rebuilding history. Runtime-specific payload validation remains in the runtime adapter
- `receive(event, optionalWake)` atomically records an event and optional wake. An event without a wake adds no wake and never invokes a model. A duplicate requires identical structured JSON, event metadata and wake choice; ID reuse with different data is rejected
- `beginTool(expectedVersion, intent)` records authorization, raw requested arguments, normalized execution arguments and a persisted message reference before execution. The runtime is responsible for proving that message contains the assistant tool call. Duplicate call IDs always fail, including previously completed ones
- `finishTool(outcome)` records only the first outcome. Missing outcomes remain unresolved and are not replayed automatically. This slice does not implement an external-delivery outbox or an automatic reconciliation executor
- JSON columns retain complete serialized envelopes/provider fields; the adapter does not replace messages with text. Returned objects are ordinary JSON copies, not references to mutable adapter state

## Verification

```sh
pnpm typecheck
pnpm boundaries
MIRA_TEST_DATABASE_URL=postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test pnpm test:integration
```

The integration command requires an explicit local `mira_test` database and PostgreSQL 18.6 (CI uses the official image). The test helper rejects missing URLs, remote hosts, other database names and URL query parameters; each fixture creates/drops a unique synthetic schema. It is never appropriate to provide a production URL. Tests include migration rollback, restart, duplicate IDs, transaction rollback, actual session-lock loss, backend termination, and ownership contention across OS processes. Missing PostgreSQL is a failure, never a silently skipped success.
