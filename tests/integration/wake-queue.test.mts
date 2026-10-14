import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeRecord } from '@mira/context';
import type { LifeEvent, WakeReceipt } from '@mira/life';
import { migrate, PersistenceError, PostgresPersistence } from '@mira/persistence';
import { createTestDatabase, testDatabaseUrl, testHistoryId as uuid } from './database.mts';

const now = '2026-10-05T00:00:00.000Z';
const event = (id: string, occurredAt = now): LifeEvent => ({ id, type: 'synthetic.request', source: 'external', occurredAt, payload: { synthetic: id } });
const wake = (id: string): WakeReceipt => ({ id, reason: `synthetic attention ${id}` });
const record = (id: string, parentId: string | null = null): RuntimeRecord => ({
  formatVersion: 1, runtime: 'synthetic-runtime', runtimeVersion: '1', kind: 'message', id, parentId,
  occurredAt: now, payload: { synthetic: id, opaque: [true, null, 42] },
});
const code = (expected: PersistenceError['code']) => (error: unknown) => error instanceof PersistenceError && error.code === expected;

testDatabaseUrl();

test('wake claim coalesces every pending receipt in durable arrival order; events alone never claim', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    assert.equal(await writer.claimWakeBatch(), null);
    await writer.receive(event('event-only'));
    assert.equal(await writer.claimWakeBatch(), null);
    const pairs = [
      { event: event('newer-time', '2026-10-05T12:00:00.000Z'), wake: wake('z') },
      { event: event('older-time', '2026-10-05T01:00:00.000Z'), wake: wake('a') },
      { event: event('third'), wake: wake('m') },
    ];
    for (const pair of pairs) await writer.receive(pair.event, pair.wake);
    assert.equal(await writer.receive(pairs[0]!.event, pairs[0]!.wake), 'duplicate');
    const run = await writer.claimWakeBatch(); assert(run);
    assert.deepEqual(run.requests.map(({ event, wake }) => ({ event, wake })), pairs);
    assert(run.requests.every(request => /^[0-9a-f-]{36}$/.test(request.eventId)));
    assert.equal(run.status, 'running'); assert.equal(run.inputRecordId, null); assert.equal(run.finalRecordId, null);
    assert(Number.isFinite(Date.parse(run.claimedAt)));
    assert.deepEqual(await writer.claimWakeBatch(), run);
    assert.deepEqual(await writer.loadWakeRun(run.id), run);
    assert.equal((await writer.load()).version, 0);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_runs')).rows[0].n, 1);
    // Returned values are detached from durable storage.
    run.requests[0]!.event.payload = { changed: true };
    assert.deepEqual((await writer.loadWakeRun(run.id)).requests.map(({ event, wake }) => ({ event, wake })), pairs);
  } finally { await db.close(); }
});

test('new arrivals remain queued throughout the active run and form the next coalesced run', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const first = await writer.claimWakeBatch(); assert(first);
    await writer.receive(event('during-claim'), wake('during-claim'));
    await assert.rejects(writer.completeWakeRun(first.id), code('invalid'));
    await assert.rejects(writer.appendWakeFinal(first.id, 0, record(uuid('too-soon'))), code('invalid'));
    assert.equal(await writer.appendWakeInput(first.id, 0, record(uuid('input'))), 1);
    await writer.receive(event('during-model'), wake('during-model'));
    assert.equal(await writer.append(1, record(uuid('intermediate'), uuid('input'))), 2);
    assert.deepEqual((await writer.claimWakeBatch())?.requests, first.requests);
    await writer.appendWakeFinal(first.id, 2, record(uuid('final'), uuid('intermediate')));
    await writer.receive(event('before-completion'), wake('before-completion'));
    await assert.rejects(writer.append(3, record(uuid('interleaved'), uuid('final'))), /Complete the finalized/);
    await writer.completeWakeRun(first.id);
    const second = await writer.claimWakeBatch(); assert(second);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.requests.map(request => request.event.id), ['during-claim', 'during-model', 'before-completion']);
    assert.equal((await writer.loadWakeRun(first.id)).status, 'completed');
    await writer.completeWakeRun(first.id);
    assert.equal((await writer.claimWakeBatch())?.id, second.id);
    await assert.rejects(writer.appendWakeInput(first.id, 3, record(uuid('other-input'), uuid('final'))), code('duplicate'));
    assert.equal((await writer.load()).version, 3);
  } finally { await db.close(); }
});

