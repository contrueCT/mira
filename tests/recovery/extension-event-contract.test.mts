import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { ExtensionHost } from '@mira/extension-host';
import type { Json } from '@mira/extension-sdk';
import type { DurableWriter, LifeEvent, WakeReceipt } from '@mira/life';
import { extensionReceiver } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { createExtensionFixture } from './extension-fixtures.mts';

const extensionId = 'source-contract';
const namespace = (id: string) => JSON.stringify(['extension', extensionId, id]);
// Fixed dates belong only to these synthetic fixtures. Production facts keep
// their original source timestamp and full envelope across delivery attempts.
const observation = (revision = 'revision-1') => ({
  id: JSON.stringify(['source-record', 'record-7', revision]),
  type: 'fixture.source-fact',
  occurredAt: '2026-10-07T08:15:00.000Z',
  payload: {
    source: 'synthetic-source', recordId: 'record-7', revision,
    occurredAt: '2026-10-07T08:15:00.000Z',
    data: { status: 'failed', count: 2, labels: ['original', 'bounded'], optional: null },
  },
});

async function start(
  fixture: Awaited<ReturnType<typeof createExtensionFixture>>, writer: DurableWriter, submission: Json,
): Promise<ExtensionHost> {
  const host = new ExtensionHost({ entries: [{ id: extensionId, path: fixture.modulePath,
    config: { ...fixture.config, startup: [submission] } }], receive: extensionReceiver(writer) });
  try { await host.start(); return host; }
  catch (error) { await host.close(); throw error; }
}

async function rows(db: Awaited<ReturnType<typeof createTestDatabase>>) {
  return {
    events: (await db.admin.query<{ event_id: string; event: LifeEvent; requested_wake: WakeReceipt | null; history_id: string }>(
      'SELECT event_id, event, requested_wake, history_id FROM life_events ORDER BY event_id')).rows,
    wakes: (await db.admin.query<{ event_id: string; wake_id: string; wake: WakeReceipt }>(
      'SELECT event_id, wake_id, wake FROM wake_requests ORDER BY wake_id')).rows,
  };
}

test('real Host and PostgreSQL retain one full source fact across restarts without a Wake', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture();
  const event = observation(); let host: ExtensionHost | undefined;
  try {
    let writer = await db.acquire('event-only-contract');
    host = await start(fixture, writer, { event });
    assert.equal(host.inspect()[0]!.status, 'active');
    const original = await rows(db);
    assert.equal(original.events.length, 1); assert.deepEqual(original.wakes, []);
    assert.deepEqual(original.events[0]!.event, {
      id: namespace(event.id), type: event.type, source: 'extension', occurredAt: event.occurredAt,
      payload: { extensionId, eventId: event.id, data: event.payload },
    }, 'the source envelope survives inside the host-bound authoritative envelope');
    assert.equal(original.events[0]!.requested_wake, null);
    assert.equal(await writer.claimWakeBatch(), null, 'a fact alone cannot create cognition');
    await host.close(); host = undefined; await writer.close();
    writer = await db.acquire('event-only-contract');
    host = await start(fixture, writer, { event: structuredClone(event) });
    assert.equal(host.inspect()[0]!.status, 'active');
    assert.deepEqual(await rows(db), original, 'duplicate delivery preserves every field and original History identity');
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate']);
    assert.equal(await writer.claimWakeBatch(), null);
    const snapshot = await writer.load();
    assert.equal(snapshot.version, 0); assert.deepEqual(snapshot.records, []); assert.deepEqual(snapshot.executions, []);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 0);
  } finally { await host?.close(); await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Host and PostgreSQL accept exact Event+Wake retries and reject changed bodies under the same ID', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture();
  const event = observation(); const wake = { id: event.id, reason: 'Synthetic source status matched the configured rule' };
  let host: ExtensionHost | undefined;
  try {
    let writer = await db.acquire('event-wake-contract');
    host = await start(fixture, writer, { event, wake });
    assert.equal(host.inspect()[0]!.status, 'active');
    const original = await rows(db);
    assert.equal(original.events.length, 1); assert.equal(original.wakes.length, 1);
    assert.deepEqual(original.events[0]!.event, {
      id: namespace(event.id), type: event.type, source: 'extension', occurredAt: event.occurredAt,
      payload: { extensionId, eventId: event.id, data: event.payload },
    });
    const expectedWake = { id: namespace(wake.id), reason: wake.reason };
    assert.deepEqual(original.events[0]!.requested_wake, expectedWake);
    assert.deepEqual(original.wakes[0], { event_id: namespace(event.id), wake_id: namespace(wake.id), wake: expectedWake });
    await host.close(); host = undefined; await writer.close();
    writer = await db.acquire('event-wake-contract');
    host = await start(fixture, writer, structuredClone({ event, wake }));
    assert.equal(host.inspect()[0]!.status, 'active');
    assert.deepEqual(await rows(db), original);
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate']);
    await host.close(); host = undefined;

    const conflicts = [
      { event: { ...event, occurredAt: '2026-10-07T08:15:01.000Z' }, wake },
      { event: { ...event, payload: { ...event.payload, data: { ...event.payload.data, count: 3 } } }, wake },
      { event: { ...event, type: 'fixture.changed-type' }, wake },
      { event, wake: { ...wake, reason: 'Changed reason for the same source fact' } },
      { event, wake: { ...wake, id: 'changed-wake-id' } },
      { event },
    ];
    for (const conflicting of conflicts) {
      host = await start(fixture, writer, conflicting);
      const state = host.inspect()[0]!;
      assert.equal(state.status, 'failed');
      assert.match(state.diagnostic ?? '', /Event ID was reused with different data or wake/);
      assert.deepEqual(await rows(db), original, 'a conflicting delivery cannot mutate the original Event or Wake');
      assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate'], 'a rejection is never recorded as a duplicate receipt');
      await host.close(); host = undefined;
    }

    // A changed source revision is a new fact, with a new event and Wake ID.
    const revised = { ...observation('revision-2'), occurredAt: '2026-10-07T08:16:00.000Z',
      payload: { ...observation('revision-2').payload, occurredAt: '2026-10-07T08:16:00.000Z',
        data: { ...event.payload.data, count: 3 } } };
    host = await start(fixture, writer, { event: revised, wake: { id: revised.id, reason: wake.reason } });
    assert.equal(host.inspect()[0]!.status, 'active');
    const afterRevision = await rows(db);
    assert.equal(afterRevision.events.length, 2); assert.equal(afterRevision.wakes.length, 2);
    assert.deepEqual(afterRevision.events.find(row => row.event_id === namespace(event.id)), original.events[0]);
    assert.deepEqual(afterRevision.events.find(row => row.event_id === namespace(revised.id))!.event.payload,
      { extensionId, eventId: revised.id, data: revised.payload });
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate', 'inserted']);
  } finally { await host?.close(); await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
