import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import type { RuntimeRecord } from '@mira/context';
import type { DreamingRequest, DreamingWriter, LifeEvent, WakeRun } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { createTestDatabase, testDatabaseUrl } from './database.mts';

testDatabaseUrl();
const idleMs = 30 * 60_000;
const intervalMs = 24 * 60 * 60_000;
const policy: DreamingRequest = { idleMs, intervalMs, minCompactions: 3, instruction: 'Review new experiences using ordinary Memory files and tools; stay silent unless something matters.' };
const waiting = { status: 'waiting', nextCheckAt: null };
const event = (source: LifeEvent['source'] = 'user', occurredAt = '1900-01-01T00:00:00.000Z'): LifeEvent => ({
  id: randomUUID(), type: 'synthetic.experience', source, occurredAt, payload: { text: 'A synthetic new experience' },
});
const record = (parentId: string | null, kind: RuntimeRecord['kind'] = 'message'): RuntimeRecord => ({
  formatVersion: 1, runtime: 'synthetic-runtime', runtimeVersion: '1', id: randomUUID(), parentId, kind,
  occurredAt: '1900-01-01T00:00:00.000Z', payload: { opaque: ['not a Pi payload', 42] },
});
type Database = Awaited<ReturnType<typeof createTestDatabase>>;
async function receive(writer: DreamingWriter, input = event()): Promise<void> {
  await writer.receive(input, { id: input.id, reason: 'Synthetic explicit Wake' });
}
async function finish(writer: DreamingWriter, run?: WakeRun): Promise<WakeRun> {
  run ??= (await writer.claimWakeBatch()) ?? undefined;
  assert(run);
  const before = await writer.load();
  const input = record(before.records.at(-1)?.id ?? null);
  const next = await writer.appendWakeInput(run.id, before.version, input);
  await writer.appendWakeFinal(run.id, next, record(input.id));
  await writer.completeWakeRun(run.id);
  return run;
}
async function checkpoints(writer: DreamingWriter, count: number): Promise<void> {
  let snapshot = await writer.load();
  for (let n = 0; n < count; n++) {
    const next = record(snapshot.records.at(-1)?.id ?? null, 'checkpoint');
    const version = await writer.append(snapshot.version, next);
    snapshot = { ...snapshot, version, records: [...snapshot.records, next] };
  }
}
async function progress(db: Database, miraId = 'synthetic-mira') {
  return (await db.admin.query<{ last_triggered_at: Date; idle_since: Date; consumed_receipt_order: string; checkpoint_version: string }>(
    'SELECT last_triggered_at, idle_since, consumed_receipt_order, checkpoint_version FROM dreaming_progress WHERE mira_id = $1', [miraId])).rows[0]!;
}
async function ageIdle(db: Database): Promise<void> {
  await db.admin.query("UPDATE dreaming_progress SET idle_since = clock_timestamp() - interval '31 minutes'");
}
async function ageInterval(db: Database): Promise<void> {
  await db.admin.query("UPDATE dreaming_progress SET last_triggered_at = clock_timestamp() - interval '25 hours'");
}
async function eligible(db: Database, writer: DreamingWriter): Promise<void> {
  await writer.initializeDreaming(); await receive(writer); await finish(writer); await ageIdle(db); await ageInterval(db);
}
async function dreamingCount(db: Database): Promise<number> {
  return (await db.admin.query<{ count: number }>("SELECT count(*)::integer AS count FROM life_events WHERE event->>'type' = 'memory.dreaming'")).rows[0]!.count;
}

test('Dreaming enable time is an idempotent durable baseline, excluding existing receipts and checkpoints', async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire();
    await receive(writer); await finish(writer); await checkpoints(writer, 3);
    await assert.rejects(writer.requestDreaming(policy), /Initialize Dreaming/);
    await writer.initializeDreaming();
    const first = await progress(db);
    assert.equal(first.checkpoint_version, '5');
    assert.equal(first.consumed_receipt_order, '1');
    assert(Math.abs(Date.now() - first.last_triggered_at.getTime()) < 5_000);
    await writer.close(); writer = await db.acquire();
    await writer.initializeDreaming();
    assert.deepEqual(await progress(db), first);
    await ageIdle(db); await ageInterval(db);
    assert.deepEqual(await writer.requestDreaming(policy), waiting, 'no post-enable experience means no empty Dreaming');
    await receive(writer); await finish(writer); await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
  } finally { await db.close(); }
});

