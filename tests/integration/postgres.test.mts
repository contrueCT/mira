import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeRecord } from '@mira/context';
import type { LifeEvent, ToolIntent } from '@mira/life';
import { migrate, PersistenceError, PostgresPersistence } from '@mira/persistence';
import { createTestDatabase, testDatabaseUrl, testHistoryId as uuid } from './database.mts';

const now = '2026-10-05T00:00:00.000Z';
const record = (id = uuid('r1'), parentId: string | null = null): RuntimeRecord => ({
  formatVersion: 1, runtime: 'synthetic-runtime', runtimeVersion: '1', id, parentId,
  kind: 'message', occurredAt: now, payload: { role: 'assistant', content: [{ type: 'text', text: 'synthetic only' }], provider: { opaque: ['retained', 42] } },
});
const event = (id = 'e1'): LifeEvent => ({ id, type: 'synthetic.observed', source: 'external', occurredAt: now, payload: { exact: [1, true, null] } });
const intent = (callId = 'tool-1'): ToolIntent => ({ callId, assistantRecordId: uuid('r1'), toolName: 'synthetic-counter', requestedArguments: { amount: 1 }, arguments: { amount: 1 }, occurredAt: now });
const code = (expected: PersistenceError['code']) => (error: unknown) => error instanceof PersistenceError && error.code === expected;

// Calling the integration suite without its explicit isolated service is an error, never a pass/skip.
testDatabaseUrl();

test('migration up/down/up uses node-pg-migrate and preserves no stale tables', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const before = await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema = $1", [db.schema]);
    assert.equal(before.rows[0].n, 20);
    assert.deepEqual((await db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('subagents','subagent_turns') ORDER BY table_name", [db.schema])).rows.map(row => row.table_name), ['subagent_turns', 'subagents']);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='subagent_turns' AND column_name IN ('activity','started_at','association_order')", [db.schema])).rows[0].n, 3);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('subagent_calls','subagent_live_inputs')", [db.schema])).rows[0].n, 2);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='subagent_turns' AND column_name IN ('stream_id','input_record_id','final_record_id')", [db.schema])).rows[0].n, 3);
    // The usage indexes (ADR 0048) are the latest slice: indexes only, no data.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('context_records_by_time', 'wake_runs_by_claimed_version')", [db.schema])).rows[0].n, 0, 'usage down removes only its indexes');
    // The Mira lives registry (ADR 0047) is the next independent slice.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('mira_lives','mira_active_life')", [db.schema])).rows[0].n, 0, 'lives down removes only the registry');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('subagent_calls','subagent_live_inputs')", [db.schema])).rows[0].n, 0, 'first down removes task inbox and call receipts');
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='subagent_turns' AND column_name IN ('stream_id','input_record_id','final_record_id')", [db.schema])).rows[0].n, 0);
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='subagent_turns' AND column_name IN ('activity','started_at','association_order')", [db.schema])).rows[0].n, 0, 'second down removes activity/association columns, preserving child registry');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('subagents','subagent_turns')", [db.schema])).rows[0].n, 0, 'third down removes child registry and turns');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'wake_live_inputs'", [db.schema])).rows[0].n, 0, 'fourth down removes supplemental input links');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'scheduled_deliveries'", [db.schema])).rows[0].n, 0, 'fifth down removes scheduled deliveries');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'dreaming_progress'", [db.schema])).rows[0].n, 0, 'sixth down removes technical Dreaming progress');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE '%_history_fts'", [db.schema])).rows[0].n, 0, 'seventh down removes only history indexes');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    const previous = await db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [db.schema]);
    assert.deepEqual(previous.rows.map(row => row.table_name), ['context_records', 'history_records', 'life_events', 'mira_migrations', 'mira_owners', 'tool_executions', 'wake_requests'], 'ninth down retains the base tables including global identity');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    const after = await db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [db.schema]);
    assert.deepEqual(after.rows.map((row) => row.table_name), ['mira_migrations']);
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'up' });
    const writer = await db.acquire();
    assert.equal((await writer.load()).version, 0);
  } finally { await db.close(); }
});

