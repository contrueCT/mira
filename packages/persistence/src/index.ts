import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresHistoryReader } from './history.ts';
import type { HistoryReader } from '@mira/life';
import { assertJson, assertRecord } from '@mira/context';
import type { RuntimeRecord } from '@mira/context';
import type { LifeEvent, MemoryCheckpoint, MemoryCheckpointState, MemoryCheckpointWriter, MemorySnapshotReceipt, RecoverySnapshot, ToolIntent, ToolOutcome, WakeReceipt, WakeRun } from '@mira/life';
export { migrate } from './migrate.ts';
export type { MigrationOptions } from './migrate.ts';

// Two-int advisory locks occupy a separate key space from bigint migration locks.
const OWNER_NAMESPACE = 1_296_650_817;
const REGISTRY_NAMESPACE = 1_296_650_818;

export class PersistenceError extends Error {
  readonly code: 'ownership' | 'version' | 'duplicate' | 'invalid' | 'corrupt';
  constructor(code: PersistenceError['code'], message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}
export interface PostgresOptions {
  connectionString: string;
  schema?: string;
  /** Useful for identifying this process in pg_stat_activity, never a credential. */
  applicationName?: string;
}
interface OwnerRow { epoch: string; context_version: string; head_record_id: string | null; held: boolean }
interface WakeRunRow {
  run_id: string;
  claimed_at: string;
  claimed_version: string;
  input_record_id: string | null;
  final_record_id: string | null;
  completed: boolean;
}
interface WakeRequestRow { event_id: string; event: LifeEvent; requested_wake: WakeReceipt | null; wake_id: string; wake: WakeReceipt }
interface MemoryCheckpointRow {
  run_id: string;
  final_record_id: string;
  prepared_at: string;
  payload: MemoryCheckpoint['payload'];
  receipt_run_id: string | null;
  commit_id: string | null;
}
function fail(code: PersistenceError['code'], message: string): never { throw new PersistenceError(code, message); }
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail('invalid', `Invalid ${label}`);
}
function date(value: unknown): void {
  text(value, 'timestamp');
  if (!Number.isFinite(Date.parse(value))) fail('invalid', 'Invalid timestamp');
}
function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid', 'Invalid context version');
}
function copy<T>(value: T): T {
  assertJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
function validateIntent(intent: ToolIntent): void {
  text(intent.callId, 'tool call ID'); text(intent.assistantRecordId, 'assistant record ID');
  text(intent.toolName, 'tool name'); date(intent.occurredAt); assertJson(intent.requestedArguments); assertJson(intent.arguments); assertJson(intent.authorization);
}
function validateOutcome(outcome: ToolOutcome): void {
  text(outcome.callId, 'tool call ID'); date(outcome.occurredAt); assertJson(outcome.payload);
}
function validateEvent(event: LifeEvent): void {
  text(event.id, 'event ID'); text(event.type, 'event type'); date(event.occurredAt); assertJson(event.payload);
  if (!['user', 'mira', 'system', 'extension', 'external'].includes(event.source)) fail('invalid', 'Invalid event source');
}
function validateWake(wake: WakeReceipt): void { text(wake.id, 'wake ID'); text(wake.reason, 'wake reason'); }
function validateMemoryCheckpoint(checkpoint: MemoryCheckpoint): void {
  text(checkpoint.runId, 'run ID'); text(checkpoint.finalRecordId, 'final record ID'); date(checkpoint.preparedAt); assertJson(checkpoint.payload);
}
function validateMemoryReceipt(receipt: MemorySnapshotReceipt): void {
  text(receipt.runId, 'run ID');
  if (receipt.commit !== null && (typeof receipt.commit !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.commit))) fail('invalid', 'Invalid Memory Git commit ID');
}

