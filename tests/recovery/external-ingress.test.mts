import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExternalEvent, ExternalReceipt } from '@mira/external-sdk';
import { DurableOperationError, type LifeEvent, type WakeReceipt } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { createExternalIngress, type ExternalIngress } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';

type Operation = 'event' | 'wake';
const sender = 'synthetic-sender-a';
const reason = 'Synthetic source status matched the configured rule';
const wakeId = 'attention-record-7';
const namespace = (senderId: string, id: string) => JSON.stringify(['external', senderId, id]);
// These timestamps and source values are fixed synthetic fixtures, never live inputs.
const observation = (count = 2, id = 'record-7.revision-1'): ExternalEvent => ({
  id, type: 'fixture.source-fact', occurredAt: '2026-10-11T08:15:00.000Z',
  payload: { recordId: 'record-7', revision: 'revision-1', data: { count, status: 'failed', labels: ['original', 'bounded'], optional: null } },
});
function sourceEvent(senderId: string, event: ExternalEvent): LifeEvent {
  return {
    id: namespace(senderId, event.id), type: event.type, source: 'external', occurredAt: event.occurredAt,
    payload: { senderId, operation: 'event', eventId: event.id, data: event.payload },
  };
}
function submit(ingress: ExternalIngress, operation: Operation, senderId: string, event: ExternalEvent) {
  return operation === 'event'
    ? ingress.emitEvent(senderId, event)
    : ingress.requestWake(senderId, { id: wakeId, reason, event });
}
function receipt(operation: Operation, event: ExternalEvent, status: 'inserted' | 'duplicate'): ExternalReceipt {
  return operation === 'event'
    ? { operation, id: event.id, receipt: status, durability: 'persisted' }
    : { operation, id: wakeId, eventId: event.id, receipt: status, durability: 'persisted' };
}
function isContentConflict(error: unknown): boolean {
  assert.ok(error instanceof PersistenceError);
  assert.equal(error.code, 'duplicate');
  assert.equal(DurableOperationError.categoryOf(error), 'event-content-conflict');
  return true;
}
async function rows(db: Awaited<ReturnType<typeof createTestDatabase>>) {
  return {
    events: (await db.admin.query<{ event_id: string; event: LifeEvent; requested_wake: WakeReceipt | null; history_id: string }>(
      'SELECT event_id, event, requested_wake, history_id FROM life_events ORDER BY event_id')).rows,
    wakes: (await db.admin.query<{ event_id: string; wake_id: string; wake: WakeReceipt; receipt_order: string }>(
      'SELECT event_id, wake_id, wake, receipt_order FROM wake_requests ORDER BY receipt_order')).rows,
    identities: (await db.admin.query<{ id: string; mira_id: string; kind: string }>(
      'SELECT id, mira_id, kind FROM history_records ORDER BY id')).rows,
  };
}

