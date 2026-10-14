# PostgreSQL durable context

`@mira/persistence` implements the core-owned `MemoryCheckpointWriter` and read-only `HistoryReader` contracts with `pg` 8.23.1. `node-pg-migrate` 9.0.0 owns SQL migration history and up/down execution. No ORM, model client, or Pi interpretation is used here.

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

## Global History identity and fresh setup

`history_records(id UUID PRIMARY KEY, mira_id, kind)` owns one global UUID namespace for `event`, `context`, `tool`, and `wake`. Detail tables have composite identity/Mira/kind foreign keys; generated constant kind columns prevent attaching one identity to another detail type. A duplicate UUID cannot be reused across kinds or Miras. The identity reservation and detail write share the same fenced transaction, including rollback on cancellation, duplicate receipts and context CAS failures.

Context envelope IDs/parents and Wake run/input/final/checkpoint references are these UUIDs. Event and tool rows allocate separate internal History UUIDs; original `LifeEvent.id`, Wake receipt IDs, and provider `callId` remain unchanged external/idempotency/protocol identifiers. They are not History references. Wake membership exposes the event History UUID and separately named external event/receipt identities. Pi compaction replaces only the newly created candidate's short SDK ID with a full UUID and preserves every existing entry, parent, first-kept reference, and raw provider envelope.

This early-development revision defines the current schema directly. Start with a new empty database/schema and a fresh Mira data home/Memory workspace; do not point it at an earlier database or reuse earlier pending Memory checkpoints. Keep earlier data separately if needed. There is no old-database detection, conversion, mapping, alias resolver, compatibility parser, or automatic data cleanup. The program does not migrate earlier data into these IDs.

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
- `beginTool(expectedVersion, intent)` records raw requested arguments, normalized execution arguments and a persisted assistant message reference before execution. The immutable row context version and `assistantRecordId` preserve provenance; no authorization decision or replacement executionContext field is required. The runtime is responsible for proving that message contains the assistant tool call. Duplicate call IDs always fail, including previously completed ones
- `finishTool(outcome)` records only the first outcome, while the context version still equals the version saved by that call's `beginTool`. Persist the outcome before appending its transcript result; sequential siblings each begin at their own current version. A late outcome after context has advanced is rejected without changing history or stopping a healthy writer, because recovery may already have observed the execution as unknown. This is an immutable-evidence boundary, not an authorization decision about a newly proposed call. Missing outcomes remain unresolved and are not replayed automatically. This slice does not implement an external-delivery outbox or an automatic reconciliation executor
- JSON columns retain complete serialized envelopes/provider fields; the adapter does not replace messages with text. Returned objects are ordinary JSON copies, not references to mutable adapter state

`PersistenceError` retains its name/code and two-argument constructor. It now
extends the small core-owned `DurableOperationError`; an optional third category
tags only the exact event/Wake identity-content conflicts in `receive`. Ordinary
invalid/version/duplicate failures have no write-failure category and retain
their existing semantics. A stopped writer's signal and unknown transactional
faults carry `persistence-write-failure`. Consumers recognize real privately
branded instances rather than parsing external messages or SQL codes. Internal
causes/messages are not rendered as public or durable tool diagnostics. The Pi
adapter owns the optional reason in its existing recovery observation; this
adapter introduces no diagnostic table or runtime-payload parser. See
[ADR 0015](../../docs/adr/0015-safe-tool-recovery-diagnostics.md).

## Verification

```sh
pnpm typecheck
pnpm boundaries
MIRA_TEST_DATABASE_URL=postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test pnpm test:integration
```

The integration command requires an explicit local `mira_test` database and PostgreSQL 18.6 (CI uses the official image). The test helper rejects missing URLs, remote hosts, other database names and URL query parameters; each fixture creates/drops a unique synthetic schema. It is never appropriate to provide a production URL. Tests include migration rollback, restart, duplicate IDs, transaction rollback, actual session-lock loss, backend termination, and ownership contention across OS processes. Missing PostgreSQL is a failure, never a silently skipped success.

