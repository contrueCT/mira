import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import type { ScheduledDeliveryInput } from '@mira/life';
import { migrate, PersistenceError } from '@mira/persistence';
import { createTestDatabase, testDatabaseUrl } from './database.mts';

testDatabaseUrl();
const owner = 'extension:synthetic.reminders';
const past = '2000-01-01T00:00:00.000Z';
const future = '2999-01-01T00:00:00.000Z';
const emptyDispatch = { enqueued: 0, nextDueAt: null };
function input(patch: Partial<ScheduledDeliveryInput> = {}): ScheduledDeliveryInput {
  const key = patch.key ?? randomUUID();
  return { key, dueAt: past,
    event: { id: `scheduled:${key}:event`, type: 'synthetic.scheduled', source: 'extension', occurredAt: past,
      payload: { nested: { text: 'one synthetic occurrence' } } },
    wake: { id: `scheduled:${key}:wake`, reason: 'One synthetic scheduled Wake' }, ...patch };
}
type Database = Awaited<ReturnType<typeof createTestDatabase>>;
async function counts(db: Database) {
  return (await db.admin.query<{ events: number; wakes: number }>(
    'SELECT (SELECT count(*)::integer FROM life_events) AS events, (SELECT count(*)::integer FROM wake_requests) AS wakes')).rows[0]!;
}

test('single-shot creation is exact-input idempotent, cloned, scoped by owner and Mira, and durable across restart', async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire();
    const original = input({ dueAt: future });
    const frozen = structuredClone(original);
    const creating = writer.createScheduledDelivery(owner, original);
    original.event.payload = { mutated: true };
    const first = await creating;
    assert.equal(first.status, 'updated'); assert(first.delivery);
    assert.equal(first.delivery.status, 'pending'); assert.equal(first.delivery.version, 1);
    assert.equal(first.delivery.owner, owner); assert.deepEqual(first.delivery.event, frozen.event);
    assert.equal(new Date(first.delivery.createdAt).toISOString(), first.delivery.createdAt);
    assert.equal((await writer.createScheduledDelivery(owner, frozen)).status, 'duplicate');
    for (const changed of [
      { ...frozen, dueAt: past }, { ...frozen, expiresAt: future },
      { ...frozen, event: { ...frozen.event, payload: { different: true } } },
      { ...frozen, wake: { ...frozen.wake!, reason: 'Different reason' } },
      (({ wake: _wake, ...noWake }) => noWake)(frozen),
    ]) assert.equal((await writer.createScheduledDelivery(owner, changed)).status, 'conflict');
    first.delivery.event.payload = { mutated: 'return value' };
    const list = await writer.listScheduledDeliveries(owner); assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.event, frozen.event); list[0]!.event.payload = { mutated: 'list' };
    assert.deepEqual((await writer.getScheduledDelivery(owner, frozen.key))!.event, frozen.event);
    assert.equal(await writer.getScheduledDelivery('other-owner', frozen.key), null);
    assert.equal((await writer.createScheduledDelivery('other-owner', frozen)).status, 'updated');
    assert.deepEqual((await writer.listScheduledDeliveries()).map(delivery => delivery.owner).sort(), [owner, 'other-owner'].sort());
    const other = await db.acquire('other-mira');
    assert.equal((await other.createScheduledDelivery(owner, frozen)).status, 'updated');
    assert.deepEqual(await counts(db), { events: 0, wakes: 0 }, 'registration never emits');
    await writer.close(); writer = await db.acquire();
    assert.equal((await writer.createScheduledDelivery(owner, frozen)).status, 'duplicate');
    assert.deepEqual(await writer.dispatchScheduledDeliveries([owner]), { enqueued: 0, nextDueAt: future });
    assert.deepEqual(await writer.dispatchScheduledDeliveries([]), emptyDispatch);
  } finally { await db.close(); }
});