for (const operation of ['event', 'wake'] as const) {
  test(`real PostgreSQL external ${operation}: concurrent exact retries persist once and survive writer restart`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase();
    try {
      let writer = await db.acquire(); let kicks = 0;
      let ingress = createExternalIngress(writer, () => { kicks++; });
      const event = observation();
      const receipts = await Promise.all(Array.from({ length: 8 }, () => submit(ingress, operation, sender, structuredClone(event))));
      assert.equal(receipts.filter(result => result.receipt === 'inserted').length, 1);
      assert.equal(receipts.filter(result => result.receipt === 'duplicate').length, 7);
      for (const result of receipts) assert.deepEqual(result, receipt(operation, event, result.receipt));
      assert.equal(kicks, operation === 'wake' ? 1 : 0);

      const original = await rows(db);
      assert.equal(original.events.length, 1);
      const saved = original.events[0]!;
      const expectedWake = operation === 'wake' ? { id: namespace(sender, wakeId), reason } : null;
      assert.deepEqual(saved, {
        event_id: namespace(sender, event.id), event: sourceEvent(sender, event), requested_wake: expectedWake, history_id: saved.history_id,
      });
      assert.match(saved.history_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.notEqual(saved.history_id, event.id, 'external identity is distinct from the global History UUID');
      assert.deepEqual(original.identities, [{ id: saved.history_id, mira_id: writer.miraId, kind: 'event' }]);
      assert.equal(original.wakes.length, operation === 'wake' ? 1 : 0);
      if (expectedWake) assert.deepEqual(original.wakes[0], {
        event_id: namespace(sender, event.id), wake_id: expectedWake.id, wake: expectedWake, receipt_order: original.wakes[0]!.receipt_order,
      });
      const snapshot = await writer.load();
      assert.equal(snapshot.version, 0); assert.deepEqual(snapshot.records, []); assert.deepEqual(snapshot.executions, []);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 0,
        'a persistence receipt does not claim that cognition ran');
      if (operation === 'event') assert.equal(await writer.claimWakeBatch(), null, 'a silent fact cannot create cognition');

      await writer.close();
      writer = await db.acquire();
      let restartKicks = 0;
      ingress = createExternalIngress(writer, () => { restartKicks++; });
      assert.deepEqual(await submit(ingress, operation, sender, structuredClone(event)), receipt(operation, event, 'duplicate'));
      assert.equal(restartKicks, 0, 'durable retries do not kick cognition again after restart');
      assert.deepEqual(await rows(db), original, 'exact retry keeps the full source fact, receipt order and original History identity');
      assert.deepEqual(await writer.load(), snapshot);
      if (operation === 'event') assert.equal(await writer.claimWakeBatch(), null);
    } finally { await db.close(); }
  });

  test(`real PostgreSQL external ${operation}: concurrent conflicting bodies have one winner and leave no extra identity`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase();
    try {
      const writer = await db.acquire(); let kicks = 0;
      const ingress = createExternalIngress(writer, () => { kicks++; });
      const candidates = [observation(2), observation(3)];
      const results = await Promise.allSettled(candidates.map(event => submit(ingress, operation, sender, event)));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      const winnerIndex = results.findIndex(result => result.status === 'fulfilled');
      const winner = candidates[winnerIndex]!;
      for (const result of results) {
        if (result.status === 'fulfilled') assert.deepEqual(result.value, receipt(operation, winner, 'inserted'));
        else isContentConflict(result.reason);
      }
      const original = await rows(db);
      assert.equal(original.events.length, 1); assert.equal(original.identities.length, 1);
      assert.equal(original.wakes.length, operation === 'wake' ? 1 : 0);
      assert.deepEqual(original.events[0]!.event, sourceEvent(sender, winner));
      assert.equal(kicks, operation === 'wake' ? 1 : 0);
      assert.deepEqual(await submit(ingress, operation, sender, structuredClone(winner)), receipt(operation, winner, 'duplicate'));
      await assert.rejects(submit(ingress, operation, sender, candidates[1 - winnerIndex]!), isContentConflict);
      assert.deepEqual(await rows(db), original);
      assert.equal(kicks, operation === 'wake' ? 1 : 0);
      await writer.verifyActive();
    } finally { await db.close(); }
  });

  test(`real PostgreSQL external ${operation}: identical caller IDs remain isolated by server-bound sender`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase();
    try {
      const writer = await db.acquire(); let kicks = 0;
      const ingress = createExternalIngress(writer, () => { kicks++; });
      const deliveries = [{ senderId: sender, event: observation(2) }, { senderId: 'synthetic-sender-b', event: observation(3) }];
      const receipts = await Promise.all(deliveries.map(({ senderId, event }) => submit(ingress, operation, senderId, event)));
      assert.deepEqual(receipts.map(result => result.receipt), ['inserted', 'inserted']);
      const original = await rows(db);
      assert.equal(original.events.length, 2); assert.equal(original.identities.length, 2);
      assert.equal(new Set(original.events.map(row => row.history_id)).size, 2);
      assert.equal(original.wakes.length, operation === 'wake' ? 2 : 0);
      for (const { senderId, event } of deliveries) {
        const saved = original.events.find(row => row.event_id === namespace(senderId, event.id));
        assert.ok(saved); assert.deepEqual(saved.event, sourceEvent(senderId, event));
        const expectedWake = operation === 'wake' ? { id: namespace(senderId, wakeId), reason } : null;
        assert.deepEqual(saved.requested_wake, expectedWake);
        if (expectedWake) {
          const wake = original.wakes.find(row => row.wake_id === expectedWake.id);
          assert.ok(wake); assert.equal(wake.event_id, saved.event_id); assert.deepEqual(wake.wake, expectedWake);
        }
        assert.deepEqual(await submit(ingress, operation, senderId, structuredClone(event)), receipt(operation, event, 'duplicate'));
      }
      assert.deepEqual(await rows(db), original);
      assert.equal(kicks, operation === 'wake' ? 2 : 0);
    } finally { await db.close(); }
  });

  test(`real PostgreSQL external ${operation}: switching to ${operation === 'event' ? 'wake' : 'event'} conflicts without changing accepted evidence`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase();
    try {
      const writer = await db.acquire(); let kicks = 0;
      const ingress = createExternalIngress(writer, () => { kicks++; });
      const event = observation();
      assert.deepEqual(await submit(ingress, operation, sender, event), receipt(operation, event, 'inserted'));
      const original = await rows(db);
      const switched = operation === 'event' ? 'wake' : 'event';
      await assert.rejects(submit(ingress, switched, sender, structuredClone(event)), isContentConflict);
      assert.deepEqual(await rows(db), original, 'an event cannot be upgraded or have its original Wake removed');
      assert.equal(kicks, operation === 'wake' ? 1 : 0);
      assert.deepEqual(await submit(ingress, operation, sender, event), receipt(operation, event, 'duplicate'));
      assert.deepEqual(await rows(db), original);
      if (operation === 'event') assert.equal(await writer.claimWakeBatch(), null);
    } finally { await db.close(); }
  });
}