## 持久 Wake 队列

`acquire` 返回扩展 `WakeWriter` 的 `MemoryCheckpointWriter`。`claimWakeBatch` 在持锁连接的事务中返回已有活动 run，或将所有未分配请求一次归入新 run。`wake_run_requests` 关联不可修改，一个 Mira 只允许一个未完成 run。新请求按数据库 receipt 序号呈现，运行中到达的请求不加入当前批次。

`appendWakeInput` / `appendWakeFinal` 在同一事务追加上下文与关联；重复调用只接受相同记录和原始 expectedVersion，返回该记录本身的版本（不是后来上下文的版本）。`loadWakeRun` 核对批次与关联，`completeWakeRun` 要求输入/最终回复均已落库，可幂等重试。运行时仍须验证 Pi 输入与终止回复语义，持久化包不解释 Pi。

允许在 claim 后、输入前追加必要的旧上下文恢复记录。最终回复已绑定之后，必须先完成 run 才能追加其它上下文或开始工具。所有事务保持原连接锁、epoch、CAS，不跨模型或外部副作用。

## Memory 快照与 lineage

`acquire` 的 `MemoryCheckpointWriter` 扩展提供 `prepareMemoryCheckpoint`、`loadMemoryCheckpoint` 和 `finishMemoryCheckpoint`。不可变 checkpoint 包含 run、最终回复 ID、`preparedAt` 与适配器恢复输入 `payload`；只允许在最终回复已保存、run 尚未完成时首次准备。`preparedAt` 是准备意图时间，不声称 Git 已捕获文件。Memory 内容仍属于普通文件，不复制进这份 payload。

组装层先持久化 checkpoint，在事务外执行以 Mira/run 为键的可恢复 Memory Git 快照，再关联 `{ runId, commit }` receipt，最后完成 Wake。`commit` 支持完整 SHA-1/SHA-256 ID；`null` 明确记录没有 Memory 变化，与尚无 receipt 不同。Git 自身须保存同一 run 的不可变结果，确保 Git 成功而数据库未关联时能重取该结果，不重复提交或带入之后的文件修改。PostgreSQL 与 Git 没有跨系统原子保证。

checkpoint 与 receipt 由只追加表保护；相同输入可重试，替换恢复输入、重新关联不同 commit 或更改无变化结论均拒绝。存在待处理 checkpoint 时，`completeWakeRun` 与 SQL 触发器都禁止完成；`load`/Wake 恢复核对 final 关联和完成状态。所有方法沿用专用连接、实际锁与 epoch 检查。快照 lineage 只说明该 Wake 结束时观察到工作空间版本，不能据此声称全部变更由 agent 创作。

`migrate({direction:'down'})` 一次仅回滚一个迁移。当前八个迁移依次为原始上下文、Wake 队列、Memory lineage、History 索引、Dreaming progress、单次日程、用户补充输入、子代理；八次 down 才回到初始空库。History 索引回滚不删除原始记录，其它迁移回滚可能丢失数据，只能用于显式隔离测试，不能自动清理用户库。

## Read-only History

```ts
const history = store.history('mira'); // trusted assembly fixes the Mira scope
const matches = await history.search({ query: 'original phrase', limit: 20 });
const chinese = await history.search({ query: '顺德菜', mode: 'substring' });
const original = matches.hits[0] ? await history.read({ id: matches.hits[0].id }) : null;
const latest = await history.page({ kinds: ['event', 'context'], limit: 20 });
const older = latest.nextCursor
  ? await history.page({ kinds: ['event', 'context'], before: latest.nextCursor })
  : null;
```