test('replace and cancel use pending-only CAS, preserving stable keys and preventing old-version publication', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const old = input();
    await writer.createScheduledDelivery(owner, old);
    const replacement = { ...old, dueAt: future, event: { ...old.event, payload: { text: 'replacement' } } };
    const changed = await writer.replaceScheduledDelivery(owner, 1, replacement);
    assert.equal(changed.status, 'updated'); assert.equal(changed.delivery!.key, old.key); assert.equal(changed.delivery!.version, 2);
    assert.equal((await writer.replaceScheduledDelivery(owner, 1, old)).status, 'conflict');
    assert.equal((await writer.cancelScheduledDelivery(owner, old.key, 1)).status, 'conflict');
    assert.deepEqual(await writer.dispatchScheduledDeliveries([owner]), { enqueued: 0, nextDueAt: future });
    assert.deepEqual(await counts(db), { events: 0, wakes: 0 }, 'superseded due version cannot emit');
    assert.deepEqual(await writer.replaceScheduledDelivery(owner, 1, input()), { status: 'missing', delivery: null });
    assert.deepEqual(await writer.cancelScheduledDelivery(owner, 'missing', 1), { status: 'missing', delivery: null });
    assert.equal((await writer.createScheduledDelivery(owner, old)).status, 'conflict');
    assert.equal((await writer.createScheduledDelivery(owner, replacement)).status, 'duplicate');
    const cancelled = await writer.cancelScheduledDelivery(owner, old.key, 2);
    assert.equal(cancelled.status, 'updated'); assert.equal(cancelled.delivery!.status, 'cancelled'); assert.equal(cancelled.delivery!.version, 3);
    assert.equal((await writer.cancelScheduledDelivery(owner, old.key, 2)).status, 'settled');
    assert.equal((await writer.replaceScheduledDelivery(owner, 3, old)).status, 'settled');
    assert.deepEqual(await writer.dispatchScheduledDeliveries([owner]), emptyDispatch);
    assert.deepEqual(await counts(db), { events: 0, wakes: 0 });
    const another = input({ dueAt: future });
    await writer.createScheduledDelivery(owner, another);
    const nowDue = { ...another, dueAt: past, event: { ...another.event, payload: { latest: 'only this version emits' } } };
    assert.equal((await writer.replaceScheduledDelivery(owner, 1, nowDue)).status, 'updated');
    assert.equal((await writer.dispatchScheduledDeliveries([owner])).enqueued, 1);
    assert.equal((await writer.getScheduledDelivery(owner, another.key))!.version, 3);
    assert.deepEqual((await writer.claimWakeBatch())!.requests[0]!.event, nowDue.event);
  } finally { await db.close(); }
});

test('due dispatch publishes exact ordinary Event/Wake once, marks expiry honestly, and excludes inactive owners', async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire();
    const due = input(); const noWake = input(); delete noWake.wake;
    const expired = input({ expiresAt: past }); const later = input({ dueAt: future }); const inactive = input();
    for (const value of [due, noWake, expired, later]) await writer.createScheduledDelivery(owner, value);
    await writer.createScheduledDelivery('disabled-extension', inactive);
    const results = await Promise.all(Array.from({ length: 5 }, () => writer.dispatchScheduledDeliveries([owner, owner])));
    assert.equal(results.reduce((sum, result) => sum + result.enqueued, 0), 2);
    assert(results.every(result => result.nextDueAt === future));
    assert.deepEqual(await counts(db), { events: 2, wakes: 1 });
    for (const value of [due, noWake]) {
      const saved = await writer.getScheduledDelivery(owner, value.key);
      assert.equal(saved!.status, 'enqueued'); assert.equal(saved!.version, 2);
      assert.equal((await writer.cancelScheduledDelivery(owner, value.key, 1)).status, 'settled');
      assert.equal((await writer.replaceScheduledDelivery(owner, 2, value)).status, 'settled');
    }
    assert.equal((await writer.getScheduledDelivery(owner, expired.key))!.status, 'expired');
    assert.equal((await writer.getScheduledDelivery(owner, expired.key))!.version, 2);
    assert.equal((await writer.getScheduledDelivery('disabled-extension', inactive.key))!.status, 'pending');
    const run = await writer.claimWakeBatch(); assert(run); assert.equal(run.requests.length, 1);
    assert.deepEqual(run.requests[0]!.event, due.event); assert.deepEqual(run.requests[0]!.wake, due.wake);
    assert.equal((await writer.load()).version, 0, 'scheduler does not append runtime context');
    await writer.close(); writer = await db.acquire();
    assert.deepEqual(await writer.dispatchScheduledDeliveries([owner]), { enqueued: 0, nextDueAt: future });
    assert.equal((await writer.claimWakeBatch())!.id, run.id);
    assert.equal((await writer.dispatchScheduledDeliveries(['disabled-extension'])).enqueued, 1);
    assert.equal((await writer.claimWakeBatch())!.requests.length, 1, 'new arrivals do not rewrite active batch');
    assert.deepEqual(await counts(db), { events: 3, wakes: 2 });
  } finally { await db.close(); }
});

for (const first of ['cancel', 'dispatch'] as const) test(`${first} wins its serialization boundary without pretending to retract enqueued work`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const value = input(); await writer.createScheduledDelivery(owner, value);
    if (first === 'cancel') {
      const [cancelled, dispatched] = await Promise.all([
        writer.cancelScheduledDelivery(owner, value.key, 1), writer.dispatchScheduledDeliveries([owner]),
      ]);
      assert.equal(cancelled.status, 'updated'); assert.deepEqual(dispatched, emptyDispatch);
      assert.deepEqual(await counts(db), { events: 0, wakes: 0 });
    } else {
      const [dispatched, cancelled] = await Promise.all([
        writer.dispatchScheduledDeliveries([owner]), writer.cancelScheduledDelivery(owner, value.key, 1),
      ]);
      assert.equal(dispatched.enqueued, 1); assert.equal(cancelled.status, 'settled');
      assert.equal(cancelled.delivery!.status, 'enqueued');
      assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    }
  } finally { await db.close(); }
});