test('wake input and final associations are CAS protected and exact retries are idempotent', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    // Runtime recovery can publish known outcomes/notices before this wake input.
    await writer.append(0, record(uuid('prior-repair')));
    const input = record(uuid('input'), uuid('prior-repair'));
    await assert.rejects(writer.appendWakeInput(run.id, 0, input), code('version'));
    await assert.rejects(writer.appendWakeInput(run.id, 1, { ...input, parentId: null }), /parent/);
    assert.throws(() => writer.appendWakeInput(run.id, 1, { ...input, kind: 'checkpoint' }), /message record/);
    assert.equal(await writer.appendWakeInput(run.id, 1, input), 2);
    assert.equal(await writer.appendWakeInput(run.id, 1, input), 2);
    await writer.append(2, record(uuid('intermediate'), uuid('input')));
    assert.equal(await writer.appendWakeInput(run.id, 1, input), 2, 'retry returns the associated version, not the later head');
    await assert.rejects(writer.appendWakeInput(run.id, 2, input), code('version'));
    await assert.rejects(writer.appendWakeInput(run.id, 1, { ...input, payload: { changed: true } }), code('duplicate'));
    const final = record(uuid('final'), uuid('intermediate'));
    await assert.rejects(writer.appendWakeFinal(run.id, 2, final), code('version'));
    assert.equal(await writer.appendWakeFinal(run.id, 3, final), 4);
    assert.equal(await writer.appendWakeFinal(run.id, 3, final), 4);
    await assert.rejects(writer.appendWakeFinal(run.id, 3, { ...final, id: 'different' }), code('duplicate'));
    await writer.completeWakeRun(run.id);
    await writer.completeWakeRun(run.id);
    await writer.append(4, record(uuid('after-completion'), uuid('final')));
    assert.equal(await writer.appendWakeInput(run.id, 1, input), 2);
    assert.equal(await writer.appendWakeFinal(run.id, 3, final), 4);
    assert.equal((await writer.load()).version, 5);
    await assert.rejects(writer.loadWakeRun(uuid('missing')), code('invalid'));
  } finally { await db.close(); }
});

test('restart at each durable boundary preserves one run, one input and one final record', async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    await writer.receive(event('second'), wake('second'));
    const claimed = await writer.claimWakeBatch(); assert(claimed);
    await writer.close(); writer = await db.acquire();
    assert.deepEqual(await writer.claimWakeBatch(), claimed);
    const input = record(uuid('input'));
    await writer.appendWakeInput(claimed.id, 0, input);
    await writer.close(); writer = await db.acquire();
    const afterInput = await writer.claimWakeBatch(); assert(afterInput);
    assert.equal(afterInput.id, claimed.id); assert.equal(afterInput.inputRecordId, input.id); assert.equal(afterInput.finalRecordId, null);
    assert.equal(await writer.appendWakeInput(claimed.id, 0, input), 1);
    const final = record(uuid('final'), uuid('input'));
    await writer.appendWakeFinal(claimed.id, 1, final);
    await writer.close(); writer = await db.acquire();
    const afterFinal = await writer.claimWakeBatch(); assert(afterFinal);
    assert.equal(afterFinal.id, claimed.id); assert.equal(afterFinal.finalRecordId, final.id);
    await writer.completeWakeRun(claimed.id);
    await writer.close(); writer = await db.acquire();
    await writer.completeWakeRun(claimed.id);
    assert.equal(await writer.claimWakeBatch(), null);
    assert.equal(await writer.receive(event('first'), wake('first')), 'duplicate');
    assert.equal(await writer.claimWakeBatch(), null);
    assert.deepEqual((await writer.load()).records, [input, final]);
  } finally { await db.close(); }
});