- `history(miraId)` does not register the Mira, acquire ownership, advance an epoch, create a Wake, or call a model. Each operation opens an independent connection, runs one `BEGIN READ ONLY` transaction with a 5-second statement timeout, and closes it. The application must choose the authenticated Mira; this adapter is not an authentication layer
- Search supports `event`, `context`, `tool`, and `wake`; `kinds` narrows the sources. Every branch filters the fixed Mira, and query/ID values are SQL parameters. Every returned ID is globally unique across Miras and kinds; kind is result metadata, not part of lookup identity
- Default `full_text` uses PostgreSQL `simple` FTS, `plainto_tsquery` and GIN indexes. It is lexical search, not semantic search, stemming or Chinese word segmentation. All query tokens must match. JSON keys as well as values are searchable because original JSON is indexed without decoding runtime-specific payloads
- To avoid PostgreSQL's tsvector size limit rejecting a valid large history write, the FTS projection covers only the first 65,536 characters of each serialized document. Results explicitly report `fullTextPrefixChars: 65536`. Original data is never shortened. Extremely long unbroken tokens can also be omitted by PostgreSQL's parser
- `mode: 'substring'` explicitly scans the entire serialized original with literal, case-insensitive `strpos(lower(...), lower(query))`. It does not treat `%` or `_` as wildcards, perform Chinese segmentation, or silently follow a failed FTS search. This fallback is unindexed and can hit the statement timeout on large histories; its `fullTextPrefixChars` is `null`
- Event search includes the original event and requested Wake receipt; context search includes its original envelope; tool search includes original intent and optional outcome; Wake search covers run ID, claim timestamp, input/final IDs and status. Search results are ranked lexically then ordered deterministically by kind/ID, not by a reconstructed arrival time
- Query text is at most 1,024 UTF-8 bytes, limits are 1–100 (default 20), snippets at most 512 characters, and the complete search response at most 262,144 bytes. `hasMore` honestly signals additional matches; there is no unstable offset cursor. Narrow the query/kinds or raise the bounded limit. Snippets are display-only excerpts; `read` retrieves evidence
- `page({kinds?,limit?,before?})` reads chronological references directly from the same append-only source tables. It returns `{hits,nextCursor}`; each hit contains `kind`, `id`, `miraId`, the original `occurredAt`, and an optional timestamp warning, so a huge runtime/system payload does not prevent paging. Fetch selected originals with `read` and its separate byte budget. Pages default to 20 entries, accept 1–100, and cap the SQL metadata response at 262,144 bytes
- With no `before`, the newest matching page is returned in ascending display order. For timestamps PostgreSQL can normalize, ordering uses the timestamp instant with microsecond precision, then kind and ID in C collation. `nextCursor` requests the strictly older page, or is `null` at the beginning. Cursors are opaque, versioned, bounded to 524,288 UTF-8 bytes, and tied to the fixed Mira and normalized kind filter; changing filter order or page size is allowed, changing the selected kinds is rejected. Cursor values are SQL parameters, never SQL fragments. They are continuation positions, not authentication tokens
- Original writer validation accepts finite JavaScript `Date.parse` values, including some formats/calendar overflows PostgreSQL does not accept (for example `2026-02-30T00:00:00Z`). `pg_input_is_valid` guards the cast. Such references are preserved in a separate bucket before normalizable timestamps, ordered by the original timestamp text, kind and ID in C collation, and marked `timestampWarning: 'timestamp_not_normalized'`. Their cursor includes the entire fallback position. This is deterministic evidence ordering, not an emulation of JavaScript date normalization; normal application timestamps are canonical UTC ISO. Originals are never changed or silently skipped
- Keyset paging has no offset drift when newer records arrive. It is not a multi-request snapshot: newly inserted backdated records may be visible on a later older page, and a refreshed latest page includes newly appended records. Compaction checkpoints do not remove the original context records, and a new reader after refresh/restart can continue using the same cursor. There is no new history store, writer acquisition, or runtime payload interpretation. Chronological queries have the same 5-second timeout; no new index/migration is required, so very large histories may need future indexing
- `read({id})` accepts only the canonical lowercase History UUID (plus optional `maxBytes`) and returns one complete source including its `kind`, or `null`. No kind is guessed or supplied by the caller. Events include their original Wake receipt; context includes version and the unchanged runtime envelope; tool records include version, unchanged intent and outcome; Wake records include claim version, status, exact input/final record IDs and immutable membership `{eventId, externalEventId, wakeReceiptId, receiptOrder}` in persisted receipt order. `eventId` is a directly readable History UUID; the other two IDs retain their original dedupe meanings. Follow an event reference for its original event and Wake reason. Missing outcomes remain `null`
- Reads default to 65,536 bytes and accept `maxBytes` up to 1,048,576. Oversized records produce `HistoryError` code `too_large` and `requiredBytes`, never a silently truncated original. SQL checks the serialized response size before transferring the payload. Limits count PostgreSQL's JSON serialization, which can include additional whitespace
- Source IDs/envelope metadata are checked, but runtime payloads remain opaque even for unknown runtimes. Read access does not interpret Pi, rewrite evidence, replay tools, or insert provenance into Memory files

