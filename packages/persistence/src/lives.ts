import { Client } from 'pg';
import type { PostgresOptions } from './index.ts';

/** One registered life of a slot. Older lives are archived, never deleted. */
export interface MiraLife {
  miraId: string;
  slot: string;
  generation: number;
  createdAt: string;
  resetId: string | null;
  archivedAt: string | null;
  archivePath: string | null;
  resetReason: string | null;
  active: boolean;
}
/** Counts for a reset preflight; the caller adds file-system facts. */
export interface LifeImpact {
  messages: number;
  compactions: number;
  pendingWakes: number;
  pendingDeliveries: number;
  runningWake: boolean;
}
export interface LifeSwitch {
  from: string;
  to: string;
  generation: number;
  /** False when this reset ID had already committed its switch (idempotent replay). */
  created: boolean;
  cancelledDeliveries: number;
}
export class LifeRegistryError extends Error {
  readonly code: 'invalid' | 'ownership' | 'conflict' | 'missing';
  constructor(code: LifeRegistryError['code'], message: string) { super(message); this.name = 'LifeRegistryError'; this.code = code; }
}
// Must equal the writer namespace in index.ts: a transaction-level lock on the
// same two-int key conflicts with a live writer's session lock.
const OWNER_NAMESPACE = 1_296_650_817;
const LIFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}(?:~g[1-9][0-9]{0,8})?$/;
const RESET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface LifeRow { mira_id: string; slot: string; generation: number; created_at: Date; reset_id: string | null; archived_at: Date | null; archive_path: string | null; reset_reason: string | null; active: boolean }
const life = (row: LifeRow): MiraLife => ({ miraId: row.mira_id, slot: row.slot, generation: row.generation, createdAt: row.created_at.toISOString(),
  resetId: row.reset_id, archivedAt: row.archived_at?.toISOString() ?? null, archivePath: row.archive_path, resetReason: row.reset_reason, active: row.active });
function slotName(slot: string): void { if (typeof slot !== 'string' || slot.includes('~') || !LIFE_ID.test(slot)) throw new LifeRegistryError('invalid', 'Invalid Mira slot'); }
function lifeId(id: string): void { if (typeof id !== 'string' || !LIFE_ID.test(id)) throw new LifeRegistryError('invalid', 'Invalid Mira life ID'); }

/** The active-life registry for whole-life resets (ADR 0047). It never touches
 * append-only History; it only chooses which mira_id the service acquires. */