test('claim failure rolls back both the run and every membership without consuming receipts', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    await writer.receive(event('second'), wake('second'));
    await db.admin.query(`CREATE FUNCTION reject_wake_membership() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.wake_id = 'second' THEN RAISE EXCEPTION 'synthetic membership failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_wake_membership BEFORE INSERT ON wake_run_requests FOR EACH ROW EXECUTE FUNCTION reject_wake_membership()`);
    await assert.rejects(writer.claimWakeBatch(), /synthetic membership failure/);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_runs')).rows[0].n, 0);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_run_requests')).rows[0].n, 0);
    await writer.close();
    await db.admin.query('DROP TRIGGER reject_wake_membership ON wake_run_requests');
    const next = await db.acquire();
    assert.deepEqual((await next.claimWakeBatch())?.requests.map(request => request.wake.id), ['first', 'second']);
  } finally { await db.close(); }
});

for (const stage of ['input', 'final'] as const) test(`wake ${stage} association failure rolls back record, CAS and link atomically`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    if (stage === 'final') await writer.appendWakeInput(run.id, 0, record(uuid('input')));
    const before = await writer.load();
    await db.admin.query(`CREATE FUNCTION reject_wake_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.${stage}_record_id IS DISTINCT FROM OLD.${stage}_record_id THEN RAISE EXCEPTION 'synthetic link failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_wake_link BEFORE UPDATE ON wake_runs FOR EACH ROW EXECUTE FUNCTION reject_wake_link()`);
    const candidate = record(uuid(stage), stage === 'final' ? uuid('input') : null);
    await assert.rejects(stage === 'input' ? writer.appendWakeInput(run.id, before.version, candidate) : writer.appendWakeFinal(run.id, before.version, candidate), /synthetic link failure/);
    await writer.close();
    await db.admin.query('DROP TRIGGER reject_wake_link ON wake_runs');
    const next = await db.acquire();
    assert.deepEqual(await next.load(), before);
    assert.equal((await next.loadWakeRun(run.id))[stage === 'input' ? 'inputRecordId' : 'finalRecordId'], null);
    if (stage === 'input') await next.appendWakeInput(run.id, before.version, candidate);
    else await next.appendWakeFinal(run.id, before.version, candidate);
    assert.equal((await next.load()).version, before.version + 1);
  } finally { await db.close(); }
});

test('completion failure preserves final evidence and recovery completes without another append', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    await writer.appendWakeInput(run.id, 0, record(uuid('input')));
    await writer.appendWakeFinal(run.id, 1, record(uuid('final'), uuid('input')));
    const before = await writer.load();
    await db.admin.query(`CREATE FUNCTION reject_wake_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.completed THEN RAISE EXCEPTION 'synthetic completion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_wake_completion BEFORE UPDATE ON wake_runs FOR EACH ROW EXECUTE FUNCTION reject_wake_completion()`);
    await assert.rejects(writer.completeWakeRun(run.id), /synthetic completion failure/);
    await writer.close();
    await db.admin.query('DROP TRIGGER reject_wake_completion ON wake_runs');
    const next = await db.acquire();
    assert.equal((await next.claimWakeBatch())?.finalRecordId, uuid('final'));
    await next.completeWakeRun(run.id);
    assert.deepEqual(await next.load(), before);
    assert.equal(await next.claimWakeBatch(), null);
  } finally { await db.close(); }
});

test('wake membership and published associations cannot be rewritten or removed', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    await writer.appendWakeInput(run.id, 0, record(uuid('input')));
    await writer.appendWakeFinal(run.id, 1, record(uuid('final'), uuid('input')));
    await writer.completeWakeRun(run.id);
    await assert.rejects(db.admin.query('DELETE FROM wake_run_requests'), /append-only/);
    await assert.rejects(db.admin.query('UPDATE wake_run_requests SET run_id = $1', [uuid('different')]), /append-only/);
    await assert.rejects(db.admin.query('DELETE FROM wake_runs'), /append-only/);
    await assert.rejects(db.admin.query('UPDATE wake_runs SET input_record_id = NULL'), /appended once/);
    await assert.rejects(db.admin.query('UPDATE wake_runs SET final_record_id = NULL'), /appended once/);
    await assert.rejects(db.admin.query('UPDATE wake_runs SET completed = false'), /appended once/);
    await assert.rejects(db.admin.query("UPDATE wake_runs SET claimed_at = 'changed'"), /appended once/);
  } finally { await db.close(); }
});