test('three successful checkpoint publications trigger only after thirty continuous idle minutes', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.initializeDreaming(); await receive(writer); await finish(writer);
    await checkpoints(writer, 2); await ageIdle(db);
    const initial = await progress(db);
    assert.deepEqual(await writer.requestDreaming(policy), {
      status: 'waiting', nextCheckAt: new Date(initial.last_triggered_at.getTime() + intervalMs + 1).toISOString(),
    }, 'strictly greater than 24h is represented by the next millisecond');
    const snapshot = await writer.load();
    await assert.rejects(writer.append(snapshot.version - 1, record(snapshot.records.at(-1)!.id, 'checkpoint')), /Stale context/);
    assert.equal((await writer.requestDreaming(policy)).status, 'waiting', 'failed CAS does not count');
    await checkpoints(writer, 1);
    await db.admin.query('UPDATE dreaming_progress SET idle_since = clock_timestamp()');
    const idle = await progress(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'waiting', nextCheckAt: new Date(idle.idle_since.getTime() + idleMs).toISOString() });
    await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
    const trigger = await progress(db);
    assert.equal(trigger.checkpoint_version, '5');
    assert.equal(trigger.consumed_receipt_order, '1');
    assert(trigger.last_triggered_at > initial.last_triggered_at);
    const run = await writer.claimWakeBatch(); assert(run);
    assert.equal(run.requests.length, 1);
    assert.equal(run.requests[0]!.event.source, 'system');
    assert.equal(run.requests[0]!.event.type, 'memory.dreaming');
    assert.deepEqual(run.requests[0]!.event.payload, { instruction: policy.instruction });
    assert.equal((await writer.load()).version, 5, 'enqueue never appends or compacts Runtime context');
  } finally { await db.close(); }
});

test('twenty-four-hour route still requires new experience and continuous idle', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.initializeDreaming(); await ageInterval(db); await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    await receive(writer); await finish(writer);
    const result = await writer.requestDreaming(policy);
    assert.equal(result.status, 'waiting');
    assert(result.status === 'waiting' && result.nextCheckAt);
    await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
    assert.equal((await writer.load()).records.filter(item => item.kind === 'checkpoint').length, 0);
  } finally { await db.close(); }
});

for (const source of ['user', 'extension', 'external'] as const) test(`explicit ${source} Wake is effective experience regardless of caller timestamp`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.initializeDreaming(); await ageInterval(db); await ageIdle(db);
    await receive(writer, event(source, source === 'external' ? '2999-01-01T00:00:00.000Z' : '1900-01-01T00:00:00.000Z'));
    const accepted = await progress(db);
    assert(Math.abs(Date.now() - accepted.idle_since.getTime()) < 5_000, 'receipt time is from the database clock');
    assert.deepEqual(await writer.requestDreaming(policy), waiting, 'pending Wake prevents Dreaming');
    await finish(writer); await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
  } finally { await db.close(); }
});

test('event-only input, notifications, system and Mira Wakes never make empty Dreaming eligible', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await writer.initializeDreaming();
    for (const source of ['user', 'external', 'extension'] as const) await writer.receive(event(source));
    await writer.receive({ ...event('external'), type: 'external.notification' });
    await receive(writer, event('system')); await receive(writer, event('mira')); await finish(writer);
    await checkpoints(writer, 3); await ageIdle(db); await ageInterval(db);
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    assert.equal(await dreamingCount(db), 0);
  } finally { await db.close(); }
});

test('active and pending Wake work blocks trigger without consuming progress, including finalized runs', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await writer.initializeDreaming();
    await receive(writer); await ageIdle(db); await ageInterval(db);
    const before = await progress(db);
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    const run = await writer.claimWakeBatch(); assert(run);
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    const input = record(null); await writer.appendWakeInput(run.id, 0, input);
    await writer.appendWakeFinal(run.id, 1, record(input.id));
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    assert.deepEqual(await progress(db), before);
    await writer.completeWakeRun(run.id);
    const completed = await progress(db);
    assert(completed.idle_since > before.idle_since, 'successful completion restarts continuous idle');
    await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
  } finally { await db.close(); }
});

test('duplicates, event-only arrivals and repeated completed-run calls do not restart idle', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await writer.initializeDreaming();
    const input = event(); await receive(writer, input); const run = await finish(writer); await ageIdle(db);
    const before = await progress(db);
    await writer.receive(input, { id: input.id, reason: 'Synthetic explicit Wake' });
    await writer.receive(event('external'));
    await writer.completeWakeRun(run.id);
    assert.deepEqual(await progress(db), before);
    await receive(writer, event('system'));
    assert((await progress(db)).idle_since > before.idle_since, 'any accepted Wake interrupts idle');
  } finally { await db.close(); }
});