test('raw envelopes are append-only, ordered, CAS protected and restored after ownership takeover', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const first = await db.acquire();
    assert.equal(await first.append(0, record()), 1);
    await assert.rejects(first.append(0, record(uuid('stale'), uuid('r1'))), code('version'));
    await assert.rejects(first.append(1, record(uuid('bad-parent'))), /parent/);
    await assert.rejects(first.append(1, record(uuid('r1'), uuid('r1'))), code('duplicate'));
    const secondRecord = record(uuid('r2'), uuid('r1'));
    assert.equal(await first.append(1, secondRecord), 2);
    await assert.rejects(db.admin.query("UPDATE context_records SET envelope = '{}' WHERE mira_id = 'synthetic-mira'"), /append-only/);
    await assert.rejects(db.admin.query("DELETE FROM context_records WHERE mira_id = 'synthetic-mira'"), /append-only/);
    await first.close();
    const next = await db.acquire();
    assert.equal(BigInt(next.epoch), BigInt(first.epoch) + 1n);
    assert.deepEqual((await next.load()).records, [record(), secondRecord]);
    await assert.rejects(first.append(2, record(uuid('old-writer'), uuid('r2'))), code('ownership'));
  } finally { await db.close(); }
});

test('concurrent calls on one client serialize transactions and only one CAS wins', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const result = await Promise.allSettled([writer.append(0, record(uuid('a'))), writer.append(0, record(uuid('b')))]);
    assert.equal(result.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(result.filter((item) => item.status === 'rejected').length, 1);
    assert.equal((await writer.load()).version, 1);
  } finally { await db.close(); }
});

test('events and optional wakes commit atomically, deduplicate exact receipts, and stay distinct', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    assert.equal(await writer.receive(event()), 'inserted');
    assert.equal(await writer.receive(event()), 'duplicate');
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM wake_requests')).rows[0].n, 0);
    const wake = { id: 'w1', reason: 'synthetic attention' };
    assert.equal(await writer.receive(event('e2'), wake), 'inserted');
    assert.equal(await writer.receive(event('e2'), wake), 'duplicate');
    await assert.rejects(writer.receive({ ...event(), payload: { changed: true } }), code('duplicate'));
    await assert.rejects(writer.receive(event(), wake), code('duplicate'));
    await assert.rejects(writer.receive(event('e2')), code('duplicate'));
    await assert.rejects(writer.receive(event('e3'), wake), code('duplicate'));
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM life_events WHERE event_id = 'e3'")).rows[0].n, 0);
    assert.equal((await writer.load()).version, 0);
    await db.admin.query(`CREATE FUNCTION reject_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic wake fault'; END $$;
      CREATE TRIGGER reject_wake BEFORE INSERT ON wake_requests FOR EACH ROW EXECUTE FUNCTION reject_wake()`);
    await assert.rejects(writer.receive(event('e4'), { id: 'w4', reason: 'fault' }), /synthetic wake fault/);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM life_events WHERE event_id = 'e4'")).rows[0].n, 0);
  } finally { await db.close(); }
});

test('tool intentions and first outcomes survive restart without replay or overwrite', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.append(0, record());
    await assert.rejects(writer.beginTool(0, intent()), code('version'));
    await assert.rejects(writer.beginTool(1, { ...intent(), assistantRecordId: uuid('missing') }), code('invalid'));
    await writer.beginTool(1, intent());
    await writer.beginTool(1, intent('tool-2'));
    await assert.rejects(writer.beginTool(1, intent()), code('duplicate'));
    const outcome = { callId: 'tool-1', occurredAt: now, payload: { result: 'recorded exactly' } };
    await writer.finishTool(outcome);
    await assert.rejects(writer.finishTool(outcome), code('duplicate'));
    await assert.rejects(writer.beginTool(1, intent()), code('duplicate'));
    await writer.close();
    const recovered = await db.acquire();
    assert.deepEqual((await recovered.load()).executions, [{ intent: intent(), outcome }, { intent: intent('tool-2'), outcome: null }]);
    await assert.rejects(db.admin.query("UPDATE tool_executions SET outcome = '{}' WHERE call_id = 'tool-1'"), /first tool outcome/);
    await assert.rejects(db.admin.query("DELETE FROM tool_executions WHERE call_id = 'tool-2'"), /append-only/);
  } finally { await db.close(); }
});

test('late tool outcomes cannot rewrite execution evidence after an unknown observation advances context', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.append(0, record());
    await writer.beginTool(1, intent());
    const observation: RuntimeRecord = { ...record(uuid('unknown-observation'), uuid('r1')), payload: { syntheticObservation: { callId: 'tool-1', state: 'unknown', explanation: 'No outcome was durably received' } } };
    await writer.append(1, observation);
    await writer.append(2, record(uuid('continued'), observation.id));
    const before = await writer.load();
    const late = { callId: 'tool-1', occurredAt: now, payload: { result: 'late synthetic receipt' } };
    await assert.rejects(writer.finishTool(late), code('version'));
    assert.equal(writer.signal.aborted, false);
    assert.deepEqual(await writer.load(), before);
    assert.equal(before.executions[0]?.outcome, null);
    await writer.verifyActive();
    await writer.close();
    const recovered = await db.acquire();
    await assert.rejects(recovered.finishTool(late), code('version'));
    assert.equal(recovered.signal.aborted, false);
    assert.deepEqual(await recovered.load(), before);
    await recovered.append(3, record(uuid('further-context'), uuid('continued')));
    assert.equal((await recovered.load()).version, 4);
  } finally { await db.close(); }
});

