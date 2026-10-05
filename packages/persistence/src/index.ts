import { isDeepStrictEqual } from 'node:util';
import { Client } from 'pg';
import { assertJson, assertRecord } from '@mira/context';
import type { RuntimeRecord } from '@mira/context';
import type { DurableWriter, LifeEvent, RecoverySnapshot, ToolIntent, ToolOutcome, WakeReceipt } from '@mira/life';
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

export class PostgresPersistence {
  readonly #options: PostgresOptions;
  constructor(options: PostgresOptions) {
    if (!options.connectionString) throw new Error('An explicit PostgreSQL connectionString is required');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema ?? 'public')) throw new Error('Invalid PostgreSQL schema');
    this.#options = { ...options };
  }

  async acquire(miraId: string): Promise<DurableWriter> {
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

class PostgresWriter implements DurableWriter {
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
      return { miraId: this.miraId, version: count, records: records.rows.map((row) => row.envelope), executions: tools.rows.map(({ intent, outcome }) => ({ intent, outcome })) };
    });
  }
  append(expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    const record = copy(input);
    assertRecord(record);
    return this.#transaction(async (owner) => {
      this.#checkVersion(owner, expectedVersion);
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
    }, signal);
  }
  receive(input: LifeEvent, optionalWake?: WakeReceipt): Promise<'inserted' | 'duplicate'> {
    const event = copy(input); const wake = optionalWake === undefined ? null : copy(optionalWake);
    text(event.id, 'event ID'); text(event.type, 'event type'); date(event.occurredAt);
    if (!['user', 'mira', 'system', 'extension', 'external'].includes(event.source)) fail('invalid', 'Invalid event source');
    if (wake) { text(wake.id, 'wake ID'); text(wake.reason, 'wake reason'); }
    return this.#transaction(async () => {
      const previous = await this.#client.query<{ event: LifeEvent; requested_wake: WakeReceipt | null }>(
        'SELECT event, requested_wake FROM life_events WHERE mira_id = $1 AND event_id = $2', [this.miraId, event.id]);
      const old = previous.rows[0];
      if (old) {
        if (!isDeepStrictEqual(old.event, event) || !isDeepStrictEqual(old.requested_wake, wake)) fail('duplicate', 'Event ID was reused with different data or wake');
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
    return this.#transaction(async () => {
      const changed = await this.#client.query('UPDATE tool_executions SET outcome = $1::json WHERE mira_id = $2 AND call_id = $3 AND outcome IS NULL',
        [JSON.stringify(outcome), this.miraId, outcome.callId]);
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