`tests/unit/history.test.mts` covers request/cursor validation, SQL parameterization, read-only cleanup, metadata-only paging, payload preservation and explicit size failures with an offline driver double. `tests/integration/history.test.mts` requires the real isolated PostgreSQL service and covers scope, lexical/Chinese behavior, exact originals, bounds, large writes, stable chronological paging across timestamp offsets/ties and appended checkpoints, and read-without-ownership. Offline doubles do not establish actual PostgreSQL behavior.

`history(miraId)` also implements `RunHistoryReader`. `findEventRun(externalEventId)` uses an exact parameterized event-key join in that fixed Mira, returning only `{eventId,runId}`. `pageRuns` reads fixed run metadata and exact membership counts, never original Wake envelopes. `readRun({id,before?,limit?})` reads the same fixed header, checkpoint/receipt metadata and context/tool references in a single read-only SQL snapshot. Neither result grows with trigger membership count. `readRunRequests` separately pages descriptions by durable receipt order (default 50/max 100); its independent scoped cursor fetches older members. Each description has a 2,048-byte display ceiling; larger originals return an explicit unavailable event reference, not partial text. The full original remains unchanged in History. It excludes records at/before `claimed_version` and after the persisted final record's version; later Wake records cannot contaminate a completed run. Records use version/kind/UUID ordering, default 50/max 100 per page, a 262,144-byte metadata cap and a bounded cursor tied to both Mira and Wake. Fetch originals separately with `read`; this adapter still never interprets Pi or returns a second runtime log. No migration or new table is added. `tests/integration/management-history.test.mts` verifies exact correlation, scope, stable pagination, no-change versus pending/changed receipts, and nonmutation on the real isolated PostgreSQL service, including 1,500- and 6,501-member coalesced batches completed through the actual fenced writer.


## Durable one-shot scheduling

`acquire` returns `DreamingWriter & SchedulingWriter` on the same dedicated connection,
advisory lock and epoch. Scheduling adds one `scheduled_deliveries` table. It has no
second worker, lease, job queue, runtime history, or calendar/recurrence engine.

- `(miraId, owner, key)` identifies a stable occurrence. Owner is fixed by trusted
  assembly, not supplied by an extension. `createScheduledDelivery` returns `updated`
  at version 1, `duplicate` only for an identical complete current input, and
  `conflict` for changed input. Retrying a create does not reset a settled occurrence.
- `replaceScheduledDelivery` replaces the opaque input under the same key only while
  pending at the expected version. `cancelScheduledDelivery` has the same CAS rule.
  A successful replacement, cancellation, expiry or enqueue advances its version.
  Versions must be positive safe integers; exhausted versions are rejected without
  wrapping. Missing rows return `missing`, stale pending versions `conflict`, and
  any terminal row `settled` for replace/cancel, including stale requests.