test('wake queue writes verify the exact session lock and roll back a lost-lock claim', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    await db.admin.query(`CREATE FUNCTION lose_wake_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_unlock(1296650817, (SELECT lock_key FROM mira_owners WHERE mira_id = NEW.mira_id)); RETURN NEW; END $$;
      CREATE TRIGGER lose_wake_lock BEFORE INSERT ON wake_runs FOR EACH ROW EXECUTE FUNCTION lose_wake_lock()`);
    await assert.rejects(writer.claimWakeBatch(), code('ownership'));
    assert.equal(writer.signal.aborted, true);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_runs')).rows[0].n, 0);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_run_requests')).rows[0].n, 0);
    await writer.close();
    await db.admin.query('DROP TRIGGER lose_wake_lock ON wake_runs');
    const next = await db.acquire(); assert(await next.claimWakeBatch());
  } finally { await db.close(); }
});

for (const stage of ['input', 'final'] as const) test(`wake ${stage} cancellation before commit rolls back its record and association`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    if (stage === 'final') await writer.appendWakeInput(run.id, 0, record(uuid('input')));
    const before = await writer.load();
    await db.admin.query(`CREATE FUNCTION delay_wake_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      CREATE TRIGGER delay_wake_link BEFORE UPDATE ON wake_runs FOR EACH ROW EXECUTE FUNCTION delay_wake_link()`);
    const controller = new AbortController();
    const candidate = record(uuid(stage), stage === 'final' ? uuid('input') : null);
    const work = stage === 'input' ? writer.appendWakeInput(run.id, before.version, candidate, controller.signal) : writer.appendWakeFinal(run.id, before.version, candidate, controller.signal);
    const rejected = assert.rejects(work, (error: unknown) => error === controller.signal.reason);
    let updating = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const active = await db.admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'mira-durable-writer' AND wait_event = 'PgSleep') AS active");
      if (active.rows[0].active) { updating = true; break; }
      await delay(10);
    }
    assert.equal(updating, true, 'association UPDATE must be in flight before cancellation');
    controller.abort(Error('synthetic wake publication cancelled'));
    await rejected;
    assert.equal(writer.signal.aborted, false);
    assert.deepEqual(await writer.load(), before);
    assert.equal((await writer.loadWakeRun(run.id))[stage === 'input' ? 'inputRecordId' : 'finalRecordId'], null);
    await db.admin.query('DROP TRIGGER delay_wake_link ON wake_runs');
    if (stage === 'input') await writer.appendWakeInput(run.id, before.version, candidate);
    else await writer.appendWakeFinal(run.id, before.version, candidate);
  } finally { await db.close(); }
});

for (const stage of ['input', 'final', 'complete'] as const) test(`wake ${stage} publication rolls back when its session lock is lost`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    if (stage !== 'input') await writer.appendWakeInput(run.id, 0, record(uuid('input')));
    if (stage === 'complete') await writer.appendWakeFinal(run.id, 1, record(uuid('final'), uuid('input')));
    const before = await writer.load(); const progress = await writer.loadWakeRun(run.id);
    await db.admin.query(`CREATE FUNCTION lose_wake_update_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_unlock(1296650817, (SELECT lock_key FROM mira_owners WHERE mira_id = NEW.mira_id)); RETURN NEW; END $$;
      CREATE TRIGGER lose_wake_update_lock BEFORE UPDATE ON wake_runs FOR EACH ROW EXECUTE FUNCTION lose_wake_update_lock()`);
    await assert.rejects(stage === 'input' ? writer.appendWakeInput(run.id, 0, record(uuid('input'))) : stage === 'final' ? writer.appendWakeFinal(run.id, 1, record(uuid('final'), uuid('input'))) : writer.completeWakeRun(run.id), code('ownership'));
    assert.equal(writer.signal.aborted, true);
    await writer.close();
    await db.admin.query('DROP TRIGGER lose_wake_update_lock ON wake_runs');
    const next = await db.acquire();
    assert.deepEqual(await next.load(), before); assert.deepEqual(await next.loadWakeRun(run.id), progress);
  } finally { await db.close(); }
});

