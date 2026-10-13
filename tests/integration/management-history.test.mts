import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeRecord } from '@mira/context';
import { HistoryError } from '@mira/life';
import { createTestDatabase, testHistoryId as uuid } from './database.mts';

const now = '2026-10-13T00:00:00.000Z';
const record = (id: string, parent: string | null): RuntimeRecord => ({ formatVersion: 1, runtime: 'test', runtimeVersion: '1',
  id: uuid(id), parentId: parent ? uuid(parent) : null, kind: 'message', occurredAt: now, payload: { secret: 'PRIVATE_RUN_CONTENT', id } });

test('read-only run history joins exact external IDs, immutable membership, version-bounded pages and distinct Memory receipts', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('one'); const other = await db.acquire('two'); const history = db.store.history('one');
    await writer.receive({ id: 'memory-request', type: 'web.message', source: 'user', occurredAt: now, payload: { text: 'Remember this' } }, { id: 'web:memory-request', reason: 'User message from the local web interface' });
    await other.receive({ id: 'memory-request', type: 'web.message', source: 'user', occurredAt: now, payload: { text: 'Other Mira' } });
    assert.equal(await history.findEventRun('missing'), null);
    const queued = await history.findEventRun('memory-request'); assert(queued); assert.equal(queued.runId, null);
    assert.notEqual(queued.eventId, (await db.store.history('two').findEventRun('memory-request'))?.eventId);
    const run = await writer.claimWakeBatch(); assert(run);
    assert.equal((await history.findEventRun('memory-request'))?.runId, run.id);
    assert.equal((await history.readRun({ id: run.id }))?.memory, null);
    let version = await writer.appendWakeInput(run.id, 0, record('input', null)); let parent = 'input';
    for (let index = 0; index < 7; index++) {
      const name = `middle-${index}`; version = await writer.append(version, record(name, parent)); parent = name;
      if (index === 3) await writer.beginTool(version, { callId: 'tool', assistantRecordId: uuid(name), toolName: 'read', requestedArguments: { secret: 'PRIVATE_ARGS' }, arguments: {}, occurredAt: now });
    }
    version = await writer.appendWakeFinal(run.id, version, record('final', parent));
    await writer.prepareMemoryCheckpoint({ runId: run.id, finalRecordId: uuid('final'), preparedAt: now, payload: { privatePath: 'PRIVATE_CHECKPOINT_PATH' } });
    assert.deepEqual((await history.readRun({ id: run.id }))?.memory, { preparedAt: now, receipt: null });
    await writer.finishMemoryCheckpoint({ runId: run.id, commit: null }); await writer.completeWakeRun(run.id);
    await writer.receive({ id: 'next', type: 'web.message', source: 'user', occurredAt: now, payload: { text: 'Next request' } }, { id: 'web:next', reason: 'Next' });
    const next = await writer.claimWakeBatch(); assert(next);
    version = await writer.appendWakeInput(next.id, version, record('next-input', 'final'));
    await writer.appendWakeFinal(next.id, version, record('next-final', 'next-input'));
    await writer.prepareMemoryCheckpoint({ runId: next.id, finalRecordId: uuid('next-final'), preparedAt: now, payload: {} });
    await writer.finishMemoryCheckpoint({ runId: next.id, commit: 'c'.repeat(40) }); await writer.completeWakeRun(next.id);
    const before = await writer.load();
    let cursor: string | undefined; const seen = new Set<string>(); let pages = 0;
    do {
      const page = await history.readRun({ id: run.id, limit: 3, ...(cursor ? { before: cursor } : {}) }); assert(page); pages++;
      assert.equal(page.run.status, 'completed'); assert.deepEqual(page.memory, { preparedAt: now, receipt: { commit: null } });
      assert.equal(page.run.requests[0]?.eventId, queued.eventId);
      assert.doesNotMatch(JSON.stringify(page), /PRIVATE_RUN_CONTENT|PRIVATE_ARGS|PRIVATE_CHECKPOINT_PATH/);
      for (const hit of page.records) { assert(!seen.has(hit.id)); seen.add(hit.id); assert(![uuid('next-input'), uuid('next-final')].includes(hit.id)); }
      if (page.nextCursor) {
        await assert.rejects(history.readRun({ id: next.id, before: page.nextCursor }), error => error instanceof HistoryError && error.code === 'invalid');
        await assert.rejects(db.store.history('two').readRun({ id: run.id, before: page.nextCursor }), error => error instanceof HistoryError && error.code === 'invalid');
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(pages, 4); assert.equal(seen.size, 10);
    assert.equal((await history.readRun({ id: next.id }))?.memory?.receipt?.commit, 'c'.repeat(40));
    assert.equal(await db.store.history('two').readRun({ id: run.id }), null);
    assert.deepEqual(await writer.load(), before); await writer.verifyActive();
  } finally { await db.close(); }
});