test('concurrent checks atomically enqueue one ordinary Wake and restart never enqueues a second', async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire(); await eligible(db, writer);
    const results = await Promise.all(Array.from({ length: 8 }, () => writer.requestDreaming(policy)));
    assert.equal(results.filter(item => item.status === 'inserted').length, 1);
    assert.equal(await dreamingCount(db), 1);
    const triggered = await progress(db);
    // Once committed, the ordinary pending Wake is authoritative even if a
    // caller does not use the enqueue reply and instead restarts immediately.
    await writer.close(); writer = await db.acquire(); await writer.initializeDreaming();
    assert.deepEqual(await progress(db), triggered);
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    const run = await finish(writer);
    assert.equal(run.requests[0]!.event.type, 'memory.dreaming');
    await checkpoints(writer, 3); await ageIdle(db); await ageInterval(db);
    assert.deepEqual(await writer.requestDreaming(policy), waiting, 'Dreaming completion and its compactions cannot feed themselves');
    assert.equal(await dreamingCount(db), 1);
  } finally { await db.close(); }
});

test('compaction baseline resets at trigger and later experiences survive a Dreaming run', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await writer.initializeDreaming();
    await receive(writer); await finish(writer); await checkpoints(writer, 3); await ageIdle(db);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
    const run = await writer.claimWakeBatch(); assert(run);
    await receive(writer, event('external'));
    await finish(writer, run);
    await finish(writer);
    await ageIdle(db);
    assert.equal((await writer.requestDreaming(policy)).status, 'waiting', 'old checkpoints cannot retrigger');
    await checkpoints(writer, 2);
    assert.equal((await writer.requestDreaming(policy)).status, 'waiting');
    await writer.close();
    const restarted = await db.acquire(); await restarted.initializeDreaming();
    await checkpoints(restarted, 1);
    assert.deepEqual(await restarted.requestDreaming(policy), { status: 'inserted' });
    assert.equal(await dreamingCount(db), 2);
  } finally { await db.close(); }
});

for (const boundary of ['event', 'progress'] as const) test(`failure at Dreaming ${boundary} publication rolls back event, Wake and consumption`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await eligible(db, writer);
    const before = await progress(db);
    const counts = (await db.admin.query('SELECT (SELECT count(*) FROM history_records) AS history, (SELECT count(*) FROM wake_requests) AS wakes')).rows[0];
    await db.admin.query(boundary === 'event'
      ? `CREATE FUNCTION reject_dreaming() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF NEW.event->>'type' = 'memory.dreaming' THEN RAISE EXCEPTION 'synthetic Dreaming event fault'; END IF; RETURN NEW; END $$;
         CREATE TRIGGER reject_dreaming BEFORE INSERT ON life_events FOR EACH ROW EXECUTE FUNCTION reject_dreaming()`
      : `CREATE FUNCTION reject_dreaming() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
           IF NEW.last_triggered_at IS DISTINCT FROM OLD.last_triggered_at THEN RAISE EXCEPTION 'synthetic Dreaming progress fault'; END IF; RETURN NEW; END $$;
         CREATE TRIGGER reject_dreaming BEFORE UPDATE ON dreaming_progress FOR EACH ROW EXECUTE FUNCTION reject_dreaming()`);
    await assert.rejects(writer.requestDreaming(policy), /synthetic Dreaming/);
    assert.deepEqual(await progress(db), before);
    assert.equal(await dreamingCount(db), 0);
    assert.deepEqual((await db.admin.query('SELECT (SELECT count(*) FROM history_records) AS history, (SELECT count(*) FROM wake_requests) AS wakes')).rows[0], counts);
    await writer.close();
    await db.admin.query(`DROP TRIGGER reject_dreaming ON ${boundary === 'event' ? 'life_events' : 'dreaming_progress'}`);
    const restarted = await db.acquire(); await restarted.initializeDreaming();
    assert.deepEqual(await restarted.requestDreaming(policy), { status: 'inserted' });
  } finally { await db.close(); }
});

test('Dreaming trigger verifies the actual writer lock before commit and stale writers cannot initialize', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await eligible(db, writer); const before = await progress(db);
    await db.admin.query(`CREATE FUNCTION drop_dreaming_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event->>'type' = 'memory.dreaming' THEN
        PERFORM pg_advisory_unlock(1296650817, (SELECT lock_key FROM mira_owners WHERE mira_id = NEW.mira_id));
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER drop_dreaming_lock BEFORE INSERT ON life_events FOR EACH ROW EXECUTE FUNCTION drop_dreaming_lock()`);
    await assert.rejects(writer.requestDreaming(policy), error => error instanceof PersistenceError && error.code === 'ownership');
    assert(writer.signal.aborted);
    assert.deepEqual(await progress(db), before);
    assert.equal(await dreamingCount(db), 0);
    await writer.close();
    await db.admin.query('DROP TRIGGER drop_dreaming_lock ON life_events');
    const next = await db.acquire();
    await assert.rejects(writer.initializeDreaming(), /Writer is stopped/);
    assert.deepEqual(await next.requestDreaming(policy), { status: 'inserted' });
  } finally { await db.close(); }
});