test('canonical UTC validation, safe versions, and database clock hold before any mutation', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const value = input({ dueAt: future });
    for (const dueAt of ['2026-10-14', '2026-10-14T00:00:00Z', '2026-10-14T01:00:00.000+01:00', '2026-02-30T00:00:00.000Z', '0000-01-01T00:00:00.000Z', 'bad']) {
      assert.throws(() => writer.createScheduledDelivery(owner, { ...value, dueAt }), PersistenceError);
    }
    assert.throws(() => writer.createScheduledDelivery(owner, { ...value, expiresAt: past }), /expiry/);
    for (const expected of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => writer.replaceScheduledDelivery(owner, expected, value), /version/);
      assert.throws(() => writer.cancelScheduledDelivery(owner, value.key, expected), /version/);
    }
    assert.throws(() => writer.createScheduledDelivery('', value), /owner/);
    assert.throws(() => writer.dispatchScheduledDeliveries(['']), /owner/);
    assert.deepEqual(await writer.listScheduledDeliveries(owner), []);
    await writer.createScheduledDelivery(owner, value);
    const originalNow = Date.now; Date.now = () => Date.parse('9999-01-01T00:00:00.000Z');
    try { assert.deepEqual(await writer.dispatchScheduledDeliveries([owner]), { enqueued: 0, nextDueAt: future }); }
    finally { Date.now = originalNow; }
    await db.admin.query('UPDATE scheduled_deliveries SET version = $1', [Number.MAX_SAFE_INTEGER]);
    await assert.rejects(writer.replaceScheduledDelivery(owner, Number.MAX_SAFE_INTEGER, value), /exhausted/);
    await assert.rejects(writer.cancelScheduledDelivery(owner, value.key, Number.MAX_SAFE_INTEGER), /exhausted/);
    assert.equal((await writer.getScheduledDelivery(owner, value.key))!.version, Number.MAX_SAFE_INTEGER);
    assert.equal(writer.signal.aborted, false);
  } finally { await db.close(); }
});

test('a conflicting Event/Wake receipt rolls back the schedule marker and every due insertion', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const existing = input();
    await writer.receive(existing.event, existing.wake);
    const conflicting = { ...existing, event: { ...existing.event, payload: { changed: true } } };
    const before = input({ dueAt: '1999-01-01T00:00:00.000Z' });
    await writer.createScheduledDelivery(owner, before); await writer.createScheduledDelivery(owner, conflicting);
    await assert.rejects(writer.dispatchScheduledDeliveries([owner]), error => error instanceof PersistenceError && error.code === 'duplicate');
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    assert((await writer.listScheduledDeliveries(owner)).every(delivery => delivery.status === 'pending' && delivery.version === 1));
    assert.equal(writer.signal.aborted, false, 'honest content conflict does not stop healthy ownership');
  } finally { await db.close(); }
});

test('lost schedule COMMIT acknowledgement preserves the exact authoritative row and ordinary Wake after restart', async context => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire(); const value = input(); await writer.createScheduledDelivery(owner, value);
    const query = Client.prototype.query; let loseReply = true;
    const injected = context.mock.method(Client.prototype, 'query', async function(this: Client, ...args: unknown[]) {
      const result: unknown = await Reflect.apply(query, this, args);
      if (args[0] === 'COMMIT' && loseReply) { loseReply = false; throw new Error('synthetic lost scheduling COMMIT acknowledgement'); }
      return result;
    });
    try { await assert.rejects(writer.dispatchScheduledDeliveries([owner]), /lost scheduling COMMIT acknowledgement/); }
    finally { injected.mock.restore(); }
    assert(writer.signal.aborted); await writer.close(); writer = await db.acquire();
    assert.equal((await writer.getScheduledDelivery(owner, value.key))!.status, 'enqueued');
    assert.equal((await writer.getScheduledDelivery(owner, value.key))!.version, 2);
    assert.deepEqual(await writer.dispatchScheduledDeliveries([owner]), emptyDispatch);
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    assert.deepEqual((await writer.claimWakeBatch())!.requests[0]!.event, value.event);
  } finally { await db.close(); }
});