test('sequential sibling tool outcomes use their own begin versions before result publication', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.append(0, record());
    await writer.beginTool(1, intent('first'));
    const first = { callId: 'first', occurredAt: now, payload: { synthetic: 'first outcome' } };
    await writer.finishTool(first);
    await writer.append(1, record(uuid('first-result'), uuid('r1')));
    await writer.beginTool(2, intent('second'));
    const second = { callId: 'second', occurredAt: now, payload: { synthetic: 'second outcome' } };
    await writer.finishTool(second);
    await writer.append(2, record(uuid('second-result'), uuid('first-result')));
    await assert.rejects(writer.finishTool(second), code('duplicate'));
    await assert.rejects(writer.finishTool({ ...second, callId: 'missing' }), code('duplicate'));
    assert.equal(writer.signal.aborted, false);
    assert.deepEqual((await writer.load()).executions, [{ intent: intent('first'), outcome: first }, { intent: intent('second'), outcome: second }]);
  } finally { await db.close(); }
});

test('append fault rolls back inserted history and its context version together', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await db.admin.query(`CREATE FUNCTION reject_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.context_version > OLD.context_version THEN RAISE EXCEPTION 'synthetic CAS fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_version BEFORE UPDATE ON mira_owners FOR EACH ROW EXECUTE FUNCTION reject_version()`);
    await assert.rejects(writer.append(0, record()), /synthetic CAS fault/);
    const data = await db.admin.query('SELECT context_version, (SELECT count(*) FROM context_records) AS count FROM mira_owners');
    assert.equal(data.rows[0].context_version, '0'); assert.equal(data.rows[0].count, '0');
  } finally { await db.close(); }
});

test('unknown envelope versions fail closed instead of resetting context', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const future = { ...record(), formatVersion: 999 };
    assert.throws(() => writer.append(0, future as RuntimeRecord), /Unsupported envelope/);
    await db.admin.query("INSERT INTO history_records(id, mira_id, kind) VALUES ($1, $2, 'context')", [uuid('r1'), writer.miraId]);
    await db.admin.query('INSERT INTO context_records(mira_id, record_id, version, envelope) VALUES ($1, $2, 1, $3)', ['synthetic-mira', uuid('r1'), JSON.stringify(future)]);
    await db.admin.query("UPDATE mira_owners SET context_version = 1, head_record_id = $1", [uuid('r1')]);
    await assert.rejects(writer.load(), /Unsupported envelope/);
    assert.equal(writer.signal.aborted, true);
  } finally { await db.close(); }
});

test('session advisory lock is checked even if the epoch did not change', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    // The trigger runs on the writer's exact backend and deliberately releases its lock.
    await db.admin.query(`CREATE FUNCTION lose_owner_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_unlock(1296650817, (SELECT lock_key FROM mira_owners WHERE mira_id = NEW.mira_id)); RETURN NEW; END $$;
      CREATE TRIGGER lose_owner_lock BEFORE INSERT ON context_records FOR EACH ROW EXECUTE FUNCTION lose_owner_lock()`);
    await assert.rejects(writer.append(0, record()), code('ownership'));
    assert.equal(writer.signal.aborted, true);
    const state = await db.admin.query('SELECT epoch, context_version, (SELECT count(*) FROM context_records) AS count FROM mira_owners');
    assert.equal(state.rows[0].epoch, writer.epoch);
    assert.equal(state.rows[0].context_version, '0'); assert.equal(state.rows[0].count, '0');
    await assert.rejects(writer.verifyActive(), code('ownership'));
    await writer.close();
    await db.admin.query('DROP TRIGGER lose_owner_lock ON context_records');
    const next = await db.acquire();
    await next.append(0, record());
  } finally { await db.close(); }
});