test('Dreaming bookkeeping is isolated by Mira and rejects invalid thresholds before writes', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const other = await db.acquire('other-mira');
    await eligible(db, writer); await other.initializeDreaming();
    const before = await progress(db);
    for (const patch of [{ idleMs: -1 }, { intervalMs: NaN }, { minCompactions: 0 }, { instruction: '' }]) {
      assert.throws(() => writer.requestDreaming({ ...policy, ...patch }), /Invalid/);
    }
    assert.deepEqual(await progress(db), before);
    assert.deepEqual(await other.requestDreaming(policy), waiting);
    assert.deepEqual(await writer.requestDreaming(policy), { status: 'inserted' });
    assert.equal(await other.claimWakeBatch(), null);
  } finally { await db.close(); }
});


test('lost COMMIT acknowledgement preserves the committed Dreaming Wake as recovery authority', async context => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire(); await eligible(db, writer);
    const original = Client.prototype.query;
    let loseReply = true;
    const injected = context.mock.method(Client.prototype, 'query', async function(this: Client, ...args: unknown[]) {
      const result: unknown = await Reflect.apply(original, this, args);
      if (args[0] === 'COMMIT' && loseReply) {
        loseReply = false;
        throw new Error('synthetic lost Dreaming COMMIT acknowledgement');
      }
      return result;
    });
    try {
      await assert.rejects(writer.requestDreaming(policy), /lost Dreaming COMMIT acknowledgement/);
    } finally { injected.mock.restore(); }
    assert(writer.signal.aborted, 'uncertain transaction stops its writer');
    assert.equal(await dreamingCount(db), 1, 'the real transaction had committed before its response was lost');
    const saved = await progress(db);
    await writer.close(); writer = await db.acquire(); await writer.initializeDreaming();
    assert.deepEqual(await progress(db), saved);
    assert.deepEqual(await writer.requestDreaming(policy), waiting);
    const resumed = await finish(writer);
    assert.equal(resumed.requests[0]!.event.type, 'memory.dreaming');
    assert.equal(await dreamingCount(db), 1);
  } finally { await db.close(); }
});


for (const boundary of ['before', 'after'] as const) test(`process death ${boundary} Dreaming COMMIT recovers the exact durable enqueue decision`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await eligible(db, writer); const before = await progress(db); await writer.close();
    const applicationName = `mira-dreaming-crash-${randomUUID()}`;
    const source = `
      import { Client } from 'pg';
      import { PostgresPersistence } from '@mira/persistence';
      const writer = await new PostgresPersistence({
        connectionString: process.env.MIRA_TEST_DATABASE_URL,
        schema: ${JSON.stringify(db.schema)}, applicationName: ${JSON.stringify(applicationName)},
      }).acquire('synthetic-mira');
      const original = Client.prototype.query;
      Client.prototype.query = async function (...args) {
        if (args[0] === 'COMMIT' && ${JSON.stringify(boundary)} === 'before') process.exit(81);
        const result = await original.apply(this, args);
        if (args[0] === 'COMMIT') process.exit(82);
        return result;
      };
      await writer.requestDreaming(${JSON.stringify(policy)});
      process.exit(83);
    `;
    const env: NodeJS.ProcessEnv = { MIRA_TEST_DATABASE_URL: db.connectionString };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    await assert.rejects(promisify(execFile)(process.execPath, [
      '--import', new URL('../deny-model-network.mts', import.meta.url).pathname, '--input-type=module', '--eval', source,
    ], { env, timeout: 15_000 }), error => error instanceof Error && 'code' in error && error.code === (boundary === 'before' ? 81 : 82));
    const deadline = Date.now() + 5_000;
    while ((await db.admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [applicationName])).rowCount) {
      if (Date.now() > deadline) throw new Error('Crashed Dreaming process still has a database backend');
      await delay(10);
    }
    const restarted = await db.acquire(); await restarted.initializeDreaming();
    if (boundary === 'before') {
      assert.equal(await dreamingCount(db), 0);
      assert.deepEqual(await progress(db), before, 'pre-COMMIT process death consumes no experience or checkpoint');
      assert.deepEqual(await restarted.requestDreaming(policy), { status: 'inserted' });
    } else {
      assert.equal(await dreamingCount(db), 1);
      assert.equal((await progress(db)).consumed_receipt_order, '1');
      assert.deepEqual(await restarted.requestDreaming(policy), waiting, 'post-COMMIT process death preserves its single pending Wake');
    }
    const run = await finish(restarted);
    assert.equal(run.requests[0]!.event.type, 'memory.dreaming');
    assert.equal(await dreamingCount(db), 1);
  } finally { await db.close(); }
});