test('real PostgreSQL external Wake: a reused Wake ID rolls back the new event and its reserved History identity', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); let kicks = 0;
    const ingress = createExternalIngress(writer, () => { kicks++; });
    const event = observation();
    assert.equal((await ingress.requestWake(sender, { id: wakeId, reason, event })).receipt, 'inserted');
    const original = await rows(db);
    const otherEvent = observation(3, 'record-7.revision-2');
    await assert.rejects(ingress.requestWake(sender, { id: wakeId, reason, event: otherEvent }), error => {
      isContentConflict(error); assert.match((error as Error).message, /Wake ID already belongs to another event/); return true;
    });
    assert.deepEqual(await rows(db), original, 'the rejected event and History reservation must roll back with the conflicting Wake');
    assert.equal(kicks, 1);
    // The failed transaction must not poison the writer or reserve the new event ID.
    const otherWakeId = 'attention-record-7.revision-2';
    assert.equal((await ingress.requestWake(sender, { id: otherWakeId, reason, event: otherEvent })).receipt, 'inserted');
    const after = await rows(db);
    assert.equal(after.events.length, 2); assert.equal(after.wakes.length, 2); assert.equal(after.identities.length, 2);
    assert.deepEqual(after.events.find(row => row.event_id === namespace(sender, event.id)), original.events[0]);
    assert.deepEqual(after.wakes.find(row => row.wake_id === namespace(sender, wakeId)), original.wakes[0]);
    assert.deepEqual(after.events.find(row => row.event_id === namespace(sender, otherEvent.id))!.event, sourceEvent(sender, otherEvent));
    assert.equal(kicks, 2);
  } finally { await db.close(); }
});

test('real PostgreSQL external Wake: pending and claimed work survives restart without duplicate callbacks or run membership', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire(); let kicks = 0;
    const event = observation(); const wake = { id: wakeId, reason, event };
    const ingress = createExternalIngress(writer, () => { kicks++; });
    assert.equal((await ingress.requestWake(sender, wake)).receipt, 'inserted');
    const original = await rows(db);
    await writer.close();

    writer = await db.acquire();
    let restartKicks = 0;
    let restarted = createExternalIngress(writer, () => { restartKicks++; });
    assert.deepEqual(await restarted.requestWake(sender, structuredClone(wake)), receipt('wake', event, 'duplicate'));
    const run = await writer.claimWakeBatch();
    assert.ok(run); assert.equal(run.status, 'running');
    assert.deepEqual(run.requests, [{
      eventId: original.events[0]!.history_id, event: sourceEvent(sender, event), wake: { id: namespace(sender, wakeId), reason },
    }]);
    assert.equal(run.inputRecordId, null); assert.equal(run.finalRecordId, null);
    const claimed = await rows(db);
    assert.equal(claimed.identities.length, 2);
    assert.deepEqual(claimed.events, original.events); assert.deepEqual(claimed.wakes, original.wakes);
    await writer.close();

    writer = await db.acquire();
    restarted = createExternalIngress(writer, () => { restartKicks++; });
    assert.deepEqual(await restarted.requestWake(sender, structuredClone(wake)), receipt('wake', event, 'duplicate'));
    assert.deepEqual(await writer.claimWakeBatch(), run, 'recovery resumes the original run and its original Event History reference');
    assert.deepEqual(await writer.loadWakeRun(run.id), run);
    assert.deepEqual(await rows(db), claimed);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_run_requests')).rows[0].n, 1);
    assert.equal(kicks, 1); assert.equal(restartKicks, 0);
    assert.equal((await writer.load()).version, 0, 'ingress and recovery do not fabricate context or completion');
  } finally { await db.close(); }
});

test('real PostgreSQL external Wake: callback failure after commit remains durable and retries do not replay the callback', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire(); let kicks = 0;
    const event = observation(); const wake = { id: wakeId, reason, event };
    const failure = Error('Synthetic callback failure after durable receipt');
    let ingress = createExternalIngress(writer, () => { kicks++; throw failure; });
    await assert.rejects(ingress.requestWake(sender, wake), error => error === failure);
    const original = await rows(db);
    assert.equal(original.events.length, 1); assert.equal(original.wakes.length, 1); assert.equal(original.identities.length, 1);
    assert.deepEqual(await ingress.requestWake(sender, structuredClone(wake)), receipt('wake', event, 'duplicate'));
    assert.equal(kicks, 1);
    await writer.close();
    writer = await db.acquire();
    ingress = createExternalIngress(writer, () => { kicks++; });
    assert.deepEqual(await ingress.requestWake(sender, structuredClone(wake)), receipt('wake', event, 'duplicate'));
    assert.equal(kicks, 1); assert.deepEqual(await rows(db), original);
    assert.equal((await writer.claimWakeBatch())?.requests.length, 1, 'the original durable Wake remains recoverable despite an uncertain response');
  } finally { await db.close(); }
});
