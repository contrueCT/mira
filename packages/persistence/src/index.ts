import { PostgresSubagents, PostgresSubagentReader } from './subagents.ts';
import { SubagentError, type SubagentWriter, type SubagentReader } from '@mira/life';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PostgresHistoryReader } from './history.ts';
import type { LiveInputWriter, LiveWakeInput, RunHistoryReader, TaskInputWriter, TaskLiveInput, TaskTurnState } from '@mira/life';
import { DurableOperationError, type DurableFailureCategory } from '@mira/life';
import { assertJson, assertRecord } from '@mira/context';
import type { RuntimeRecord } from '@mira/context';
import type { DreamingRequest, DreamingRequestResult, DreamingWriter, LifeEvent, MemoryCheckpoint, MemoryCheckpointState, MemorySnapshotReceipt, RecoverySnapshot, ScheduledDelivery, ScheduledDeliveryInput, ScheduledMutation, SchedulingWriter, ToolIntent, ToolOutcome, WakeReceipt, WakeRun } from '@mira/life';
export { migrate } from './migrate.ts';
export type { MigrationOptions } from './migrate.ts';

// Two-int advisory locks occupy a separate key space from bigint migration locks.
const OWNER_NAMESPACE = 1_296_650_817;
const REGISTRY_NAMESPACE = 1_296_650_818;