test('ownership loss during enqueue rolls back Event, Wake and marker; old writer cannot mutate after takeover', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const value = input(); await writer.createScheduledDelivery(owner, value);
    await db.admin.query(`CREATE FUNCTION drop_schedule_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_unlock_all(); RETURN NEW; END $$;
      CREATE TRIGGER drop_schedule_lock AFTER INSERT ON life_events FOR EACH ROW EXECUTE FUNCTION drop_schedule_lock()`);
    await assert.rejects(writer.dispatchScheduledDeliveries([owner]), error => error instanceof PersistenceError && error.code === 'ownership');
    assert(writer.signal.aborted); await writer.close();
    await db.admin.query('DROP TRIGGER drop_schedule_lock ON life_events');
    assert.deepEqual(await counts(db), { events: 0, wakes: 0 });
    const next = await db.acquire();
    assert.equal((await next.getScheduledDelivery(owner, value.key))!.status, 'pending');
    await assert.rejects(writer.cancelScheduledDelivery(owner, value.key, 1), /Writer is stopped/);
    assert.deepEqual(await next.dispatchScheduledDeliveries([owner]), { enqueued: 1, nextDueAt: null });
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
  } finally { await db.close(); }
});

for (const boundary of ['before', 'after'] as const) test(`SIGKILL ${boundary} scheduling COMMIT recovers exactly one durable enqueue`, { timeout: 20_000 }, async () => {
  const db = await createTestDatabase();
  let child: ReturnType<typeof fork> | undefined;
  try {
    const writer = await db.acquire(); const value = input(); await writer.createScheduledDelivery(owner, value); await writer.close();
    const applicationName = `mira-scheduling-crash-${randomUUID()}`;
    const env: NodeJS.ProcessEnv = { MIRA_TEST_DATABASE_URL: db.connectionString };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) if (process.env[key] !== undefined) env[key] = process.env[key];
    child = fork(new URL('./fixtures/scheduling-worker.mts', import.meta.url), [db.schema, applicationName, owner, boundary], {
      env, execArgv: ['--import', new URL('../deny-model-network.mts', import.meta.url).pathname], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit');
    const notice = await Promise.race([
      once(child, 'message').then(([message]) => message as unknown),
      exited.then(([code, signal]) => { throw new Error(`Scheduling worker exited early: ${code}/${signal}: ${stderr}`); }),
    ]);
    assert.deepEqual(notice, { boundary });
    assert(child.kill('SIGKILL'));
    const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    const deadline = Date.now() + 5_000;
    while ((await db.admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [applicationName])).rowCount) {
      if (Date.now() > deadline) throw new Error('Killed scheduling process still owns a backend');
      await delay(10);
    }
    const restarted = await db.acquire(); const saved = await restarted.getScheduledDelivery(owner, value.key);
    assert.equal(saved!.status, boundary === 'before' ? 'pending' : 'enqueued');
    assert.equal(saved!.version, boundary === 'before' ? 1 : 2);
    assert.deepEqual(await counts(db), boundary === 'before' ? { events: 0, wakes: 0 } : { events: 1, wakes: 1 });
    assert.equal((await restarted.dispatchScheduledDeliveries([owner])).enqueued, boundary === 'before' ? 1 : 0);
    assert.deepEqual(await restarted.dispatchScheduledDeliveries([owner]), emptyDispatch);
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    assert.deepEqual((await restarted.claimWakeBatch())!.requests[0]!.event, value.event);
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await db.close(); }
});

test('scheduling down/up removes only its own slice and preserves ordinary history', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const value = input();
    await writer.createScheduledDelivery(owner, value); await writer.dispatchScheduledDeliveries([owner]); await writer.close();
    // The background-job index (ADR 0049), the usage indexes (ADR 0048), then the Mira lives registry (ADR 0047), are the latest independent slices.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    // Task live-input ownership is an independent later slice.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('subagent_calls','subagent_live_inputs')", [db.schema])).rows[0].n, 0);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='subagent_turns' AND column_name IN ('stream_id','input_record_id','final_record_id')", [db.schema])).rows[0].n, 0);
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    // The activity/association migration only adds columns to the child slice.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='subagent_turns' AND column_name IN ('activity','started_at','association_order')", [db.schema])).rows[0].n, 0);
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    // Later independent feature slices must be removed in migration order first.
    for (const table of ['subagent_turns', 'wake_live_inputs', 'scheduled_deliveries']) {
      await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
      assert.equal((await db.admin.query('SELECT to_regclass($1) AS name', [table])).rows[0].name, null);
      assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    }
    assert.equal((await db.admin.query("SELECT to_regclass('scheduled_deliveries') AS name")).rows[0].name, null);
    assert.deepEqual(await counts(db), { events: 1, wakes: 1 });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'up' });
    const restarted = await db.acquire(); assert.deepEqual(await restarted.listScheduledDeliveries(owner), []);
    assert.deepEqual((await restarted.claimWakeBatch())!.requests[0]!.event, value.event);
  } finally { await db.close(); }
});
