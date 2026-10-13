import assert from 'node:assert/strict';
import test from 'node:test';
import type { LifeEvent, WakeReceipt } from '@mira/life';
import { createExternalIngress } from '../../apps/server/src/external-ingress.ts';

const event = { id: 'source-revision-1', type: 'watcher.change', occurredAt: '2026-10-11T18:00:00.000Z', payload: { count: 2 } };
function fixture() {
  const calls: Array<{ event: LifeEvent; wake?: WakeReceipt }> = [];
  let kicks = 0;
  let duplicate = false;
  let failure: Error | undefined;
  const ingress = createExternalIngress({ receive: async (input, wake) => {
    if (failure) throw failure;
    calls.push({ event: structuredClone(input), ...(wake ? { wake: structuredClone(wake) } : {}) });
    return duplicate ? 'duplicate' : 'inserted';
  } }, () => { kicks++; });
  return { ingress, calls, kicks: () => kicks, duplicate: () => { duplicate = true; }, fail: () => { failure = Error('Synthetic persistence failure'); } };
}
test('external facts use server-bound provenance and do not wake cognition', async () => {
  const f = fixture();
  assert.deepEqual(await f.ingress.emitEvent('worker-a', event), { operation: 'event', id: event.id, receipt: 'inserted', durability: 'persisted' });
  assert.deepEqual(f.calls, [{ event: {
    id: JSON.stringify(['external', 'worker-a', event.id]), type: event.type, source: 'external', occurredAt: event.occurredAt,
    payload: { senderId: 'worker-a', operation: 'event', eventId: event.id, data: event.payload },
  } }]);
  assert.equal(f.kicks(), 0);
});
test('external Wake preserves full event atomically and only a new durable receipt kicks', async () => {
  const f = fixture(); const wake = { id: 'attention-1', reason: 'A matching change occurred', event };
  assert.deepEqual(await f.ingress.requestWake('worker-a', wake), { operation: 'wake', id: wake.id, eventId: event.id, receipt: 'inserted', durability: 'persisted' });
  assert.deepEqual(f.calls[0]?.wake, { id: JSON.stringify(['external', 'worker-a', wake.id]), reason: wake.reason });
  assert.equal(f.kicks(), 1);
  f.duplicate(); assert.equal((await f.ingress.requestWake('worker-a', wake)).receipt, 'duplicate');
  assert.equal(f.kicks(), 1, 'receipt checks cannot retry failed or finished cognition');
  f.fail(); await assert.rejects(f.ingress.requestWake('worker-a', wake)); assert.equal(f.kicks(), 1);
});
test('event and Wake share event namespaces; separate senders cannot collide', async () => {
  const f = fixture();
  await f.ingress.emitEvent('worker-a', event);
  await f.ingress.requestWake('worker-a', { id: 'wake', reason: 'Relevant fact', event });
  await f.ingress.emitEvent('worker-b', event);
  assert.equal(f.calls[0]?.event.id, f.calls[1]?.event.id);
  assert.notEqual(f.calls[0]?.event.id, f.calls[2]?.event.id);
  await assert.rejects(f.ingress.emitEvent('invalid sender', event)); assert.equal(f.calls.length, 3);
});