- `dueAt` and optional `expiresAt` must be canonical UTC ISO timestamps with four-digit
  years 0001–9999 and millisecond precision. Calendar overflows, offsets and missing
  milliseconds are rejected. Expiry must be at or after due time and is exclusive:
  at `expiresAt`, an occurrence is expired rather than enqueued. Callers resolve
  time zones, DST and recurrence before calling this primitive.
- `dispatchScheduledDeliveries(activeOwners)` reads the database clock in its fenced
  transaction and considers only pending rows of those owners that are due. A stopped
  extension's occurrence remains pending until its owner becomes eligible again;
  if its expiry has passed then, it becomes `expired` without emitting. Repeated
  owner IDs are harmless. `nextDueAt` describes only remaining eligible pending rows.
- Ordinary `receive` and the `enqueued` marker are committed together. Event-only
  delivery adds no Wake. Concurrent cancellation/dispatch is ordered by the existing
  writer; a successful cancel before publication prevents it, whereas `settled` with
  `enqueued` means the original Event/Wake is already durable and cannot be retracted.
  Enqueue is not a claim that cognition or a remote effect has completed.
- `getScheduledDelivery` and `listScheduledDeliveries(owner?)` return independent JSON
  copies, including terminal rows across restart. Omitted owner is trusted Mira-scoped
  management inspection; extension-facing services always fix their owner.
- The adapter preserves exact opaque Event/Wake inputs. Trusted assembly must namespace
  their IDs by scheduling owner and stable key, disjoint from every other ingress.
  A version suffix is unnecessary because replaced pending versions never publish and
  terminal keys cannot be reopened. Reusing another ingress identity can produce an
  honest content conflict and roll back the whole dispatch transaction.
- Process loss before COMMIT leaves the pending row and no event. Loss after COMMIT,
  including a missing acknowledgement, leaves the terminal marker and ordinary queue
  as the recovery authority. An uncertain writer stops; acquire a new writer and read
  the row instead of assuming rollback or replaying an external action.

`tests/integration/scheduling.test.mts` requires the real isolated PostgreSQL 18.6
service and covers exact-input retries, owner/Mira isolation, cloned inputs/outputs,
CAS and old-version suppression, cancellation ordering, event-only delivery, expiry,
inactive owners, repeated dispatch, restart, namespace conflicts, lost COMMIT replies,
actual ownership loss, SIGKILL before/after COMMIT, and migration down/up. The child
fixture pauses at the actual driver COMMIT boundary; the parent kills its OS process.
These tests must run in the real integration gate and never silently skip. A standalone
SQL-engine check or offline fake does not establish driver/process recovery.
### Live input

The writer also implements `LiveInputWriter`. `receiveLiveInput` atomically binds
new user receipts to an active nonfinal Wake; `wake_live_inputs` keeps supplemental
membership separate from frozen original input. Ordered `appendLiveInput` stores
its consumption link in the same CAS transaction as the message. Atomic tool and
final gates yield to unread input. Duplicate receipts never notify or rebind.
See [ADR 0024](../../docs/adr/0024-live-user-input.md).
## Task-scoped subagents

The acquired writer also implements `SubagentWriter`. `subagents(miraId)` provides
an independent read-only reader for metadata/history after owner loss. Lists use
SQL-bounded metadata pages; child reads include recent eight turns and bounded
pending work; call dedupe and run associations use indexed scoped lookups. Registry and turn state use
the existing parent writer's fenced transaction queue; transcript writers remain
separate. Stable parent call IDs deduplicate spawn/followup. Terminal turn state and
its parent Event/Wake commit together. Startup `interruptSubagents()` marks queued
or running work interrupted without replay. Terminal results remain immutable.
Migration `1760000000007_subagents.sql` has explicit up/down; down is destructive
and must not be run on user data automatically. See ADR 0025.
