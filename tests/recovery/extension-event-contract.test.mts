import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { ExtensionHost } from '@mira/extension-host';
import type { ExtensionEvent, Json } from '@mira/extension-sdk';
import { isEventContentConflict } from '@mira/extension-sdk/testing';
import type { DurableWriter, LifeEvent, WakeReceipt } from '@mira/life';
import { DurableOperationError } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { extensionReceiver } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import {
  EVENT_REUSED, contractScenarios, detailedScenarioNames, replayScenarioNames, scenarioNames, sourceObservation,
  writerValidationCases, type ContractEvent, type ContractSubmission,
} from '../shared/extension-event-contract-cases.mts';
import { createExtensionFixture } from './extension-fixtures.mts';

const extensionId = 'source-contract';
const namespace = (id: string) => JSON.stringify(['extension', extensionId, id]);

async function start(
  fixture: Awaited<ReturnType<typeof createExtensionFixture>>, writer: DurableWriter, submission: ContractSubmission,
): Promise<ExtensionHost> {
  const host = new ExtensionHost({ entries: [{ id: extensionId, path: fixture.modulePath,
    config: { ...fixture.config, startup: [submission as unknown as Json] } }], receive: extensionReceiver(writer) });
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

function shown(message: string): RegExp {
  return new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

async function assertContentConflict(writer: DurableWriter, event: ContractEvent, wake: { id: string; reason: string } | undefined, message: string): Promise<void> {
  await assert.rejects(() => extensionReceiver(writer)(extensionId, event, wake), (error: unknown) => {
    assert.ok(error instanceof PersistenceError);
    assert.equal(error.code, 'duplicate');
    assert.equal(error.message, message);
    assert.equal(DurableOperationError.categoryOf(error), 'event-content-conflict');
    assert.equal(Object.hasOwn(error, 'category'), false);
    assert.equal(isEventContentConflict(error), true);
    return true;
  });
}

test('shared event contract scenarios stay wired to this PostgreSQL path', () => {
  assert.deepEqual(contractScenarios().map(item => item.name), [...scenarioNames]);
  assert.deepEqual(detailedScenarioNames, ['event-only', 'event-and-wake']);
  assert.deepEqual([...detailedScenarioNames, ...replayScenarioNames], [...scenarioNames]);
});

test('real Host and PostgreSQL retain one full source fact across restarts without a Wake', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture();
  const found = contractScenarios().find(item => item.name === 'event-only');
  assert.ok(found);
  assert.deepEqual(found.steps.map(item => item.name), ['insert', 'duplicate', 'add-wake', 'retry-after-conflict']);
  const inserted = found.steps[0]!.create();
  const event = inserted.event;
  let host: ExtensionHost | undefined;
  try {
    let writer = await db.acquire('event-only-contract');
    host = await start(fixture, writer, inserted);
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
    host = await start(fixture, writer, found.steps[1]!.create());
    assert.equal(host.inspect()[0]!.status, 'active');
    assert.deepEqual(await rows(db), original, 'duplicate delivery preserves every field and original History identity');
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate']);
    assert.equal(await writer.claimWakeBatch(), null);
    const snapshot = await writer.load();
    assert.equal(snapshot.version, 0); assert.deepEqual(snapshot.records, []); assert.deepEqual(snapshot.executions, []);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 0);
    await host.close(); host = undefined;
    const added = found.steps[2]!.create();
    host = await start(fixture, writer, added);
    const conflicted = host.inspect()[0]!;
    assert.equal(conflicted.status, 'failed');
    assert.match(conflicted.diagnostic ?? '', /Event ID was reused with different data or wake/);
    assert.deepEqual(await rows(db), original, 'a later Wake under the same id cannot mutate the fact');
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate'], 'a rejection is never recorded as a duplicate receipt');
    await assertContentConflict(writer, added.event, added.wake, found.steps[2]!.message ?? EVENT_REUSED);
    await host.close(); host = undefined;
    host = await start(fixture, writer, found.steps[3]!.create());
    assert.equal(host.inspect()[0]!.status, 'active');
    assert.deepEqual(await rows(db), original, 'the rejected Wake did not consume the original fact');
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate', 'duplicate']);
  } finally { await host?.close(); await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Host and PostgreSQL accept exact Event+Wake retries and reject changed bodies under the same ID', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture();
  const found = contractScenarios().find(item => item.name === 'event-and-wake');
  assert.ok(found);
  assert.deepEqual(found.steps.map(item => item.name), ['insert', 'duplicate', 'occurredAt', 'payload', 'type', 'wake-reason', 'wake-id', 'remove-wake', 'revised']);
  const opening = found.steps[0]!.create();
  const event = opening.event;
  const wake = opening.wake!;
  let host: ExtensionHost | undefined;
  try {
    let writer = await db.acquire('event-wake-contract');
    host = await start(fixture, writer, opening);
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
    host = await start(fixture, writer, found.steps[1]!.create());
    assert.equal(host.inspect()[0]!.status, 'active');
    assert.deepEqual(await rows(db), original);
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate']);
    await host.close(); host = undefined;

    for (const item of found.steps.slice(2, 8)) {
      const conflicting = item.create();
      host = await start(fixture, writer, conflicting);
      const state = host.inspect()[0]!;
      assert.equal(state.status, 'failed');
      assert.match(state.diagnostic ?? '', /Event ID was reused with different data or wake/);
      assert.deepEqual(await rows(db), original, 'a conflicting delivery cannot mutate the original Event or Wake');
      assert.deepEqual((await fixture.receipts()).map(entry => entry.receipt), ['inserted', 'duplicate'], 'a rejection is never recorded as a duplicate receipt');
      await assertContentConflict(writer, conflicting.event, conflicting.wake, item.message ?? EVENT_REUSED);
      await host.close(); host = undefined;
    }

    // A changed source revision is a new fact, with a new event and Wake ID.
    const revisedSubmission = found.steps[8]!.create();
    const revised = revisedSubmission.event;
    host = await start(fixture, writer, revisedSubmission);
    assert.equal(host.inspect()[0]!.status, 'active');
    const afterRevision = await rows(db);
    assert.equal(afterRevision.events.length, 2); assert.equal(afterRevision.wakes.length, 2);
    assert.deepEqual(afterRevision.events.find(row => row.event_id === namespace(event.id)), original.events[0]);
    assert.deepEqual(afterRevision.events.find(row => row.event_id === namespace(revised.id))!.event.payload,
      { extensionId, eventId: revised.id, data: revised.payload });
    assert.deepEqual((await fixture.receipts()).map(item => item.receipt), ['inserted', 'duplicate', 'inserted']);
  } finally { await host?.close(); await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real Host and PostgreSQL replay the remaining shared Event and Wake cases', { timeout: 60_000 }, async () => {
  for (const name of replayScenarioNames) {
    const found = contractScenarios().find(item => item.name === name);
    assert.ok(found, name);
    const db = await createTestDatabase(); const fixture = await createExtensionFixture();
    let host: ExtensionHost | undefined;
    try {
      const writer = await db.acquire(name);
      let stored = await rows(db);
      const receipts: string[] = [];
      for (const item of found.steps) {
        const submission = item.create();
        host = await start(fixture, writer, submission);
        const state = host.inspect()[0]!;
        if (item.outcome === 'event-content-conflict') {
          assert.equal(state.status, 'failed', `${name}/${item.name}`);
          assert.match(state.diagnostic ?? '', shown(item.message ?? ''), item.name);
          assert.deepEqual(await rows(db), stored, `${name}/${item.name}`);
          assert.deepEqual((await fixture.receipts()).map(entry => entry.receipt), receipts, item.name);
          await assertContentConflict(writer, submission.event, submission.wake, item.message ?? '');
        } else {
          assert.equal(state.status, 'active', `${name}/${item.name}`);
          receipts.push(item.outcome);
          const next = await rows(db);
          if (item.outcome === 'duplicate') assert.deepEqual(next, stored, `${name}/${item.name}`);
          else {
            assert.equal(next.events.length, stored.events.length + 1, item.name);
            assert.equal(next.wakes.length, stored.wakes.length + (submission.wake ? 1 : 0), item.name);
            stored = next;
          }
          assert.deepEqual((await fixture.receipts()).map(entry => entry.receipt), receipts, item.name);
        }
        await host.close(); host = undefined;
      }
    } finally { await host?.close(); await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test('real PostgreSQL receive rejects malformed events with the writer errors the host surfaces', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('writer-invalid');
    const receive = extensionReceiver(writer);
    for (const item of writerValidationCases()) {
      await assert.rejects(() => receive(extensionId, item.event as ExtensionEvent), (error: unknown) => {
        assert.ok(error instanceof Error, item.name);
        assert.equal(error.name, item.errorName, item.name);
        assert.equal(error.message, item.message, item.name);
        if (item.code) {
          assert.ok(error instanceof PersistenceError, item.name);
          assert.equal(error.code, item.code, item.name);
          assert.equal(DurableOperationError.categoryOf(error), undefined, item.name);
        } else assert.equal(error instanceof PersistenceError, false, item.name);
        return true;
      });
    }
    assert.equal((await rows(db)).events.length, 0);
    assert.equal(await receive(extensionId, sourceObservation('after-invalid')), 'inserted');
    assert.equal((await rows(db)).events.length, 1);
  } finally { await db.close(); }
});