test('connection loss permanently fences every wake queue operation on the old writer', async () => {
  const db = await createTestDatabase();
  const app = `mira-wake-loss-${db.schema}`;
  const writer = await new PostgresPersistence({ connectionString: db.connectionString, schema: db.schema, applicationName: app }).acquire('synthetic-mira');
  try {
    await writer.receive(event('first'), wake('first'));
    const run = await writer.claimWakeBatch(); assert(run);
    const lost = once(writer.signal, 'abort');
    await db.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [app]);
    await lost;
    const next = await db.acquire();
    assert.equal((await next.claimWakeBatch())?.id, run.id);
    await assert.rejects(writer.claimWakeBatch(), code('ownership'));
    await assert.rejects(writer.loadWakeRun(run.id), code('ownership'));
    await assert.rejects(writer.appendWakeInput(run.id, 0, record(uuid('input'))), code('ownership'));
    await assert.rejects(writer.appendWakeFinal(run.id, 0, record(uuid('final'))), code('ownership'));
    await assert.rejects(writer.completeWakeRun(run.id), code('ownership'));
  } finally { await writer.close(); await db.close(); }
});

test('wake run recovery rejects empty runs and mismatched persisted request envelopes', async () => {
  for (const corrupt of ['empty', 'request'] as const) {
    const db = await createTestDatabase();
    try {
      const writer = await db.acquire();
      if (corrupt === 'empty') {
        await db.admin.query("INSERT INTO history_records(id, mira_id, kind) VALUES ($1, $2, 'wake')", [uuid('empty'), writer.miraId]);
        await db.admin.query('INSERT INTO wake_runs(mira_id, run_id, claimed_at, claimed_version) VALUES ($1, $2, $3, 0)', [writer.miraId, uuid('empty'), now]);
      } else {
        await writer.receive(event('first'), wake('first'));
        await writer.claimWakeBatch();
        await db.admin.query('ALTER TABLE wake_requests DISABLE TRIGGER wake_append_only');
        await db.admin.query("UPDATE wake_requests SET wake = '{\"id\":\"different\",\"reason\":\"synthetic\"}'");
        await db.admin.query('ALTER TABLE wake_requests ENABLE TRIGGER wake_append_only');
      }
      await assert.rejects(writer.claimWakeBatch(), code('corrupt'));
      assert.equal(writer.signal.aborted, true);
    } finally { await db.close(); }
  }
});

test('wake slice down/up preserves earlier receipts and context for a fresh claim', async () => {
  const db = await createTestDatabase();
  try {
    const first = await db.acquire();
    await first.receive(event('legacy'), wake('legacy'));
    await first.append(0, record(uuid('legacy-record')));
    await first.close();
    // First remove actual newer feature migrations, retaining the exact base sequence below.
    while (!(await db.admin.query('SELECT name FROM mira_migrations ORDER BY id DESC LIMIT 1')).rows[0].name.startsWith('1760000000004_')) {
      await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    }
    // Roll back the newer search and Memory migrations before the Wake slice.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_requests')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM context_records')).rows[0].n, 1);
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'up' });
    const next = await db.acquire();
    const run = await next.claimWakeBatch(); assert(run);
    assert.deepEqual(run.requests.map(({ event, wake }) => ({ event, wake })), [{ event: event('legacy'), wake: wake('legacy') }]);
    await next.appendWakeInput(run.id, 1, record(uuid('new-input'), uuid('legacy-record')));
    assert.equal((await next.load()).version, 2);
  } finally { await db.close(); }
});
