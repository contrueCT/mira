import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeRecord } from '@mira/context';
import type { MemoryCheckpoint, MemoryCheckpointWriter } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { createTestDatabase, testDatabaseUrl } from './database.mts';

const now = '2026-10-05T00:00:00.000Z';
const record = (id: string, parentId: string | null = null): RuntimeRecord => ({
  formatVersion: 1, runtime: 'synthetic-runtime', runtimeVersion: '1', kind: 'message', id, parentId,
  occurredAt: now, payload: { synthetic: id },
});
const code = (expected: PersistenceError['code']) => (error: unknown) => error instanceof PersistenceError && error.code === expected;
async function finalized(writer: MemoryCheckpointWriter): Promise<MemoryCheckpoint> {
  await writer.receive({ id: 'event', type: 'synthetic.request', source: 'user', occurredAt: now, payload: 'synthetic' }, { id: 'wake', reason: 'synthetic' });
  const run = await writer.claimWakeBatch(); assert(run);
  await writer.appendWakeInput(run.id, 0, record('input'));
  await writer.appendWakeFinal(run.id, 1, record('final', 'input'));
  return { runId: run.id, finalRecordId: 'final', preparedAt: now, payload: { memoryRoot: '/synthetic/memory', miraId: writer.miraId } };
}

testDatabaseUrl();

for (const commit of [null, 'a'.repeat(40), 'b'.repeat(64)]) test(`Memory checkpoint survives restart and associates ${commit === null ? 'no-change' : `${commit.length}-character Git`} outcome exactly once`, async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire();
    const checkpoint = await finalized(writer);
    assert.equal(await writer.loadMemoryCheckpoint(checkpoint.runId), null);
    await writer.prepareMemoryCheckpoint(checkpoint);
    await writer.prepareMemoryCheckpoint(structuredClone(checkpoint));
    await assert.rejects(writer.completeWakeRun(checkpoint.runId), code('invalid'));
    await assert.rejects(db.admin.query('UPDATE wake_runs SET completed = true'), /Pending Memory checkpoint/);
    await writer.close(); writer = await db.acquire();
    assert.equal((await writer.claimWakeBatch())?.finalRecordId, 'final');
    assert.deepEqual(await writer.loadMemoryCheckpoint(checkpoint.runId), { checkpoint, receipt: null });
    await writer.prepareMemoryCheckpoint(checkpoint);
    const receipt = { runId: checkpoint.runId, commit };
    await writer.finishMemoryCheckpoint(receipt);
    await writer.close(); writer = await db.acquire();
    assert.deepEqual(await writer.loadMemoryCheckpoint(checkpoint.runId), { checkpoint, receipt });
    await writer.finishMemoryCheckpoint(receipt);
    await writer.completeWakeRun(checkpoint.runId);
    await writer.close(); writer = await db.acquire();
    await writer.prepareMemoryCheckpoint(checkpoint);
    await writer.finishMemoryCheckpoint(receipt);
    await writer.completeWakeRun(checkpoint.runId);
    assert.equal(await writer.claimWakeBatch(), null);
    assert.equal((await writer.load()).version, 2);
    assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM wake_memory_checkpoints')).rows[0].count, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM wake_memory_receipts')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('Memory recovery inputs and first receipt are immutable and conflicting retries preserve original evidence', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const checkpoint = await finalized(writer);
    const receipt = { runId: checkpoint.runId, commit: 'c'.repeat(40) };
    await assert.rejects(writer.finishMemoryCheckpoint(receipt), code('invalid'));
    await assert.rejects(writer.prepareMemoryCheckpoint({ ...checkpoint, finalRecordId: 'input' }), code('invalid'));
    await writer.prepareMemoryCheckpoint(checkpoint);
    for (const modified of [
      { ...checkpoint, preparedAt: '2026-10-05T01:00:00.000Z' },
      { ...checkpoint, payload: { memoryRoot: '/different' } },
    ]) await assert.rejects(writer.prepareMemoryCheckpoint(modified), code('duplicate'));
    await writer.finishMemoryCheckpoint(receipt);
    await assert.rejects(writer.finishMemoryCheckpoint({ ...receipt, commit: null }), code('duplicate'));
    await assert.rejects(writer.finishMemoryCheckpoint({ ...receipt, commit: 'd'.repeat(40) }), code('duplicate'));
    assert.throws(() => writer.finishMemoryCheckpoint({ ...receipt, commit: 'not-a-commit' }), code('invalid'));
    await assert.rejects(db.admin.query('DELETE FROM wake_memory_receipts'), /append-only/);
    await assert.rejects(db.admin.query('UPDATE wake_memory_receipts SET commit_id = NULL'), /append-only/);
    await assert.rejects(db.admin.query('DELETE FROM wake_memory_checkpoints'), /append-only/);
    await assert.rejects(db.admin.query("UPDATE wake_memory_checkpoints SET payload = '{}'::json"), /append-only/);
    assert.deepEqual(await writer.loadMemoryCheckpoint(checkpoint.runId), { checkpoint, receipt });
    assert.equal(writer.signal.aborted, false);
    await writer.completeWakeRun(checkpoint.runId);
    const other = await db.acquire('other-synthetic-mira');
    await assert.rejects(other.loadMemoryCheckpoint(checkpoint.runId), code('invalid'));
    await assert.rejects(other.finishMemoryCheckpoint(receipt), code('invalid'));
  } finally { await db.close(); }
});

