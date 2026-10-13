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
      assert.equal(page.run.requestCount, 1);
      assert.equal((await history.readRunRequests({ id: run.id }))?.items[0]?.eventId, queued.eventId);
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

test('large coalesced Wake headers, status-sized reads, list and trigger pages never aggregate full membership', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('large-runs'); const history = db.store.history(writer.miraId);
    let version = 0; let parent: string | null = null;
    const runs: string[] = [];
    for (const count of [1500, 6501]) {
      const prefix = `synthetic-management-coalesced-${count}-`;
      // Bulk fixture inserts preserve the same identity/type/FK and immutable
      // Event/Wake envelopes as receive(). Only the real fenced writer may claim,
      // attach input/final evidence and complete these runs below.
      await db.admin.query(`WITH seed AS MATERIALIZED (
        SELECT gen_random_uuid() AS history_id, $2::text || n::text AS event_id FROM generate_series(1, $3::int) AS n),
        identities AS (INSERT INTO history_records(id, mira_id, kind) SELECT history_id, $1, 'event' FROM seed RETURNING id),
        events AS (INSERT INTO life_events(mira_id, history_id, event_id, event, requested_wake)
          SELECT $1, s.history_id, s.event_id,
            json_build_object('id', s.event_id, 'type', 'web.message', 'source', 'user', 'occurredAt', $4::text, 'payload', json_build_object('text', 'Synthetic bulk request')),
            json_build_object('id', 'web:' || s.event_id, 'reason', 'User message from the local web interface')
          FROM seed s JOIN identities i ON i.id = s.history_id RETURNING event_id)
        INSERT INTO wake_requests(mira_id, wake_id, event_id, wake)
        SELECT $1, 'web:' || event_id, event_id, json_build_object('id', 'web:' || event_id, 'reason', 'User message from the local web interface') FROM events`, [writer.miraId, prefix, count, now]);
      const run = await writer.claimWakeBatch(); assert(run); assert.equal(run.requests.length, count); runs.push(run.id);
      const found = await history.findEventRun(`${prefix}1`); assert.equal(found?.runId, run.id);
      const initial = await history.readRun({ id: run.id, limit: 1 }); assert(initial);
      assert.equal(initial.run.requestCount, count); assert.equal(initial.run.status, 'running');
      assert(Buffer.byteLength(JSON.stringify(initial)) < 4096, 'status-sized read has fixed metadata, no membership array');
      assert.equal(Object.hasOwn(initial.run, 'requests'), false);
      const input = `${prefix}input`; const final = `${prefix}final`;
      version = await writer.appendWakeInput(run.id, version, record(input, parent));
      version = await writer.appendWakeFinal(run.id, version, record(final, input)); parent = final;
      await writer.prepareMemoryCheckpoint({ runId: run.id, finalRecordId: uuid(final), preparedAt: now, payload: {} });
      await writer.finishMemoryCheckpoint({ runId: run.id, commit: null }); await writer.completeWakeRun(run.id);
      const completed = await history.readRun({ id: run.id, limit: 1 }); assert(completed);
      assert.equal(completed.run.requestCount, count); assert.equal(completed.run.status, 'completed');
      assert.equal(completed.memory?.receipt?.commit, null); assert(completed.nextCursor);
      const summary = await history.pageRuns({ limit: 1 }); assert.equal(summary.items[0]?.requestCount, count);
      assert.equal(summary.items[0]?.id, run.id); assert(Buffer.byteLength(JSON.stringify(summary)) < 4096);
      if (count > 6000) await assert.rejects(history.read({ id: run.id, maxBytes: 1_048_576 }), error => error instanceof HistoryError && error.code === 'too_large');
      let cursor: string | undefined; const seen = new Set<string>();
      do {
        const page = await history.readRunRequests({ id: run.id, limit: 100, ...(cursor ? { before: cursor } : {}) }); assert(page);
        assert(page.items.length <= 100); assert(Buffer.byteLength(JSON.stringify(page)) < 30_000);
        for (const member of page.items) { assert(!seen.has(member.eventId)); seen.add(member.eventId); assert.equal(member.type, 'web.message'); assert.equal(member.reason, 'User message from the local web interface'); }
        if (page.nextCursor) await assert.rejects(history.readRun({ id: run.id, before: page.nextCursor }), error => error instanceof HistoryError && error.code === 'invalid');
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.size, count, 'every trigger is reachable, without duplicates or silent omission');
    }
    const latest = await history.pageRuns({ limit: 1 }); assert(latest.nextCursor);
    const older = await history.pageRuns({ limit: 1, before: latest.nextCursor }); assert.equal(older.items[0]?.id, runs[0]); assert.equal(older.items[0]?.requestCount, 1500);
    const members = await history.readRunRequests({ id: runs[0]!, limit: 1 }); assert(members?.nextCursor);
    await assert.rejects(history.readRunRequests({ id: runs[1]!, before: members.nextCursor }), error => error instanceof HistoryError && error.code === 'invalid');
    const oversizedReason = 'A'.repeat(5000);
    await writer.receive({ id: 'oversized-trigger', type: 'web.message', source: 'user', occurredAt: now, payload: { text: 'Preserve complete reason' } }, { id: 'oversized-trigger-wake', reason: oversizedReason });
    const oversized = await writer.claimWakeBatch(); assert(oversized);
    const unavailable = await history.readRunRequests({ id: oversized.id }); assert(unavailable);
    assert.deepEqual(unavailable.items, [{ eventId: oversized.requests[0]!.eventId, source: 'unavailable', type: 'unavailable', reason: null }]);
    const original = await history.read({ id: oversized.requests[0]!.eventId }); assert(original?.kind === 'event'); assert.equal(original.requestedWake?.reason, oversizedReason);
    await writer.verifyActive();
  } finally { await db.close(); }
});