export class PostgresLives {
  readonly #options: PostgresOptions;
  constructor(options: PostgresOptions) {
    if (!options.connectionString) throw new Error('An explicit PostgreSQL connectionString is required');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema ?? 'public')) throw new Error('Invalid PostgreSQL schema');
    this.#options = { ...options };
  }
  async #session<T>(work: (client: Client) => Promise<T>, write = false): Promise<T> {
    const client = new Client({ connectionString: this.#options.connectionString, application_name: this.#options.applicationName ?? 'mira-lives', connectionTimeoutMillis: 5_000 });
    let failure: Error | undefined;
    client.on('error', (error: Error) => { failure = error; });
    await client.connect();
    try {
      await client.query(write ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN READ ONLY');
      await client.query(`SET LOCAL search_path TO "${this.#options.schema ?? 'public'}"`);
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      if (failure) throw failure;
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await client.end().catch(() => {}); }
  }
  /** The active life of a slot. An unregistered slot is its own generation 0. */
  async active(slot: string): Promise<{ miraId: string; generation: number }> {
    slotName(slot);
    return this.#session(async client => {
      const row = (await client.query<{ mira_id: string; generation: number }>('SELECT mira_id, generation FROM mira_active_life WHERE slot = $1', [slot])).rows[0];
      return row ? { miraId: row.mira_id, generation: row.generation } : { miraId: slot, generation: 0 };
    });
  }
  async list(slot: string): Promise<MiraLife[]> {
    slotName(slot);
    return this.#session(async client => (await client.query<LifeRow>(`SELECT l.*, a.mira_id IS NOT NULL AS active FROM mira_lives l
      LEFT JOIN mira_active_life a ON a.mira_id = l.mira_id WHERE l.slot = $1 ORDER BY l.generation`, [slot])).rows.map(life));
  }
  /** The life (if any) a reset ID created; used to resume a journaled reset. */
  async byReset(resetId: string): Promise<MiraLife | null> {
    if (!RESET_ID.test(resetId)) throw new LifeRegistryError('invalid', 'Invalid reset ID');
    return this.#session(async client => {
      const row = (await client.query<LifeRow>(`SELECT l.*, a.mira_id IS NOT NULL AS active FROM mira_lives l
        LEFT JOIN mira_active_life a ON a.mira_id = l.mira_id WHERE l.reset_id = $1`, [resetId])).rows[0];
      return row ? life(row) : null;
    });
  }
  /** Read-only preflight counts of what a reset leaves behind in this life. */
  async impact(miraId: string): Promise<LifeImpact> {
    lifeId(miraId);
    return this.#session(async client => {
      const row = (await client.query<{ messages: string; compactions: string; pending_wakes: string; pending_deliveries: string; running: boolean }>(`SELECT
        (SELECT count(*) FROM life_events WHERE mira_id = $1 AND event->>'source' = 'user' AND event->>'type' = 'web.message')
          + (SELECT count(*) FROM context_records WHERE mira_id = $1 AND envelope->>'kind' = 'message'
              AND envelope->'payload'->>'type' = 'message' AND envelope->'payload'->'message'->>'role' = 'assistant'
              AND EXISTS (SELECT 1 FROM json_array_elements(CASE WHEN json_typeof(envelope->'payload'->'message'->'content') = 'array' THEN envelope->'payload'->'message'->'content' ELSE '[]'::json END) block
                WHERE block->>'type' = 'text' AND length(block->>'text') > 0)) AS messages,
        (SELECT count(*) FROM context_records WHERE mira_id = $1 AND envelope->>'kind' = 'checkpoint') AS compactions,
        (SELECT count(*) FROM wake_requests w WHERE w.mira_id = $1 AND NOT EXISTS (SELECT 1 FROM wake_run_requests r WHERE r.mira_id = w.mira_id AND r.wake_id = w.wake_id)) AS pending_wakes,
        (SELECT count(*) FROM scheduled_deliveries WHERE mira_id = $1 AND status = 'pending') AS pending_deliveries,
        EXISTS (SELECT 1 FROM wake_runs WHERE mira_id = $1 AND NOT completed) AS running`, [miraId])).rows[0]!;
      return { messages: Number(row.messages), compactions: Number(row.compactions), pendingWakes: Number(row.pending_wakes), pendingDeliveries: Number(row.pending_deliveries), runningWake: row.running };
    });
  }
  /** Fence a life: no writer may hold it during the switch, and any stale
   * writer that reconnects later fails its epoch check. */
  async #fence(client: Client, miraId: string): Promise<void> {
    const owner = (await client.query<{ lock_key: number }>('SELECT lock_key FROM mira_owners WHERE mira_id = $1 FOR UPDATE', [miraId])).rows[0];
    if (!owner) throw new LifeRegistryError('missing', 'Mira life is not registered');
    const locked = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS acquired', [OWNER_NAMESPACE, owner.lock_key])).rows[0];
    if (!locked?.acquired) throw new LifeRegistryError('ownership', 'Another process still owns this Mira; stop it first');
    await client.query('UPDATE mira_owners SET epoch = epoch + 1 WHERE mira_id = $1', [miraId]);
  }
  async #activeRow(client: Client, slot: string): Promise<{ mira_id: string; generation: number } | undefined> {
    return (await client.query<{ mira_id: string; generation: number }>('SELECT mira_id, generation FROM mira_active_life WHERE slot = $1 FOR UPDATE', [slot])).rows[0];
  }
  /** Lazily register generation 0 of a slot that predates this registry. */
  async #registerOrigin(client: Client, slot: string): Promise<void> {
    await client.query('INSERT INTO mira_lives(mira_id, slot, generation) VALUES ($1, $1, 0) ON CONFLICT (mira_id) DO NOTHING', [slot]);
    await client.query('INSERT INTO mira_active_life(slot, mira_id, generation) VALUES ($1, $1, 0)', [slot]);
  }
  /** Atomically start the next generation: register its owner row, archive the
   * old life's metadata, cancel its pending one-shot deliveries and move the
   * active pointer by CAS. Replaying the same reset ID returns the first result. */
  async startNewLife(input: { slot: string; from: string; resetId: string; archivePath: string; reason: string }): Promise<LifeSwitch> {
    slotName(input.slot); lifeId(input.from);
    if (!RESET_ID.test(input.resetId)) throw new LifeRegistryError('invalid', 'Invalid reset ID');
    if (typeof input.archivePath !== 'string' || !input.archivePath.startsWith('/') || input.archivePath.length > 4096) throw new LifeRegistryError('invalid', 'Invalid archive path');
    return this.#session(async client => {
      const prior = (await client.query<{ mira_id: string; generation: number }>('SELECT mira_id, generation FROM mira_lives WHERE reset_id = $1', [input.resetId])).rows[0];
      if (prior) return { from: input.from, to: prior.mira_id, generation: prior.generation, created: false, cancelledDeliveries: 0 };
      let active = await this.#activeRow(client, input.slot);
      if (!active) {
        if (input.from !== input.slot) throw new LifeRegistryError('conflict', 'The active Mira life changed; preview the reset again');
        await this.#fence(client, input.from);
        await this.#registerOrigin(client, input.slot);
        active = { mira_id: input.slot, generation: 0 };
      } else {
        if (active.mira_id !== input.from) throw new LifeRegistryError('conflict', 'The active Mira life changed; preview the reset again');
        await this.#fence(client, input.from);
      }
      const next = (await client.query<{ next: number }>('SELECT coalesce(max(generation), 0) + 1 AS next FROM mira_lives WHERE slot = $1', [input.slot])).rows[0]!.next;
      const to = `${input.slot}~g${next}`;
      await client.query('INSERT INTO mira_owners(mira_id) VALUES ($1)', [to]);
      await client.query('INSERT INTO mira_lives(mira_id, slot, generation, reset_id) VALUES ($1, $2, $3, $4)', [to, input.slot, next, input.resetId]);
      await client.query(`UPDATE mira_lives SET archived_at = date_trunc('milliseconds', clock_timestamp()), archive_path = $2, reset_reason = $3 WHERE mira_id = $1`,
        [input.from, input.archivePath, input.reason]);
      await client.query(`UPDATE mira_active_life SET mira_id = $2, generation = $3, updated_at = date_trunc('milliseconds', clock_timestamp()) WHERE slot = $1`, [input.slot, to, next]);
      // A pending one-shot of the old life must never fire into the new one.
      const cancelled = await client.query(`UPDATE scheduled_deliveries SET status = 'cancelled', version = version + 1,
        updated_at = date_trunc('milliseconds', clock_timestamp()) WHERE mira_id = $1 AND status = 'pending'`, [input.from]);
      return { from: input.from, to, generation: next, created: true, cancelledDeliveries: cancelled.rowCount ?? 0 };
    }, true);
  }
  /** CLI-only: make an archived life of the same slot active again. The
   * current life is archived at `archivePath`; returns where the restored
   * life's files were archived. Both lives must have no running writer. */
  async restoreLife(input: { slot: string; target: string; archivePath: string }): Promise<{ from: string; to: string; targetArchivePath: string | null }> {
    slotName(input.slot); lifeId(input.target);
    if (typeof input.archivePath !== 'string' || !input.archivePath.startsWith('/')) throw new LifeRegistryError('invalid', 'Invalid archive path');
    return this.#session(async client => {
      let active = await this.#activeRow(client, input.slot);
      const target = (await client.query<{ slot: string; generation: number; archive_path: string | null }>('SELECT slot, generation, archive_path FROM mira_lives WHERE mira_id = $1 FOR UPDATE', [input.target])).rows[0];
      if (!target || target.slot !== input.slot) throw new LifeRegistryError('missing', 'No archived life with this ID in this slot');
      if (!active) {
        await this.#registerOrigin(client, input.slot);
        active = { mira_id: input.slot, generation: 0 };
      }
      if (active.mira_id === input.target) throw new LifeRegistryError('conflict', 'This life is already active');
      await this.#fence(client, active.mira_id);
      await this.#fence(client, input.target);
      await client.query(`UPDATE mira_lives SET archived_at = date_trunc('milliseconds', clock_timestamp()), archive_path = $2, reset_reason = 'restore' WHERE mira_id = $1`, [active.mira_id, input.archivePath]);
      await client.query('UPDATE mira_lives SET archived_at = NULL, archive_path = NULL WHERE mira_id = $1', [input.target]);
      await client.query(`UPDATE mira_active_life SET mira_id = $2, generation = $3, updated_at = date_trunc('milliseconds', clock_timestamp()) WHERE slot = $1`, [input.slot, input.target, target.generation]);
      return { from: active.mira_id, to: input.target, targetArchivePath: target.archive_path };
    }, true);
  }
}