export class PostgresPersistence {
  readonly #options: PostgresOptions;
  constructor(options: PostgresOptions) {
    if (!options.connectionString) throw new Error('An explicit PostgreSQL connectionString is required');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema ?? 'public')) throw new Error('Invalid PostgreSQL schema');
    this.#options = { ...options };
  }

  /** Scoped read-only access does not acquire or displace the durable writer. */
  history(miraId: string): HistoryReader { return new PostgresHistoryReader(this.#options, miraId); }

  async acquire(miraId: string): Promise<MemoryCheckpointWriter> {
    text(miraId, 'Mira ID');
    const client = new Client({
      connectionString: this.#options.connectionString,
      application_name: this.#options.applicationName ?? 'mira-durable-writer',
      connectionTimeoutMillis: 5_000,
      keepAlive: true,
    });
    // Install before connect: idle session errors must never become unhandled events.
    let failure: Error | undefined;
    client.on('error', (error: Error) => { failure = error; });
    try {
      await client.connect();
      await client.query(`SET search_path TO "${this.#options.schema ?? 'public'}"`);
      // Registration is the only pre-ownership mutation and has its own session lock.
      // A sequence-generated key avoids Mira-ID hash collisions. Never recycle it.
      let registered = (await client.query<{ lock_key: number }>('SELECT lock_key FROM mira_owners WHERE mira_id = $1', [miraId])).rows[0];
      if (!registered) {
        await client.query('SELECT pg_advisory_lock($1::integer, 0)', [REGISTRY_NAMESPACE]);
        try {
          registered = (await client.query<{ lock_key: number }>('SELECT lock_key FROM mira_owners WHERE mira_id = $1', [miraId])).rows[0];
          registered ??= (await client.query<{ lock_key: number }>('INSERT INTO mira_owners(mira_id) VALUES ($1) RETURNING lock_key', [miraId])).rows[0];
        } finally {
          await client.query('SELECT pg_advisory_unlock($1::integer, 0)', [REGISTRY_NAMESPACE]);
        }
      }
      if (!registered) fail('corrupt', 'Mira registration was not persisted');
      const key = registered.lock_key;
      const locked = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired', [OWNER_NAMESPACE, key]);
      if (!locked.rows[0]?.acquired) fail('ownership', 'Another process owns this Mira');
      await client.query('BEGIN');
      try {
        const held = await client.query<{ held: boolean }>(lockQuery, [OWNER_NAMESPACE, key]);
        if (failure || !held.rows[0]?.held) fail('ownership', 'Ownership was lost during acquisition');
        const result = await client.query<{ epoch: string }>('UPDATE mira_owners SET epoch = epoch + 1 WHERE mira_id = $1 RETURNING epoch', [miraId]);
        const epoch = result.rows[0]?.epoch;
        if (!epoch) fail('corrupt', 'Mira owner is missing');
        await client.query('COMMIT');
        if (failure) throw failure;
        return new PostgresWriter(client, miraId, epoch, key);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }
}

const heldExpression = `EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
)`;
const lockQuery = `SELECT ${heldExpression} AS held`;

class PostgresWriter implements MemoryCheckpointWriter {
  readonly miraId: string;
  readonly epoch: string;
  readonly signal: AbortSignal;
  readonly #client: Client;
  readonly #key: number;
  readonly #abort = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #ended: Promise<void> | undefined;

  constructor(client: Client, miraId: string, epoch: string, key: number) {
    this.#client = client; this.miraId = miraId; this.epoch = epoch; this.#key = key; this.signal = this.#abort.signal;
    client.on('error', (error: Error) => this.#stop(error));
    client.on('end', () => this.#stop(new PersistenceError('ownership', 'PostgreSQL ownership connection ended')));
  }
  #stop(error: unknown): void {
    if (!this.signal.aborted) this.#abort.abort(error);
  }
  assertActive(): void {
    if (this.signal.aborted) fail('ownership', 'Writer is stopped; acquire a new writer and recover before continuing');
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => {});
    return result;
  }
  async #owner(): Promise<OwnerRow> {
    this.assertActive();
    const result = await this.#client.query<OwnerRow>(
      `SELECT epoch, context_version, head_record_id, ${heldExpression} AS held FROM mira_owners WHERE mira_id = $3 AND lock_key = $2::integer FOR UPDATE`,
      [OWNER_NAMESPACE, this.#key, this.miraId]);
    const row = result.rows[0];
    if (!row?.held || row.epoch !== this.epoch) {
      const error = new PersistenceError('ownership', 'Session advisory lock or ownership epoch was lost');
      this.#stop(error); throw error;
    }
    return row;
  }
  #transaction<T>(run: (owner: OwnerRow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#serial(async () => {
      this.assertActive();
      signal?.throwIfAborted();
      try {
        await this.#client.query('BEGIN');
        // Verify the actual session lock, not only an epoch/lease in a table.
        const owner = await this.#owner();
        signal?.throwIfAborted();
        const result = await run(owner);
        await this.#owner();
        this.assertActive();
        signal?.throwIfAborted();
        await this.#client.query('COMMIT');
        this.assertActive();
        return result;
      } catch (error) {
        try { await this.#client.query('ROLLBACK'); } catch (rollbackError) { this.#stop(rollbackError); }
        const callerAbort = signal?.aborted && error === signal.reason;
        if (!callerAbort && (!(error instanceof PersistenceError) || error.code === 'corrupt')) this.#stop(error);
        if (this.signal.aborted) void this.#end();
        throw error;
      }
    });
  }
  #checkVersion(owner: OwnerRow, expected: number): void {
    version(expected);
    if (owner.context_version !== String(expected)) fail('version', 'Stale context version');
  }
  verifyActive(): Promise<void> { return this.#transaction(async () => {}); }

  async #activeWakeRun(): Promise<WakeRunRow | undefined> {
    const result = await this.#client.query<WakeRunRow>('SELECT * FROM wake_runs WHERE mira_id = $1 AND NOT completed', [this.miraId]);
    if (result.rows.length > 1) fail('corrupt', 'Multiple active wake runs');
    return result.rows[0];
  }
  async #wakeRun(runId: string): Promise<WakeRunRow> {
    const result = await this.#client.query<WakeRunRow>('SELECT * FROM wake_runs WHERE mira_id = $1 AND run_id = $2', [this.miraId, runId]);
    if (!result.rows[0]) fail('invalid', 'Wake run does not exist');
    return result.rows[0];
  }
  async #readWakeRun(row: WakeRunRow, owner: OwnerRow): Promise<WakeRun> {
    try {
      text(row.run_id, 'run ID'); date(row.claimed_at);
      if (row.input_record_id !== null) text(row.input_record_id, 'input record ID');
      if (row.final_record_id !== null) text(row.final_record_id, 'final record ID');
    } catch { fail('corrupt', 'Invalid persisted wake run metadata'); }
    if (BigInt(row.claimed_version) > BigInt(owner.context_version) ||
      (row.final_record_id !== null && row.input_record_id === null) || (row.completed && row.final_record_id === null)) fail('corrupt', 'Invalid wake run progress');
    const requests = await this.#client.query<WakeRequestRow>(
      `SELECT w.event_id, e.event, e.requested_wake, w.wake_id, w.wake FROM wake_run_requests AS r
       JOIN wake_requests AS w ON w.mira_id = r.mira_id AND w.wake_id = r.wake_id
       JOIN life_events AS e ON e.mira_id = w.mira_id AND e.event_id = w.event_id
       WHERE r.mira_id = $1 AND r.run_id = $2 ORDER BY w.receipt_order`, [this.miraId, row.run_id]);
    if (!requests.rows.length) fail('corrupt', 'Wake run has no claimed requests');
    for (const request of requests.rows) {
      try { validateEvent(request.event); validateWake(request.wake); } catch { fail('corrupt', 'Invalid persisted wake request'); }
      if (request.event.id !== request.event_id || request.wake.id !== request.wake_id ||
        !isDeepStrictEqual(request.requested_wake, request.wake)) fail('corrupt', 'Wake request does not match its event receipt');
    }
    const links = await this.#client.query<{ record_id: string; version: string; envelope: RuntimeRecord }>(
      'SELECT record_id, version, envelope FROM context_records WHERE mira_id = $1 AND record_id = ANY($2::text[])',
      [this.miraId, [row.input_record_id, row.final_record_id].filter(id => id !== null)]);
    const input = links.rows.find(record => record.record_id === row.input_record_id);
    const final = links.rows.find(record => record.record_id === row.final_record_id);
    for (const record of links.rows) {
      try { assertRecord(record.envelope); } catch { fail('corrupt', 'Invalid wake context record'); }
      if (record.envelope.id !== record.record_id || record.envelope.kind !== 'message' || BigInt(record.version) > BigInt(owner.context_version)) fail('corrupt', 'Wake link must reference its exact message record');
    }
    if ((row.input_record_id !== null && (!input || BigInt(input.version) <= BigInt(row.claimed_version))) ||
      (row.final_record_id !== null && (!input || !final || BigInt(final.version) <= BigInt(input.version))) ||
      (!row.completed && final && final.version !== owner.context_version)) fail('corrupt', 'Wake context links are out of order');
    await this.#readMemoryCheckpoint(row);
    return {
      id: row.run_id, claimedAt: row.claimed_at, status: row.completed ? 'completed' : 'running',
      requests: requests.rows.map(({ event, wake }) => ({ event, wake })),
      inputRecordId: row.input_record_id, finalRecordId: row.final_record_id,
    };
  }
  loadWakeRun(runId: string): Promise<WakeRun> {
    text(runId, 'run ID');
    return this.#transaction(async owner => this.#readWakeRun(await this.#wakeRun(runId), owner));
  }
  claimWakeBatch(): Promise<WakeRun | null> {
    return this.#transaction(async owner => {
      const active = await this.#activeWakeRun();
      if (active) return this.#readWakeRun(active, owner);
      const pending = await this.#client.query<{ wake_id: string }>(
        `SELECT w.wake_id FROM wake_requests AS w WHERE w.mira_id = $1 AND NOT EXISTS
         (SELECT 1 FROM wake_run_requests AS r WHERE r.mira_id = w.mira_id AND r.wake_id = w.wake_id)
         ORDER BY w.receipt_order`, [this.miraId]);
      if (!pending.rows.length) return null;
      const id = randomUUID();
      await this.#client.query('INSERT INTO wake_runs(mira_id, run_id, claimed_at, claimed_version) VALUES ($1, $2, $3, $4)',
        [this.miraId, id, new Date().toISOString(), owner.context_version]);
      await this.#client.query('INSERT INTO wake_run_requests(mira_id, run_id, wake_id) SELECT $1, $2, unnest($3::text[])',
        [this.miraId, id, pending.rows.map(request => request.wake_id)]);
      return this.#readWakeRun(await this.#wakeRun(id), owner);
    });
  }

  load(): Promise<RecoverySnapshot> {
    return this.#transaction(async (owner) => {
      const records = await this.#client.query<{ envelope: RuntimeRecord; record_id: string; parent_id: string | null; version: string }>(
        'SELECT envelope, record_id, parent_id, version FROM context_records WHERE mira_id = $1 ORDER BY version', [this.miraId]);
      let parent: string | null = null;
      let count = 0;
      for (const row of records.rows) {
        assertRecord(row.envelope);
        if (row.envelope.id !== row.record_id || row.envelope.parentId !== parent || row.parent_id !== parent || row.version !== String(++count)) fail('corrupt', 'Broken context history chain');
        parent = row.record_id;
      }
      if (owner.context_version !== String(count) || owner.head_record_id !== parent) fail('corrupt', 'Context metadata does not match history');
      const tools = await this.#client.query<{ intent: ToolIntent; outcome: ToolOutcome | null; call_id: string; assistant_record_id: string }>(
        'SELECT intent, outcome, call_id, assistant_record_id FROM tool_executions WHERE mira_id = $1 ORDER BY context_version, call_id', [this.miraId]);
      for (const row of tools.rows) {
        validateIntent(row.intent);
        if (row.intent.callId !== row.call_id || row.intent.assistantRecordId !== row.assistant_record_id) fail('corrupt', 'Tool intent metadata mismatch');
        if (row.outcome) {
          validateOutcome(row.outcome);
          if (row.outcome.callId !== row.call_id) fail('corrupt', 'Tool outcome metadata mismatch');
        }
      }
      const runs = await this.#client.query<WakeRunRow>('SELECT * FROM wake_runs WHERE mira_id = $1 ORDER BY claimed_version, run_id', [this.miraId]);
      for (const run of runs.rows) await this.#readWakeRun(run, owner);
      return { miraId: this.miraId, version: count, records: records.rows.map((row) => row.envelope), executions: tools.rows.map(({ intent, outcome }) => ({ intent, outcome })) };
    });
  }
  append(expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    const record = copy(input);
    assertRecord(record);
    return this.#transaction(owner => this.#appendRecord(owner, expectedVersion, record, signal), signal);
  }
  async #appendRecord(owner: OwnerRow, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    this.#checkVersion(owner, expectedVersion);
    if ((await this.#activeWakeRun())?.final_record_id) fail('invalid', 'Complete the finalized wake run before appending more context');
    if (record.parentId !== owner.head_record_id) fail('invalid', 'Record parent must be the current history head');
    if (expectedVersion === Number.MAX_SAFE_INTEGER) fail('invalid', 'Context version exhausted');
    const duplicate = await this.#client.query('SELECT 1 FROM context_records WHERE mira_id = $1 AND record_id = $2', [this.miraId, record.id]);
    if (duplicate.rowCount) fail('duplicate', 'Runtime record ID already exists');
    const next = expectedVersion + 1;
    signal?.throwIfAborted();
    await this.#client.query('INSERT INTO context_records(mira_id, record_id, version, parent_id, envelope) VALUES ($1, $2, $3, $4, $5::json)',
      [this.miraId, record.id, next, record.parentId, JSON.stringify(record)]);
    signal?.throwIfAborted();
    const updated = await this.#client.query('UPDATE mira_owners SET context_version = $1, head_record_id = $2 WHERE mira_id = $3 AND context_version = $4 AND epoch = $5',
      [next, record.id, this.miraId, expectedVersion, this.epoch]);
    if (updated.rowCount !== 1) fail('version', 'Context version changed');
    return next;
  }
  appendWakeInput(runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    return this.#appendWakeRecord('input_record_id', runId, expectedVersion, input, signal);
  }
  appendWakeFinal(runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    return this.#appendWakeRecord('final_record_id', runId, expectedVersion, input, signal);
  }
  #appendWakeRecord(field: 'input_record_id' | 'final_record_id', runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    text(runId, 'run ID'); version(expectedVersion);
    if (expectedVersion === Number.MAX_SAFE_INTEGER) fail('invalid', 'Context version exhausted');
    const record = copy(input); assertRecord(record);
    if (record.kind !== 'message') fail('invalid', 'Wake evidence must be a message record');
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(runId);
      await this.#readWakeRun(run, owner);
      const linked = run[field];
      if (linked !== null) {
        const saved = (await this.#client.query<{ envelope: RuntimeRecord; version: string }>(
          'SELECT envelope, version FROM context_records WHERE mira_id = $1 AND record_id = $2', [this.miraId, linked])).rows[0];
        if (linked !== record.id || !saved || !isDeepStrictEqual(saved.envelope, record)) fail('duplicate', 'Wake evidence is already associated with a different record');
        if (saved.version !== String(expectedVersion + 1)) fail('version', 'Wake evidence retry has a different expected version');
        return Number(saved.version);
      }
      if (run.completed || (await this.#activeWakeRun())?.run_id !== runId) fail('invalid', 'Wake run is not active');
      if (field === 'final_record_id' && run.input_record_id === null) fail('invalid', 'Wake input must be persisted before its final reply');
      const next = await this.#appendRecord(owner, expectedVersion, record, signal);
      const changed = await this.#client.query(`UPDATE wake_runs SET ${field} = $1 WHERE mira_id = $2 AND run_id = $3 AND ${field} IS NULL AND NOT completed`,
        [record.id, this.miraId, runId]);
      if (changed.rowCount !== 1) fail('corrupt', 'Wake evidence association was not persisted');
      return next;
    }, signal);
  }
  completeWakeRun(runId: string): Promise<void> {
    text(runId, 'run ID');
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(runId);
      await this.#readWakeRun(run, owner);
      if (run.completed) return;
      if (run.input_record_id === null || run.final_record_id === null) fail('invalid', 'Wake cannot complete without persisted input and final reply');
      const memory = await this.#readMemoryCheckpoint(run);
      if (memory && !memory.receipt) fail('invalid', 'Pending Memory checkpoint must finish before Wake completion');
      const changed = await this.#client.query('UPDATE wake_runs SET completed = true WHERE mira_id = $1 AND run_id = $2 AND NOT completed', [this.miraId, runId]);
      if (changed.rowCount !== 1) fail('corrupt', 'Wake completion was not persisted');
    });
  }
  async #readMemoryCheckpoint(run: WakeRunRow): Promise<MemoryCheckpointState | null> {
    const result = await this.#client.query<MemoryCheckpointRow>(
      `SELECT c.run_id, c.final_record_id, c.prepared_at, c.payload, r.run_id AS receipt_run_id, r.commit_id
       FROM wake_memory_checkpoints AS c LEFT JOIN wake_memory_receipts AS r
       ON r.mira_id = c.mira_id AND r.run_id = c.run_id
       WHERE c.mira_id = $1 AND c.run_id = $2`, [this.miraId, run.run_id]);
    const row = result.rows[0];
    if (!row) return null;
    const checkpoint: MemoryCheckpoint = { runId: row.run_id, finalRecordId: row.final_record_id, preparedAt: row.prepared_at, payload: row.payload };
    const receipt: MemorySnapshotReceipt | null = row.receipt_run_id === null ? null : { runId: row.receipt_run_id, commit: row.commit_id };
    try {
      validateMemoryCheckpoint(checkpoint);
      if (receipt) validateMemoryReceipt(receipt);
    } catch { fail('corrupt', 'Invalid persisted Memory checkpoint'); }
    if (checkpoint.runId !== run.run_id || checkpoint.finalRecordId !== run.final_record_id ||
      (receipt && receipt.runId !== run.run_id) || (run.completed && !receipt)) fail('corrupt', 'Memory checkpoint does not match Wake progress');
    return { checkpoint, receipt };
  }
  loadMemoryCheckpoint(runId: string): Promise<MemoryCheckpointState | null> {
    text(runId, 'run ID');
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(runId);
      await this.#readWakeRun(run, owner);
      return this.#readMemoryCheckpoint(run);
    });
  }
  prepareMemoryCheckpoint(input: MemoryCheckpoint): Promise<void> {
    const checkpoint = copy(input); validateMemoryCheckpoint(checkpoint);
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(checkpoint.runId);
      await this.#readWakeRun(run, owner);
      const old = await this.#readMemoryCheckpoint(run);
      if (old) {
        if (!isDeepStrictEqual(old.checkpoint, checkpoint)) fail('duplicate', 'Memory checkpoint already exists with different recovery inputs');
        return;
      }
      if (run.completed || run.final_record_id === null || run.final_record_id !== checkpoint.finalRecordId) fail('invalid', 'Memory checkpoint requires the active Wake final reply');
      await this.#client.query(
        'INSERT INTO wake_memory_checkpoints(mira_id, run_id, final_record_id, prepared_at, payload) VALUES ($1, $2, $3, $4, $5::json)',
        [this.miraId, checkpoint.runId, checkpoint.finalRecordId, checkpoint.preparedAt, JSON.stringify(checkpoint.payload)]);
    });
  }
  finishMemoryCheckpoint(input: MemorySnapshotReceipt): Promise<void> {
    const receipt = copy(input); validateMemoryReceipt(receipt);
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(receipt.runId);
      await this.#readWakeRun(run, owner);
      const old = await this.#readMemoryCheckpoint(run);
      if (!old) fail('invalid', 'Prepare the Memory checkpoint before recording its Git outcome');
      if (old.receipt) {
        if (!isDeepStrictEqual(old.receipt, receipt)) fail('duplicate', 'Memory snapshot receipt already has a different Git outcome');
        return;
      }
      await this.#client.query('INSERT INTO wake_memory_receipts(mira_id, run_id, commit_id) VALUES ($1, $2, $3)', [this.miraId, receipt.runId, receipt.commit]);
    });
  }
  receive(input: LifeEvent, optionalWake?: WakeReceipt): Promise<'inserted' | 'duplicate'> {
    const event = copy(input); const wake = optionalWake === undefined ? null : copy(optionalWake);
    validateEvent(event);
    if (wake) validateWake(wake);
    return this.#transaction(async () => {
      const previous = await this.#client.query<{ event: LifeEvent; requested_wake: WakeReceipt | null }>(
        'SELECT event, requested_wake FROM life_events WHERE mira_id = $1 AND event_id = $2', [this.miraId, event.id]);
      const old = previous.rows[0];
      if (old) {
        if (!isDeepStrictEqual(old.event, event) || !isDeepStrictEqual(old.requested_wake, wake)) fail('duplicate', 'Event ID was reused with different data or wake');
        const receipts = await this.#client.query<{ wake_id: string; wake: WakeReceipt }>(
          'SELECT wake_id, wake FROM wake_requests WHERE mira_id = $1 AND event_id = $2', [this.miraId, event.id]);
        if (wake === null ? receipts.rows.length !== 0 : receipts.rows.length !== 1 || receipts.rows[0]?.wake_id !== wake.id || !isDeepStrictEqual(receipts.rows[0]?.wake, wake)) fail('corrupt', 'Event and wake receipt disagree');
        return 'duplicate';
      }
      await this.#client.query('INSERT INTO life_events(mira_id, event_id, event, requested_wake) VALUES ($1, $2, $3::json, $4::json)',
        [this.miraId, event.id, JSON.stringify(event), wake === null ? null : JSON.stringify(wake)]);
      if (wake) {
        const existing = await this.#client.query('SELECT 1 FROM wake_requests WHERE mira_id = $1 AND wake_id = $2', [this.miraId, wake.id]);
        if (existing.rowCount) fail('duplicate', 'Wake ID already belongs to another event');
        await this.#client.query('INSERT INTO wake_requests(mira_id, wake_id, event_id, wake) VALUES ($1, $2, $3, $4::json)',
          [this.miraId, wake.id, event.id, JSON.stringify(wake)]);
      }
      return 'inserted';
    });
  }
  beginTool(expectedVersion: number, input: ToolIntent): Promise<void> {
    const intent = copy(input); validateIntent(intent);
    return this.#transaction(async (owner) => {
      this.#checkVersion(owner, expectedVersion);
      if ((await this.#activeWakeRun())?.final_record_id) fail('invalid', 'Finalized wake run cannot start another tool');
      const duplicate = await this.#client.query('SELECT 1 FROM tool_executions WHERE mira_id = $1 AND call_id = $2', [this.miraId, intent.callId]);
      if (duplicate.rowCount) fail('duplicate', 'Tool call ID has already been prepared; reconcile its persisted execution');
      const reference = await this.#client.query<{ envelope: RuntimeRecord }>('SELECT envelope FROM context_records WHERE mira_id = $1 AND record_id = $2', [this.miraId, intent.assistantRecordId]);
      const record = reference.rows[0]?.envelope;
      if (!record || record.kind !== 'message') fail('invalid', 'Tool intent must reference a persisted message');
      assertRecord(record);
      await this.#client.query('INSERT INTO tool_executions(mira_id, call_id, assistant_record_id, context_version, intent) VALUES ($1, $2, $3, $4, $5::json)',
        [this.miraId, intent.callId, intent.assistantRecordId, expectedVersion, JSON.stringify(intent)]);
    });
  }
  finishTool(input: ToolOutcome): Promise<void> {
    const outcome = copy(input); validateOutcome(outcome);
    return this.#transaction(async owner => {
      const execution = (await this.#client.query<{ context_version: string; outcome: ToolOutcome | null }>(
        'SELECT context_version, outcome FROM tool_executions WHERE mira_id = $1 AND call_id = $2', [this.miraId, outcome.callId])).rows[0];
      if (!execution || execution.outcome !== null) fail('duplicate', 'Tool call is missing or already has an outcome; never overwrite or replay');
      // The outcome precedes its transcript publication. Once context advances,
      // recovery may have durably observed this execution as unknown; accepting
      // a late canonical outcome would contradict that immutable history.
      if (execution.context_version !== owner.context_version) fail('version', 'Tool outcome arrived after context advanced; preserve the original execution evidence');
      const changed = await this.#client.query('UPDATE tool_executions SET outcome = $1::json WHERE mira_id = $2 AND call_id = $3 AND outcome IS NULL AND context_version = $4',
        [JSON.stringify(outcome), this.miraId, outcome.callId, owner.context_version]);
      if (changed.rowCount !== 1) fail('duplicate', 'Tool call is missing or already has an outcome; never overwrite or replay');
    });
  }
  #end(): Promise<void> {
    this.#ended ??= this.#client.end().catch(() => {});
    return this.#ended;
  }
  async close(): Promise<void> {
    this.#stop(new PersistenceError('ownership', 'Writer was closed'));
    await this.#queue;
    await this.#end();
  }
}