export class PersistenceError extends DurableOperationError {
  readonly code: 'ownership' | 'version' | 'duplicate' | 'invalid' | 'corrupt';
  constructor(code: PersistenceError['code'], message: string, category?: DurableFailureCategory) {
    super(category, message);
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
interface TaskTurnRow { turn_id: string; call_id: string; created_at: string; status: TaskTurnState['status']; input_record_id: string | null; final_record_id: string | null }
interface WakeRunRow {
  run_id: string;
  claimed_at: string;
  claimed_version: string;
  input_record_id: string | null;
  final_record_id: string | null;
  completed: boolean;
}
interface WakeRequestRow { history_id: string; event_id: string; event: LifeEvent; requested_wake: WakeReceipt | null; wake_id: string; wake: WakeReceipt }
interface DreamingProgressRow {
  last_triggered_at: Date;
  idle_since: Date;
  consumed_receipt_order: string;
  checkpoint_version: string;
}
interface ScheduledDeliveryRow {
  owner_id: string;
  schedule_key: string;
  version: string;
  status: ScheduledDelivery['status'];
  due_at: Date;
  expires_at: Date | null;
  input: ScheduledDeliveryInput;
  created_at: Date;
  updated_at: Date;
}
interface MemoryCheckpointRow {
  run_id: string;
  final_record_id: string;
  prepared_at: string;
  payload: MemoryCheckpoint['payload'];
  receipt_run_id: string | null;
  commit_id: string | null;
}
function fail(code: PersistenceError['code'], message: string): never { throw new PersistenceError(code, message); }
function persistenceFailure(error: unknown): Error {
  if (DurableOperationError.categoryOf(error)) return error as Error;
  // The original exception stays internal. Public/durable diagnostics consume
  // only the trusted tag, never this message or cause.
  return new DurableOperationError('persistence-write-failure', error instanceof Error ? error.message : 'PostgreSQL operation failed', { cause: error });
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail('invalid', `Invalid ${label}`);
}
function historyId(value: unknown, label = 'History ID'): asserts value is string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('invalid', `Invalid ${label}: canonical UUID required`);
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
  text(intent.callId, 'tool call ID'); historyId(intent.assistantRecordId, 'assistant record ID');
  text(intent.toolName, 'tool name'); date(intent.occurredAt); assertJson(intent.requestedArguments); assertJson(intent.arguments);
}
function validateOutcome(outcome: ToolOutcome): void {
  text(outcome.callId, 'tool call ID'); date(outcome.occurredAt); assertJson(outcome.payload);
}
function validateEvent(event: LifeEvent): void {
  text(event.id, 'event ID'); text(event.type, 'event type'); date(event.occurredAt); assertJson(event.payload);
  if (!['user', 'mira', 'system', 'extension', 'external'].includes(event.source)) fail('invalid', 'Invalid event source');
}
function validateWake(wake: WakeReceipt): void { text(wake.id, 'wake ID'); text(wake.reason, 'wake reason'); }
function schedulingTimestamp(value: unknown): void {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value) || value.startsWith('0000-') ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid', 'Invalid schedule timestamp: canonical UTC milliseconds required');
}
function schedulingVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid', 'Invalid schedule version');
}
function validateScheduledInput(input: ScheduledDeliveryInput): void {
  text(input.key, 'schedule key'); schedulingTimestamp(input.dueAt);
  if (input.expiresAt !== undefined) {
    schedulingTimestamp(input.expiresAt);
    if (input.expiresAt < input.dueAt) fail('invalid', 'Schedule expiry precedes due time');
  }
  validateEvent(input.event);
  if (input.wake !== undefined) validateWake(input.wake);
}
function scheduledDelivery(row: ScheduledDeliveryRow): ScheduledDelivery {
  try {
    validateScheduledInput(row.input); text(row.owner_id, 'schedule owner'); schedulingVersion(Number(row.version));
    if (row.schedule_key !== row.input.key || row.due_at.toISOString() !== row.input.dueAt ||
      (row.expires_at?.toISOString() ?? undefined) !== row.input.expiresAt ||
      !['pending', 'enqueued', 'cancelled', 'expired'].includes(row.status)) throw new Error('Mismatched schedule metadata');
    return copy({ ...row.input, owner: row.owner_id, version: Number(row.version), status: row.status,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
  } catch { fail('corrupt', 'Invalid persisted scheduled delivery'); }
}
function validateMemoryCheckpoint(checkpoint: MemoryCheckpoint): void {
  historyId(checkpoint.runId, 'run ID'); historyId(checkpoint.finalRecordId, 'final record ID'); date(checkpoint.preparedAt); assertJson(checkpoint.payload);
}
function validateMemoryReceipt(receipt: MemorySnapshotReceipt): void {
  historyId(receipt.runId, 'run ID');
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
  history(miraId: string): RunHistoryReader { return new PostgresHistoryReader(this.#options, miraId); }

  subagents(miraId: string): SubagentReader { text(miraId, 'Mira ID'); return new PostgresSubagentReader(this.#options, miraId); }

  async acquire(miraId: string): Promise<DreamingWriter & SchedulingWriter & LiveInputWriter & SubagentWriter & TaskInputWriter> {
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

class PostgresWriter implements DreamingWriter, SchedulingWriter, LiveInputWriter, SubagentWriter, TaskInputWriter {
  readonly miraId: string;
  readonly epoch: string;
  readonly signal: AbortSignal;
  readonly #client: Client;
  readonly #subagents: PostgresSubagents;
  readonly #key: number;
  readonly #abort = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #ended: Promise<void> | undefined;

  constructor(client: Client, miraId: string, epoch: string, key: number) {
    this.#subagents = new PostgresSubagents(client, miraId, work => this.#transaction(work), async (event, wake) => (await this.#receiveSupplemental(event, wake)).runId, runId => this.#notifyLiveInput(runId));
    this.#client = client; this.miraId = miraId; this.epoch = epoch; this.#key = key; this.signal = this.#abort.signal;
    client.on('error', (error: Error) => this.#stop(error));
    client.on('end', () => this.#stop(new PersistenceError('ownership', 'PostgreSQL ownership connection ended')));
  }
  #stop(error: unknown): void {
    if (!this.signal.aborted) this.#abort.abort(persistenceFailure(error));
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
        if (!callerAbort && (!(error instanceof PersistenceError) && !(error instanceof SubagentError) || error instanceof PersistenceError && error.code === 'corrupt')) this.#stop(error);
        if (this.signal.aborted) void this.#end();
        throw callerAbort || error instanceof PersistenceError || !this.signal.aborted ? error : persistenceFailure(error);
      }
    });
  }
  createSubagent: SubagentWriter['createSubagent'] = (...args) => this.#subagents.create(...args);
  listSubagents: SubagentWriter['listSubagents'] = before => this.#subagents.list(before);
  findSubagentCall: SubagentWriter['findSubagentCall'] = callId => this.#subagents.findCall(callId);
  readSubagentCalls: SubagentWriter['readSubagentCalls'] = callIds => this.#subagents.readCalls(callIds);
  getSubagent: SubagentWriter['getSubagent'] = id => this.#subagents.get(id);
  getSubagentForRun: SubagentWriter['getSubagentForRun'] = (...args) => this.#subagents.getForRun(...args);
  readSubagentsForRun: SubagentWriter['readSubagentsForRun'] = (...args) => this.#subagents.listForRun(...args);
  recordSubagentActivity: SubagentWriter['recordSubagentActivity'] = (...args) => this.#subagents.activity(...args);
  sendSubagent: SubagentWriter['sendSubagent'] = (...args) => this.#subagents.send(...args);
  claimSubagentTurn: SubagentWriter['claimSubagentTurn'] = id => this.#subagents.claim(id);
  finishSubagentTurn: SubagentWriter['finishSubagentTurn'] = (...args) => this.#subagents.finish(...args);
  cancelSubagent: SubagentWriter['cancelSubagent'] = id => this.#subagents.cancel(id);
  interruptSubagents: SubagentWriter['interruptSubagents'] = () => this.#subagents.interrupt();
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
      historyId(row.run_id, 'run ID'); date(row.claimed_at);
      if (row.input_record_id !== null) historyId(row.input_record_id, 'input record ID');
      if (row.final_record_id !== null) historyId(row.final_record_id, 'final record ID');
    } catch { fail('corrupt', 'Invalid persisted wake run metadata'); }
    if (BigInt(row.claimed_version) > BigInt(owner.context_version) ||
      (row.final_record_id !== null && row.input_record_id === null) || (row.completed && row.final_record_id === null)) fail('corrupt', 'Invalid wake run progress');
    const requests = await this.#client.query<WakeRequestRow>(
      `SELECT e.history_id, w.event_id, e.event, e.requested_wake, w.wake_id, w.wake FROM wake_run_requests AS r
       JOIN wake_requests AS w ON w.mira_id = r.mira_id AND w.wake_id = r.wake_id
       JOIN life_events AS e ON e.mira_id = w.mira_id AND e.event_id = w.event_id
       WHERE r.mira_id = $1 AND r.run_id = $2 AND NOT EXISTS
         (SELECT 1 FROM wake_live_inputs AS i WHERE i.mira_id = r.mira_id AND i.wake_id = r.wake_id)
       ORDER BY w.receipt_order`, [this.miraId, row.run_id]);
    if (!requests.rows.length) fail('corrupt', 'Wake run has no claimed requests');
    for (const request of requests.rows) {
      try { historyId(request.history_id); validateEvent(request.event); validateWake(request.wake); } catch { fail('corrupt', 'Invalid persisted wake request'); }
      if (request.event.id !== request.event_id || request.wake.id !== request.wake_id ||
        !isDeepStrictEqual(request.requested_wake, request.wake)) fail('corrupt', 'Wake request does not match its event receipt');
    }
    const links = await this.#client.query<{ record_id: string; version: string; envelope: RuntimeRecord }>(
      'SELECT record_id, version, envelope FROM context_records WHERE mira_id = $1 AND record_id = ANY($2::uuid[])',
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
      requests: requests.rows.map(({ history_id, event, wake }) => ({ eventId: history_id, event, wake })),
      inputRecordId: row.input_record_id, finalRecordId: row.final_record_id,
    };
  }
  loadWakeRun(runId: string): Promise<WakeRun> {
    historyId(runId, 'run ID');
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
      await this.#reserveHistoryId(id, 'wake');
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
  async #reserveHistoryId(id: string, kind: 'event' | 'context' | 'tool' | 'wake'): Promise<void> {
    historyId(id);
    const result = await this.#client.query('INSERT INTO history_records(id, mira_id, kind) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [id, this.miraId, kind]);
    if (result.rowCount !== 1) fail('duplicate', 'History ID already belongs to a record');
  }
  async #appendRecord(owner: OwnerRow, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    historyId(record.id);
    if (record.parentId !== null) historyId(record.parentId);
    this.#checkVersion(owner, expectedVersion);
    if ((await this.#activeWakeRun())?.final_record_id) fail('invalid', 'Complete the finalized wake run before appending more context');
    if ((await this.#client.query("SELECT 1 FROM subagent_turns WHERE stream_id=$1 AND status='running' AND final_record_id IS NOT NULL LIMIT 1", [this.miraId])).rowCount)
      fail('invalid', 'Complete the finalized task turn before appending more context');
    if (record.parentId !== owner.head_record_id) fail('invalid', 'Record parent must be the current history head');
    if (expectedVersion === Number.MAX_SAFE_INTEGER) fail('invalid', 'Context version exhausted');
    const duplicate = await this.#client.query('SELECT 1 FROM context_records WHERE mira_id = $1 AND record_id = $2', [this.miraId, record.id]);
    if (duplicate.rowCount) fail('duplicate', 'Runtime record ID already exists');
    const next = expectedVersion + 1;
    signal?.throwIfAborted();
    await this.#reserveHistoryId(record.id, 'context');
    await this.#client.query('INSERT INTO context_records(mira_id, record_id, version, parent_id, envelope) VALUES ($1, $2, $3, $4, $5::json)',
      [this.miraId, record.id, next, record.parentId, JSON.stringify(record)]);
    signal?.throwIfAborted();
    const updated = await this.#client.query('UPDATE mira_owners SET context_version = $1, head_record_id = $2 WHERE mira_id = $3 AND context_version = $4 AND epoch = $5',
      [next, record.id, this.miraId, expectedVersion, this.epoch]);
    if (updated.rowCount !== 1) fail('version', 'Context version changed');
    return next;
  }
  /** The child owns its transcript; this lookup never consults the parent writer. */
  async #taskTurn(turnId: string): Promise<TaskTurnRow> {
    // Only task input/tool-start/final gates share parent admission's lock.
    // Generic checkpoint publication retains its independent commit boundary;
    // cancellation can still win before an already-dispatched summary COMMIT.
    await this.#client.query('SELECT child_id FROM subagents WHERE stream_id=$1 FOR UPDATE', [this.miraId]);
    const row = (await this.#client.query<TaskTurnRow>('SELECT turn_id,call_id,created_at,status,input_record_id,final_record_id FROM subagent_turns WHERE stream_id=$1 AND turn_id=$2', [this.miraId,turnId])).rows[0];
    if (!row) fail('invalid', 'Task turn does not belong to this child stream');
    return row;
  }
  loadTaskTurn(turnId: string): Promise<TaskTurnState> {
    historyId(turnId);
    return this.#transaction(async owner => {
      const row = await this.#taskTurn(turnId);
      const links = (await this.#client.query<{ record_id: string; envelope: RuntimeRecord; version: string }>('SELECT record_id,envelope,version FROM context_records WHERE mira_id=$1 AND record_id=ANY($2::uuid[])', [this.miraId,[row.input_record_id,row.final_record_id].filter(id => id !== null)])).rows;
      const input = links.find(link => link.record_id === row.input_record_id);
      const final = links.find(link => link.record_id === row.final_record_id);
      if ((row.input_record_id && (!input || input.envelope.kind !== 'message' || input.envelope.id !== row.input_record_id || BigInt(input.version) > BigInt(owner.context_version))) ||
        (row.final_record_id && (!input || !final || final.envelope.kind !== 'message' || final.envelope.id !== row.final_record_id || BigInt(final.version) <= BigInt(input.version) || BigInt(final.version) > BigInt(owner.context_version)))) fail('corrupt', 'Task boundary evidence is inconsistent');
      return { id: row.turn_id, callId: row.call_id, createdAt: row.created_at, status: row.status, inputRecordId: row.input_record_id, finalRecordId: row.final_record_id };
    });
  }
  async #hasTaskInput(turnId: string): Promise<boolean> {
    return !!(await this.#client.query("SELECT 1 FROM subagent_live_inputs WHERE stream_id=$1 AND turn_id=$2 AND status='pending' LIMIT 1", [this.miraId,turnId])).rowCount;
  }
  async #taskEvidenceRetry(link: string, expectedVersion: number, record: RuntimeRecord): Promise<number> {
    const saved = (await this.#client.query<{ envelope: RuntimeRecord; version: string }>('SELECT envelope,version FROM context_records WHERE mira_id=$1 AND record_id=$2', [this.miraId,link])).rows[0];
    if (!saved || link !== record.id || !isDeepStrictEqual(saved.envelope,record)) fail('duplicate', 'Task evidence already links a different record');
    if (saved.version !== String(expectedVersion + 1)) fail('version', 'Task evidence retry has a different expected version');
    return Number(saved.version);
  }
  appendTaskInput(turnId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    return this.#appendTaskRecord('input_record_id',turnId,expectedVersion,input,signal) as Promise<number>;
  }
  tryAppendTaskFinal(turnId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number | null> {
    return this.#appendTaskRecord('final_record_id',turnId,expectedVersion,input,signal);
  }
  #appendTaskRecord(field: 'input_record_id' | 'final_record_id', turnId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number | null> {
    historyId(turnId); version(expectedVersion);
    const record = copy(input); assertRecord(record);
    if (record.kind !== 'message') fail('invalid', 'Task evidence must be a message');
    return this.#transaction(async owner => {
      const turn = await this.#taskTurn(turnId);
      const linked = turn[field];
      if (linked) return this.#taskEvidenceRetry(linked,expectedVersion,record);
      if (turn.status !== 'running' || turn.final_record_id) fail('invalid', 'Task turn is not active');
      if (field === 'final_record_id') {
        if (!turn.input_record_id) fail('invalid', 'Task input must precede its final reply');
        this.#checkVersion(owner,expectedVersion);
        if (await this.#hasTaskInput(turnId)) return null;
      }
      const next = await this.#appendRecord(owner,expectedVersion,record,signal);
      const changed = await this.#client.query(`UPDATE subagent_turns SET ${field}=$1 WHERE stream_id=$2 AND turn_id=$3 AND ${field} IS NULL AND status='running'`, [record.id,this.miraId,turnId]);
      if (changed.rowCount !== 1) fail('corrupt', 'Task evidence association was not persisted');
      return next;
    }, signal);
  }
  loadTaskInputs(turnId: string): Promise<TaskLiveInput[]> {
    historyId(turnId);
    return this.#transaction(async owner => {
      const turn = await this.#taskTurn(turnId);
      if (turn.status !== 'running' && !turn.final_record_id) fail('invalid', 'Task turn is not active');
      const bounds = (await this.#client.query<{ record_id: string; version: string }>('SELECT record_id,version FROM context_records WHERE mira_id=$1 AND record_id=ANY($2::uuid[])', [this.miraId,[turn.input_record_id,turn.final_record_id].filter(id => id !== null)])).rows;
      const initialVersion = bounds.find(row => row.record_id === turn.input_record_id)?.version;
      const finalVersion = bounds.find(row => row.record_id === turn.final_record_id)?.version;
      const rows = (await this.#client.query<{ call_id: string; instruction: string; created_at: string; input_record_id: string | null; record_version: string | null; envelope: RuntimeRecord | null }>(
        `SELECT i.call_id,i.instruction,i.created_at,i.input_record_id,c.version AS record_version,c.envelope
         FROM subagent_live_inputs i LEFT JOIN context_records c ON c.mira_id=i.stream_id AND c.record_id=i.input_record_id
         WHERE i.stream_id=$1 AND i.turn_id=$2 AND i.status IN ('pending','consumed') ORDER BY i.receipt_order`, [this.miraId,turnId])).rows;
      let pending = false, previousVersion = BigInt(initialVersion ?? 0);
      return rows.map(row => {
        if (row.input_record_id) {
          if (!initialVersion || pending || !row.envelope || row.envelope.kind !== 'message' || row.envelope.id !== row.input_record_id || !row.record_version || BigInt(row.record_version) <= previousVersion || BigInt(row.record_version) > BigInt(owner.context_version) || (finalVersion && BigInt(row.record_version) >= BigInt(finalVersion))) fail('corrupt', 'Task live input evidence is out of order');
          previousVersion = BigInt(row.record_version);
        } else {
          if (turn.final_record_id) fail('corrupt', 'Finalized task has pending input');
          pending = true;
        }
        return { callId: row.call_id, instruction: row.instruction, createdAt: row.created_at, inputRecordId: row.input_record_id };
      });
    });
  }
  appendTaskLiveInput(turnId: string, callId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    historyId(turnId); text(callId,'parent call ID'); version(expectedVersion);
    const record = copy(input); assertRecord(record);
    if (record.kind !== 'message') fail('invalid', 'Task live input must be a message');
    return this.#transaction(async owner => {
      const turn = await this.#taskTurn(turnId);
      const row = (await this.#client.query<{ input_record_id: string | null; status: string }>('SELECT input_record_id,status FROM subagent_live_inputs WHERE stream_id=$1 AND turn_id=$2 AND call_id=$3', [this.miraId,turnId,callId])).rows[0];
      if (!row) fail('invalid', 'Live input is not associated with this task turn');
      if (row.input_record_id) return this.#taskEvidenceRetry(row.input_record_id,expectedVersion,record);
      if (turn.status !== 'running' || turn.final_record_id || !turn.input_record_id || row.status !== 'pending') fail('invalid', 'Task live input requires an active initialized turn');
      const first = (await this.#client.query<{ call_id: string }>("SELECT call_id FROM subagent_live_inputs WHERE stream_id=$1 AND turn_id=$2 AND status='pending' ORDER BY receipt_order LIMIT 1", [this.miraId,turnId])).rows[0];
      if (first?.call_id !== callId) fail('invalid', 'Task live inputs must be consumed in receipt order');
      const next = await this.#appendRecord(owner,expectedVersion,record,signal);
      const changed = await this.#client.query("UPDATE subagent_live_inputs SET input_record_id=$1,status='consumed' WHERE stream_id=$2 AND turn_id=$3 AND call_id=$4 AND status='pending'", [record.id,this.miraId,turnId,callId]);
      if (changed.rowCount !== 1) fail('corrupt', 'Task live input association was not persisted');
      return next;
    },signal);
  }
  tryBeginTaskTool(turnId: string, expectedVersion: number, input: ToolIntent): Promise<boolean> {
    historyId(turnId); const intent = copy(input); validateIntent(intent);
    return this.#transaction(async owner => {
      this.#checkVersion(owner,expectedVersion);
      const turn = await this.#taskTurn(turnId);
      if (turn.status !== 'running' || turn.final_record_id || !turn.input_record_id) fail('invalid', 'Task tool requires an active initialized turn');
      if (await this.#hasTaskInput(turnId)) return false;
      await this.#beginTool(owner,expectedVersion,intent);
      return true;
    });
  }
  appendWakeInput(runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    return this.#appendWakeRecord('input_record_id', runId, expectedVersion, input, signal) as Promise<number>;
  }
  appendWakeFinal(runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    return this.#appendWakeRecord('final_record_id', runId, expectedVersion, input, signal) as Promise<number>;
  }
  tryAppendWakeFinal(runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number | null> {
    return this.#appendWakeRecord('final_record_id', runId, expectedVersion, input, signal, true);
  }
  #appendWakeRecord(field: 'input_record_id' | 'final_record_id', runId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal, yieldToInput = false): Promise<number | null> {
    historyId(runId, 'run ID'); version(expectedVersion);
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
      if (field === 'final_record_id' && await this.#hasLiveInput(runId)) {
        this.#checkVersion(owner, expectedVersion);
        if (yieldToInput) return null;
        fail('invalid', 'Pending live inputs must be consumed before finalizing');
      }
      const next = await this.#appendRecord(owner, expectedVersion, record, signal);
      const changed = await this.#client.query(`UPDATE wake_runs SET ${field} = $1 WHERE mira_id = $2 AND run_id = $3 AND ${field} IS NULL AND NOT completed`,
        [record.id, this.miraId, runId]);
      if (changed.rowCount !== 1) fail('corrupt', 'Wake evidence association was not persisted');
      return next;
    }, signal);
  }
  completeWakeRun(runId: string): Promise<void> {
    historyId(runId, 'run ID');
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(runId);
      await this.#readWakeRun(run, owner);
      if (run.completed) return;
      if (run.input_record_id === null || run.final_record_id === null) fail('invalid', 'Wake cannot complete without persisted input and final reply');
      const memory = await this.#readMemoryCheckpoint(run);
      if (memory && !memory.receipt) fail('invalid', 'Pending Memory checkpoint must finish before Wake completion');
      const changed = await this.#client.query('UPDATE wake_runs SET completed = true WHERE mira_id = $1 AND run_id = $2 AND NOT completed', [this.miraId, runId]);
      if (changed.rowCount !== 1) fail('corrupt', 'Wake completion was not persisted');
      await this.#touchDreamingIdle();
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
    historyId(runId, 'run ID');
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
  readonly #liveInputListeners = new Set<(runId: string) => void>();
  onLiveInput(listener: (runId: string) => void): () => void {
    this.#liveInputListeners.add(listener);
    return () => { this.#liveInputListeners.delete(listener); };
  }
  async #hasLiveInput(runId: string): Promise<boolean> {
    return !!(await this.#client.query('SELECT 1 FROM wake_live_inputs WHERE mira_id = $1 AND run_id = $2 AND input_record_id IS NULL LIMIT 1', [this.miraId, runId])).rowCount;
  }
  async receiveLiveInput(input: LifeEvent, requestedWake: WakeReceipt): Promise<'inserted' | 'duplicate'> {
    const event = copy(input); const wake = copy(requestedWake);
    validateEvent(event); validateWake(wake);
    if (event.source !== 'user') fail('invalid', 'Live input must be a user event');
    const result = await this.#transaction(() => this.#receiveSupplemental(event, wake));
    this.#notifyLiveInput(result.runId);
    return result.receipt;
  }
  /** Internal only: caller holds the owner transaction. Child terminal receipts
   * originate in PostgresSubagents from its persisted turn, never public ingress. */
  async #receiveSupplemental(event: LifeEvent, wake: WakeReceipt): Promise<{ receipt: 'inserted' | 'duplicate'; runId: string | null }> {
    const receipt = await this.#receive(event, wake);
    if (receipt === 'duplicate') return { receipt, runId: null };
    const active = await this.#activeWakeRun();
    if (!active || active.final_record_id) return { receipt, runId: null };
    await this.#client.query('INSERT INTO wake_run_requests(mira_id, wake_id, run_id) VALUES ($1, $2, $3)', [this.miraId, wake.id, active.run_id]);
    await this.#client.query('INSERT INTO wake_live_inputs(mira_id, wake_id, run_id) VALUES ($1, $2, $3)', [this.miraId, wake.id, active.run_id]);
    return { receipt, runId: active.run_id };
  }
  #notifyLiveInput(runId: string | null): void {
    // Call only after COMMIT. Durable gates cover lost hints and restart.
    if (runId) for (const listener of this.#liveInputListeners) {
      try { listener(runId); } catch { /* Notifications are hints only. */ }
    }
  }
  loadLiveInputs(runId: string): Promise<LiveWakeInput[]> {
    historyId(runId);
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(runId);
      await this.#readWakeRun(run, owner);
      const bounds = (await this.#client.query<{ record_id: string; version: string }>(
        'SELECT record_id, version FROM context_records WHERE mira_id = $1 AND record_id = ANY($2::uuid[])',
        [this.miraId, [run.input_record_id, run.final_record_id].filter(id => id !== null)])).rows;
      const initialVersion = bounds.find(row => row.record_id === run.input_record_id)?.version;
      const finalVersion = bounds.find(row => row.record_id === run.final_record_id)?.version;
      const rows = await this.#client.query<WakeRequestRow & { input_record_id: string | null; record_version: string | null; envelope: RuntimeRecord | null }>(
        `SELECT e.history_id, w.event_id, e.event, e.requested_wake, w.wake_id, w.wake, i.input_record_id,
                c.version AS record_version, c.envelope
         FROM wake_live_inputs AS i
         JOIN wake_run_requests AS r ON r.mira_id = i.mira_id AND r.wake_id = i.wake_id AND r.run_id = i.run_id
         JOIN wake_requests AS w ON w.mira_id = i.mira_id AND w.wake_id = i.wake_id
         JOIN life_events AS e ON e.mira_id = w.mira_id AND e.event_id = w.event_id
         LEFT JOIN context_records AS c ON c.mira_id = i.mira_id AND c.record_id = i.input_record_id
         WHERE i.mira_id = $1 AND i.run_id = $2 ORDER BY w.receipt_order`, [this.miraId, runId]);
      let pending = false;
      let previousVersion = BigInt(initialVersion ?? 0);
      return rows.rows.map(row => {
        validateEvent(row.event); validateWake(row.wake); historyId(row.history_id);
        if (row.event.id !== row.event_id || row.wake.id !== row.wake_id || !isDeepStrictEqual(row.requested_wake, row.wake)) fail('corrupt', 'Live input receipt mismatch');
        if (row.input_record_id) {
          if (!initialVersion || pending || !row.envelope || row.envelope.kind !== 'message' || row.envelope.id !== row.input_record_id || !row.record_version || BigInt(row.record_version) <= previousVersion || BigInt(row.record_version) > BigInt(owner.context_version) || (finalVersion && BigInt(row.record_version) >= BigInt(finalVersion))) fail('corrupt', 'Live input evidence is out of order');
          previousVersion = BigInt(row.record_version);
        } else {
          if (run.final_record_id) fail('corrupt', 'Finalized Wake has pending live input');
          pending = true;
        }
        return { request: { eventId: row.history_id, event: row.event, wake: row.wake }, inputRecordId: row.input_record_id };
      });
    });
  }
  appendLiveInput(runId: string, wakeId: string, expectedVersion: number, input: RuntimeRecord, signal?: AbortSignal): Promise<number> {
    historyId(runId); text(wakeId, 'wake ID'); version(expectedVersion);
    const record = copy(input); assertRecord(record);
    if (record.kind !== 'message') fail('invalid', 'Live input must be a message');
    return this.#transaction(async owner => {
      const run = await this.#wakeRun(runId);
      if (run.completed || run.final_record_id || !run.input_record_id || (await this.#activeWakeRun())?.run_id !== runId) fail('invalid', 'Live input requires an active initialized Wake');
      const row = (await this.#client.query<{ input_record_id: string | null }>('SELECT input_record_id FROM wake_live_inputs WHERE mira_id = $1 AND run_id = $2 AND wake_id = $3', [this.miraId, runId, wakeId])).rows[0];
      if (!row) fail('invalid', 'Live input is not associated with this Wake');
      if (row.input_record_id) {
        const saved = (await this.#client.query<{ envelope: RuntimeRecord; version: string }>('SELECT envelope, version FROM context_records WHERE mira_id = $1 AND record_id = $2', [this.miraId, row.input_record_id])).rows[0];
        if (!saved || row.input_record_id !== record.id || !isDeepStrictEqual(saved.envelope, record)) fail('duplicate', 'Live input already has different evidence');
        if (saved.version !== String(expectedVersion + 1)) fail('version', 'Live input retry has a different expected version');
        return Number(saved.version);
      }
      const first = (await this.#client.query<{ wake_id: string }>(`SELECT i.wake_id FROM wake_live_inputs AS i JOIN wake_requests AS w ON w.mira_id = i.mira_id AND w.wake_id = i.wake_id WHERE i.mira_id = $1 AND i.run_id = $2 AND i.input_record_id IS NULL ORDER BY w.receipt_order LIMIT 1`, [this.miraId, runId])).rows[0];
      if (first?.wake_id !== wakeId) fail('invalid', 'Live inputs must be consumed in receipt order');
      const next = await this.#appendRecord(owner, expectedVersion, record, signal);
      await this.#client.query('UPDATE wake_live_inputs SET input_record_id = $1 WHERE mira_id = $2 AND run_id = $3 AND wake_id = $4 AND input_record_id IS NULL', [record.id, this.miraId, runId, wakeId]);
      return next;
    }, signal);
  }
  receive(input: LifeEvent, optionalWake?: WakeReceipt): Promise<'inserted' | 'duplicate'> {
    const event = copy(input); const wake = optionalWake === undefined ? null : copy(optionalWake);
    validateEvent(event);
    if (wake) validateWake(wake);
    return this.#transaction(() => this.#receive(event, wake));
  }
  /** Shared insertion path keeps scheduler Events/Wakes under the same history,
   * identity and idempotency rules as all other ingress. */
  async #receive(event: LifeEvent, wake: WakeReceipt | null): Promise<'inserted' | 'duplicate'> {
    const previous = await this.#client.query<{ event: LifeEvent; requested_wake: WakeReceipt | null }>(
      'SELECT event, requested_wake FROM life_events WHERE mira_id = $1 AND event_id = $2', [this.miraId, event.id]);
    const old = previous.rows[0];
    if (old) {
      if (!isDeepStrictEqual(old.event, event) || !isDeepStrictEqual(old.requested_wake, wake)) throw new PersistenceError('duplicate', 'Event ID was reused with different data or wake', 'event-content-conflict');
      const receipts = await this.#client.query<{ wake_id: string; wake: WakeReceipt }>(
        'SELECT wake_id, wake FROM wake_requests WHERE mira_id = $1 AND event_id = $2', [this.miraId, event.id]);
      if (wake === null ? receipts.rows.length !== 0 : receipts.rows.length !== 1 || receipts.rows[0]?.wake_id !== wake.id || !isDeepStrictEqual(receipts.rows[0]?.wake, wake)) fail('corrupt', 'Event and wake receipt disagree');
      return 'duplicate';
    }
    const id = randomUUID();
    await this.#reserveHistoryId(id, 'event');
    await this.#client.query('INSERT INTO life_events(mira_id, event_id, event, requested_wake, history_id) VALUES ($1, $2, $3::json, $4::json, $5)',
      [this.miraId, event.id, JSON.stringify(event), wake === null ? null : JSON.stringify(wake), id]);
    if (wake) {
      const existing = await this.#client.query('SELECT 1 FROM wake_requests WHERE mira_id = $1 AND wake_id = $2', [this.miraId, wake.id]);
      if (existing.rowCount) throw new PersistenceError('duplicate', 'Wake ID already belongs to another event', 'event-content-conflict');
      await this.#client.query('INSERT INTO wake_requests(mira_id, wake_id, event_id, wake) VALUES ($1, $2, $3, $4::json)',
        [this.miraId, wake.id, event.id, JSON.stringify(wake)]);
      await this.#touchDreamingIdle();
    }
    return 'inserted';
  }
  async #scheduled(owner: string, key: string): Promise<ScheduledDeliveryRow | undefined> {
    return (await this.#client.query<ScheduledDeliveryRow>(
      'SELECT * FROM scheduled_deliveries WHERE mira_id = $1 AND owner_id = $2 AND schedule_key = $3',
      [this.miraId, owner, key])).rows[0];
  }
  createScheduledDelivery(owner: string, input: ScheduledDeliveryInput): Promise<ScheduledMutation> {
    text(owner, 'schedule owner');
    const value = copy(input); validateScheduledInput(value);
    return this.#transaction(async () => {
      const previous = await this.#scheduled(owner, value.key);
      if (previous) return { status: isDeepStrictEqual(previous.input, value) ? 'duplicate' : 'conflict', delivery: scheduledDelivery(previous) };
      const result = await this.#client.query<ScheduledDeliveryRow>(
        `INSERT INTO scheduled_deliveries(mira_id, owner_id, schedule_key, due_at, expires_at, input)
         VALUES ($1, $2, $3, $4, $5, $6::json) RETURNING *`,
        [this.miraId, owner, value.key, value.dueAt, value.expiresAt ?? null, JSON.stringify(value)]);
      if (!result.rows[0]) fail('corrupt', 'Scheduled delivery was not persisted');
      return { status: 'updated', delivery: scheduledDelivery(result.rows[0]) };
    });
  }
  getScheduledDelivery(owner: string, key: string): Promise<ScheduledDelivery | null> {
    text(owner, 'schedule owner'); text(key, 'schedule key');
    return this.#transaction(async () => {
      const row = await this.#scheduled(owner, key);
      return row ? scheduledDelivery(row) : null;
    });
  }
  listScheduledDeliveries(owner?: string): Promise<ScheduledDelivery[]> {
    if (owner !== undefined) text(owner, 'schedule owner');
    return this.#transaction(async () => {
      const result = await this.#client.query<ScheduledDeliveryRow>(
        'SELECT * FROM scheduled_deliveries WHERE mira_id = $1 AND ($2::text IS NULL OR owner_id = $2) ORDER BY due_at, owner_id COLLATE "C", schedule_key COLLATE "C"', [this.miraId, owner ?? null]);
      return result.rows.map(scheduledDelivery);
    });
  }
  replaceScheduledDelivery(owner: string, expectedVersion: number, input: ScheduledDeliveryInput): Promise<ScheduledMutation> {
    text(owner, 'schedule owner'); schedulingVersion(expectedVersion);
    const value = copy(input); validateScheduledInput(value);
    return this.#transaction(async () => {
      const previous = await this.#scheduled(owner, value.key);
      if (!previous) return { status: 'missing', delivery: null };
      const delivery = scheduledDelivery(previous);
      if (delivery.status !== 'pending') return { status: 'settled', delivery };
      if (delivery.version !== expectedVersion) return { status: 'conflict', delivery };
      if (expectedVersion === Number.MAX_SAFE_INTEGER) fail('invalid', 'Schedule version exhausted');
      const result = await this.#client.query<ScheduledDeliveryRow>(
        `UPDATE scheduled_deliveries SET version = version + 1, due_at = $4, expires_at = $5, input = $6::json,
         updated_at = date_trunc('milliseconds', clock_timestamp())
         WHERE mira_id = $1 AND owner_id = $2 AND schedule_key = $3 AND version = $7 AND status = 'pending' RETURNING *`,
        [this.miraId, owner, value.key, value.dueAt, value.expiresAt ?? null, JSON.stringify(value), expectedVersion]);
      if (!result.rows[0]) fail('corrupt', 'Scheduled replacement was not persisted');
      return { status: 'updated', delivery: scheduledDelivery(result.rows[0]) };
    });
  }
  cancelScheduledDelivery(owner: string, key: string, expectedVersion: number): Promise<ScheduledMutation> {
    text(owner, 'schedule owner'); text(key, 'schedule key'); schedulingVersion(expectedVersion);
    return this.#transaction(async () => {
      const previous = await this.#scheduled(owner, key);
      if (!previous) return { status: 'missing', delivery: null };
      const delivery = scheduledDelivery(previous);
      if (delivery.status !== 'pending') return { status: 'settled', delivery };
      if (delivery.version !== expectedVersion) return { status: 'conflict', delivery };
      return { status: 'updated', delivery: await this.#settleScheduled(delivery, 'cancelled') };
    });
  }
  async #settleScheduled(delivery: ScheduledDelivery, status: 'cancelled' | 'enqueued' | 'expired'): Promise<ScheduledDelivery> {
    if (delivery.version === Number.MAX_SAFE_INTEGER) fail('invalid', 'Schedule version exhausted');
    const result = await this.#client.query<ScheduledDeliveryRow>(
      `UPDATE scheduled_deliveries SET status = $4, version = version + 1, updated_at = date_trunc('milliseconds', clock_timestamp())
       WHERE mira_id = $1 AND owner_id = $2 AND schedule_key = $3 AND version = $5 AND status = 'pending' RETURNING *`,
      [this.miraId, delivery.owner, delivery.key, status, delivery.version]);
    if (!result.rows[0]) fail('corrupt', 'Scheduled terminal status was not persisted');
    return scheduledDelivery(result.rows[0]);
  }
  dispatchScheduledDeliveries(owners: readonly string[]): Promise<{ enqueued: number; nextDueAt: string | null }> {
    const activeOwners = [...new Set(owners)];
    for (const owner of activeOwners) text(owner, 'schedule owner');
    return this.#transaction(async () => {
      if (!activeOwners.length) return { enqueued: 0, nextDueAt: null };
      const now = (await this.#client.query<{ now: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0]?.now;
      if (!now || !Number.isFinite(now.getTime())) fail('corrupt', 'Invalid database clock');
      const due = await this.#client.query<ScheduledDeliveryRow>(
        `SELECT * FROM scheduled_deliveries WHERE mira_id = $1 AND owner_id = ANY($2::text[]) AND status = 'pending' AND due_at <= $3
         ORDER BY due_at, owner_id COLLATE "C", schedule_key COLLATE "C"`, [this.miraId, activeOwners, now]);
      let enqueued = 0;
      for (const row of due.rows) {
        const delivery = scheduledDelivery(row);
        if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) {
          await this.#settleScheduled(delivery, 'expired');
        } else {
          // The same fenced transaction owns both ordinary ingress and its
          // terminal marker. A lost receipt is resolved by reading this row.
          await this.#receive(delivery.event, delivery.wake ?? null);
          await this.#settleScheduled(delivery, 'enqueued');
          enqueued++;
        }
      }
      const next = (await this.#client.query<{ due_at: Date | null }>(
        "SELECT min(due_at) AS due_at FROM scheduled_deliveries WHERE mira_id = $1 AND owner_id = ANY($2::text[]) AND status = 'pending'",
        [this.miraId, activeOwners])).rows[0]?.due_at;
      return { enqueued, nextDueAt: next?.toISOString() ?? null };
    });
  }
  async #touchDreamingIdle(): Promise<void> {
    await this.#client.query("UPDATE dreaming_progress SET idle_since = date_trunc('milliseconds', clock_timestamp()) WHERE mira_id = $1", [this.miraId]);
  }
  initializeDreaming(): Promise<void> {
    return this.#transaction(async owner => {
      await this.#client.query(
        `INSERT INTO dreaming_progress(mira_id, last_triggered_at, idle_since, consumed_receipt_order, checkpoint_version)
         SELECT $1, date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', clock_timestamp()), COALESCE(max(receipt_order), 0), $2
         FROM wake_requests WHERE mira_id = $1 ON CONFLICT (mira_id) DO NOTHING`,
        [this.miraId, owner.context_version]);
    });
  }
  requestDreaming(input: DreamingRequest): Promise<DreamingRequestResult> {
    const request = { ...input };
    for (const duration of [request.idleMs, request.intervalMs]) {
      if (!Number.isSafeInteger(duration) || duration < 1) fail('invalid', 'Invalid Dreaming duration');
    }
    if (!Number.isSafeInteger(request.minCompactions) || request.minCompactions < 1) fail('invalid', 'Invalid Dreaming compaction threshold');
    text(request.instruction, 'Dreaming instruction');
    return this.#transaction(async owner => {
      const progress = (await this.#client.query<DreamingProgressRow>(
        'SELECT * FROM dreaming_progress WHERE mira_id = $1', [this.miraId])).rows[0];
      if (!progress) fail('invalid', 'Initialize Dreaming before requesting it');
      if (BigInt(progress.checkpoint_version) > BigInt(owner.context_version)) fail('corrupt', 'Dreaming checkpoint baseline exceeds context version');
      if (await this.#activeWakeRun()) return { status: 'waiting', nextCheckAt: null };
      const pending = await this.#client.query(
        `SELECT 1 FROM wake_requests AS w WHERE w.mira_id = $1 AND NOT EXISTS
         (SELECT 1 FROM wake_run_requests AS r WHERE r.mira_id = w.mira_id AND r.wake_id = w.wake_id) LIMIT 1`, [this.miraId]);
      if (pending.rowCount) return { status: 'waiting', nextCheckAt: null };
      const fresh = (await this.#client.query<{ receipt_order: string | null }>(
        `SELECT max(w.receipt_order) AS receipt_order FROM wake_requests AS w
         JOIN life_events AS e ON e.mira_id = w.mira_id AND e.event_id = w.event_id
         WHERE w.mira_id = $1 AND w.receipt_order > $2 AND e.event->>'source' IN ('user', 'extension', 'external')`,
        [this.miraId, progress.consumed_receipt_order])).rows[0]?.receipt_order;
      if (fresh === null || fresh === undefined) return { status: 'waiting', nextCheckAt: null };
      const count = (await this.#client.query<{ count: string }>(
        `SELECT count(*) FROM context_records WHERE mira_id = $1 AND version > $2 AND envelope->>'kind' = 'checkpoint'`,
        [this.miraId, progress.checkpoint_version])).rows[0]?.count;
      if (count === undefined) fail('corrupt', 'Dreaming checkpoint count is missing');
      const now = (await this.#client.query<{ now: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0]?.now;
      if (!now || !Number.isFinite(now.getTime())) fail('corrupt', 'Invalid database clock');
      if (!(progress.idle_since instanceof Date) || !(progress.last_triggered_at instanceof Date) ||
        !Number.isFinite(progress.idle_since.getTime()) || !Number.isFinite(progress.last_triggered_at.getTime())) fail('corrupt', 'Invalid Dreaming timestamp');
      const idleAt = progress.idle_since.getTime() + request.idleMs;
      // Millisecond API uses strictly greater than the interval, not >=.
      const timeAt = progress.last_triggered_at.getTime() + request.intervalMs + 1;
      const enoughCompactions = BigInt(count) >= BigInt(request.minCompactions);
      const nextAt = Math.max(idleAt, enoughCompactions ? now.getTime() : timeAt);
      if (nextAt > now.getTime()) {
        const nextCheck = new Date(nextAt);
        if (!Number.isFinite(nextCheck.getTime())) fail('invalid', 'Dreaming duration exceeds timestamp range');
        return { status: 'waiting', nextCheckAt: nextCheck.toISOString() };
      }
      const id = randomUUID();
      await this.#receive({ id, type: 'memory.dreaming', source: 'system', occurredAt: now.toISOString(), payload: { instruction: request.instruction } },
        { id, reason: 'Maintain long-term Memory after new experiences' });
      const changed = await this.#client.query(
        `UPDATE dreaming_progress SET last_triggered_at = $2, consumed_receipt_order = $3, checkpoint_version = $4
         WHERE mira_id = $1`, [this.miraId, now, fresh, owner.context_version]);
      if (changed.rowCount !== 1) fail('corrupt', 'Dreaming trigger progress was not persisted');
      return { status: 'inserted' };
    });
  }

  beginTool(expectedVersion: number, input: ToolIntent): Promise<void> {
    const intent = copy(input); validateIntent(intent);
    return this.#transaction(owner => this.#beginTool(owner, expectedVersion, intent));
  }
  tryBeginWakeTool(runId: string, expectedVersion: number, input: ToolIntent): Promise<boolean> {
    historyId(runId); const intent = copy(input); validateIntent(intent);
    return this.#transaction(async owner => {
      this.#checkVersion(owner, expectedVersion);
      if ((await this.#activeWakeRun())?.run_id !== runId) fail('invalid', 'Wake run is not active');
      if (await this.#hasLiveInput(runId)) return false;
      await this.#beginTool(owner, expectedVersion, intent);
      return true;
    });
  }
  async #beginTool(owner: OwnerRow, expectedVersion: number, intent: ToolIntent): Promise<void> {
      this.#checkVersion(owner, expectedVersion);
      if ((await this.#activeWakeRun())?.final_record_id) fail('invalid', 'Finalized wake run cannot start another tool');
      const duplicate = await this.#client.query('SELECT 1 FROM tool_executions WHERE mira_id = $1 AND call_id = $2', [this.miraId, intent.callId]);
      if (duplicate.rowCount) fail('duplicate', 'Tool call ID has already been prepared; reconcile its persisted execution');
      const reference = await this.#client.query<{ envelope: RuntimeRecord }>('SELECT envelope FROM context_records WHERE mira_id = $1 AND record_id = $2', [this.miraId, intent.assistantRecordId]);
      const record = reference.rows[0]?.envelope;
      if (!record || record.kind !== 'message') fail('invalid', 'Tool intent must reference a persisted message');
      assertRecord(record);
      const id = randomUUID();
      await this.#reserveHistoryId(id, 'tool');
      await this.#client.query('INSERT INTO tool_executions(mira_id, call_id, assistant_record_id, context_version, intent, history_id) VALUES ($1, $2, $3, $4, $5::json, $6)',
        [this.miraId, intent.callId, intent.assistantRecordId, expectedVersion, JSON.stringify(intent), id]);
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