test('Memory checkpoint requires a persisted final and cannot be added retrospectively after completion', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive({ id: 'event', type: 'synthetic', source: 'user', occurredAt: now, payload: null }, { id: 'wake', reason: 'synthetic' });
    const run = await writer.claimWakeBatch(); assert(run);
    const checkpoint = { runId: run.id, finalRecordId: 'final', preparedAt: now, payload: null };
    await assert.rejects(writer.prepareMemoryCheckpoint(checkpoint), code('invalid'));
    await writer.appendWakeInput(run.id, 0, record('input'));
    await assert.rejects(writer.prepareMemoryCheckpoint(checkpoint), code('invalid'));
    await writer.appendWakeFinal(run.id, 1, record('final', 'input'));
    await writer.completeWakeRun(run.id);
    await assert.rejects(writer.prepareMemoryCheckpoint(checkpoint), code('invalid'));
    assert.equal(await writer.loadMemoryCheckpoint(run.id), null);
  } finally { await db.close(); }
});

for (const stage of ['checkpoint', 'receipt'] as const) test(`Memory ${stage} rolls back when exact ownership lock is lost, then a new writer can recover`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const checkpoint = await finalized(writer);
    const receipt = { runId: checkpoint.runId, commit: null };
    if (stage === 'receipt') await writer.prepareMemoryCheckpoint(checkpoint);
    const table = stage === 'checkpoint' ? 'wake_memory_checkpoints' : 'wake_memory_receipts';
    await db.admin.query(`CREATE FUNCTION lose_memory_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_unlock(1296650817, (SELECT lock_key FROM mira_owners WHERE mira_id = NEW.mira_id)); RETURN NEW; END $$;
      CREATE TRIGGER lose_memory_lock BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION lose_memory_lock()`);
    await assert.rejects(stage === 'checkpoint' ? writer.prepareMemoryCheckpoint(checkpoint) : writer.finishMemoryCheckpoint(receipt), code('ownership'));
    assert.equal(writer.signal.aborted, true);
    await writer.close();
    await db.admin.query(`DROP TRIGGER lose_memory_lock ON ${table}`);
    const next = await db.acquire();
    assert.deepEqual(await next.loadMemoryCheckpoint(checkpoint.runId), stage === 'checkpoint' ? null : { checkpoint, receipt: null });
    await assert.rejects(writer.loadMemoryCheckpoint(checkpoint.runId), code('ownership'));
    await assert.rejects(writer.prepareMemoryCheckpoint(checkpoint), code('ownership'));
    await assert.rejects(writer.finishMemoryCheckpoint(receipt), code('ownership'));
    await next.prepareMemoryCheckpoint(checkpoint);
    await next.finishMemoryCheckpoint(receipt);
    await next.completeWakeRun(checkpoint.runId);
  } finally { await db.close(); }
});

for (const corrupt of ['final-link', 'timestamp', 'premature-completion'] as const) test(`Memory recovery rejects corrupt ${corrupt} evidence`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const checkpoint = await finalized(writer);
    await writer.prepareMemoryCheckpoint(checkpoint);
    if (corrupt === 'premature-completion') {
      await db.admin.query('ALTER TABLE wake_runs DISABLE TRIGGER wake_memory_completion');
      await db.admin.query('UPDATE wake_runs SET completed = true');
      await db.admin.query('ALTER TABLE wake_runs ENABLE TRIGGER wake_memory_completion');
    } else {
      await db.admin.query('ALTER TABLE wake_memory_checkpoints DISABLE TRIGGER memory_checkpoint_append_only');
      await db.admin.query(corrupt === 'final-link' ? "UPDATE wake_memory_checkpoints SET final_record_id = 'input'" : "UPDATE wake_memory_checkpoints SET prepared_at = 'invalid-timestamp'");
      await db.admin.query('ALTER TABLE wake_memory_checkpoints ENABLE TRIGGER memory_checkpoint_append_only');
    }
    await assert.rejects(writer.load(), code('corrupt'));
    assert.equal(writer.signal.aborted, true);
  } finally { await db.close(); }
});