test('connection loss aborts the owner and fences every old write after takeover', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const app = `mira-synthetic-loss-${db.schema}`;
    const store = new PostgresPersistence({ connectionString: db.connectionString, schema: db.schema, applicationName: app });
    const writer = await store.acquire('synthetic-mira');
    try {
      await writer.append(0, record());
      const abort = once(writer.signal, 'abort');
      const killed = await db.admin.query('SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name = $1', [app]);
      assert.equal(killed.rows[0].killed, true);
      await abort;
      assert.equal(writer.signal.aborted, true);
      const next = await db.acquire();
      await next.append(1, record(uuid('r2'), uuid('r1')));
      await assert.rejects(writer.append(2, record(uuid('stale'), uuid('r2'))), code('ownership'));
      await assert.rejects(writer.receive(event()), code('ownership'));
      await assert.rejects(writer.beginTool(2, intent()), code('ownership'));
      await assert.rejects(writer.finishTool({ callId: 'tool-1', occurredAt: now, payload: null }), code('ownership'));
      assert.equal((await next.load()).version, 2);
    } finally { await writer.close(); }
  } finally { await db.close(); }
});

test('separate operating-system processes cannot own one Mira concurrently', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  const children: ReturnType<typeof spawn>[] = [];
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/owner-process.mts', import.meta.url)), db.schema, 'synthetic-mira'], {
      env: { ...process.env, MIRA_TEST_DATABASE_URL: db.connectionString }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    const reply = await new Promise<{ state: string; epoch?: string }>((resolve, reject) => {
      let output = '';
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]!) as { state: string; epoch?: string });
      });
      child.once('error', reject);
      child.once('exit', () => { if (!output.includes('\n')) reject(new Error(`Child exited without result: ${stderr}`)); });
    });
    return { child, reply };
  };
  try {
    const first = await start(); assert.equal(first.reply.state, 'acquired');
    const second = await start(); assert.equal(second.reply.state, 'rejected');
    const exit = once(first.child, 'exit'); first.child.stdin?.write('close\n'); await exit;
    const third = await start(); assert.equal(third.reply.state, 'acquired');
    assert.equal(BigInt(third.reply.epoch!), BigInt(first.reply.epoch!) + 1n);
  } finally {
    await Promise.all(children.map(async (child) => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } }));
    await db.close();
  }
});

test('registry keys distinguish different Miras and remain stable across takeover', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const first = await db.acquire('synthetic-a');
    const second = await db.acquire('synthetic-b');
    await first.append(0, record());
    await second.append(0, record(uuid('other-mira-record')));
    const keys = await db.admin.query('SELECT mira_id, lock_key FROM mira_owners ORDER BY mira_id');
    assert.notEqual(keys.rows[0].lock_key, keys.rows[1].lock_key);
    await first.close();
    const next = await db.acquire('synthetic-a');
    const after = await db.admin.query('SELECT mira_id, lock_key FROM mira_owners ORDER BY mira_id');
    assert.deepEqual(after.rows, keys.rows);
    assert.equal((await next.load()).version, 1);
    assert.equal((await second.load()).version, 1);
  } finally { await db.close(); }
});

test('a changed fencing epoch stops a writer even while its session lock remains', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await db.admin.query('UPDATE mira_owners SET epoch = epoch + 1');
    await assert.rejects(writer.append(0, record()), code('ownership'));
    assert.equal(writer.signal.aborted, true);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM context_records')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('checkpoint cancellation during SQL insertion rolls back before commit without stopping the owner', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.append(0, record());
    await db.admin.query(`CREATE FUNCTION delay_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      CREATE TRIGGER delay_checkpoint BEFORE INSERT ON context_records FOR EACH ROW EXECUTE FUNCTION delay_checkpoint()`);
    const controller = new AbortController();
    const checkpoint: RuntimeRecord = { ...record(uuid('checkpoint'), uuid('r1')), kind: 'checkpoint', payload: { synthetic: 'summary' } };
    const pending = writer.append(1, checkpoint, controller.signal);
    // Attach the rejection assertion immediately, before intentionally causing rejection.
    const rejected = assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
    const deadline = Date.now() + 3_000;
    let inserting = false;
    while (Date.now() < deadline) {
      const active = await db.admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'mira-durable-writer' AND wait_event = 'PgSleep') AS active");
      if (active.rows[0].active) { inserting = true; break; }
      await delay(10);
    }
    assert.equal(inserting, true, 'checkpoint INSERT must be in flight before cancellation');
    controller.abort(new Error('synthetic checkpoint cancelled'));
    await rejected;
    assert.equal(writer.signal.aborted, false);
    assert.deepEqual((await writer.load()).records, [record()]);
    assert.equal((await writer.load()).version, 1);
    await db.admin.query('DROP TRIGGER delay_checkpoint ON context_records');
    await writer.append(1, record(uuid('r2'), uuid('r1')));
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await assert.rejects(writer.append(2, record(uuid('r3'), uuid('r2')), alreadyAborted.signal), (error: unknown) => error === alreadyAborted.signal.reason);
    assert.equal((await writer.load()).version, 2);
  } finally { await db.close(); }
});
