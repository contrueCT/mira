import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WakeLoop, prepareWakeTurn, renderWakeBatch, type WakeRun, type WakeRequest, type WakeWriter } from '@mira/life';
import type { CognitionTurn } from '@mira/cognition';

const event = (id: string): WakeRequest => ({ event: { id, type: 'message', source: 'user', occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: `Message ${id}` } }, wake: { id: `wake-${id}`, reason: 'user message' } });
const run = (requests = [event('one')]): WakeRun => ({ id: 'run-one', claimedAt: '2026-10-05T01:00:00.000Z', status: 'running', requests, inputRecordId: null, finalRecordId: null });
const noOverflow = async (): Promise<never> => { throw Error('unexpected overflow'); };
function fixture() {
  const pending: WakeRequest[] = [];
  const history: WakeRequest[] = [];
  let active: WakeRun | null = null;
  const completed: WakeRun[] = [];
  const controller = new AbortController();
  const writer = {
    miraId: 'one-mira', epoch: '1', signal: controller.signal,
    assertActive() { controller.signal.throwIfAborted(); },
    async verifyActive() { this.assertActive(); },
    async claimWakeBatch() {
      this.assertActive();
      if (!active && pending.length) active = { ...run(pending.splice(0)), id: `run-${completed.length + 1}` };
      return active && structuredClone(active);
    },
    async loadWakeRun(id: string) { const found = [active, ...completed].find(r => r?.id === id); if (!found) throw Error('missing'); return structuredClone(found); },
    async completeWakeRun(id: string) { this.assertActive(); if (!active || active.id !== id || !active.finalRecordId) throw Error('missing final'); completed.push({ ...active, status: 'completed' }); active = null; },
  } as WakeWriter;
  const inputs: CognitionTurn[] = [];
  const options = { writer, writeOverflowInput: noOverflow, createRuntime: () => ({ async continueTurn(turn: CognitionTurn) { assert.ok(active); if (active.finalRecordId) return; inputs.push(turn); active.inputRecordId ??= `input-${turn.id}`; active.finalRecordId = `final-${turn.id}`; } }) };
  return { pending, history, completed, writer, controller, options, inputs, setActive(value: WakeRun) { active = value; } };
}

test('event-only history never creates cognition; all pending wakes coalesce into one turn', async () => {
  const f = fixture(); f.history.push(event('history-only'));
  assert.equal(await new WakeLoop(f.options).drain(), 0); assert.equal(f.inputs.length, 0);
  f.pending.push(event('a'), event('b'), event('c'));
  assert.equal(await new WakeLoop(f.options).drain(), 1);
  assert.equal(f.inputs.length, 1);
  for (const id of ['a', 'b', 'c']) assert.match(f.inputs[0]!.input, new RegExp(`Message ${id}`));
  assert.doesNotMatch(f.inputs[0]!.input, /history-only/);
  assert.equal(f.completed[0]!.requests.length, 3);
});

test('arrivals during cognition are another coalesced batch, without preemption', async () => {
  const f = fixture(); f.pending.push(event('a'));
  let calls = 0;
  const original = f.options.createRuntime;
  f.options.createRuntime = () => ({ async continueTurn(turn) {
    calls++;
    if (calls === 1) f.pending.push(event('b'), event('c'));
    await original().continueTurn(turn);
  } });
  assert.equal(await new WakeLoop(f.options).drain(), 2);
  assert.deepEqual(f.completed.map(r => r.requests.map(x => x.event.id)), [['a'], ['b', 'c']]);
});

test('a persisted final before completion needs neither another model call nor input append', async () => {
  const f = fixture(); f.setActive({ ...run(), inputRecordId: 'input', finalRecordId: 'reply' });
  assert.equal(await new WakeLoop(f.options).drain(), 1);
  assert.equal(f.inputs.length, 0); assert.equal(f.completed[0]!.finalRecordId, 'reply');
});

test('one writer cannot run two cognition loops concurrently', async () => {
  const f = fixture(); f.pending.push(event('a'));
  let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
  let release!: () => void; const held = new Promise<void>(r => { release = r; });
  const original = f.options.createRuntime;
  f.options.createRuntime = () => ({ async continueTurn(turn) { enter(); await held; await original().continueTurn(turn); } });
  const first = new WakeLoop(f.options).drain(); await entered;
  await assert.rejects(new WakeLoop(f.options).drain(), /already has an active/);
  release(); assert.equal(await first, 1);
});

test('overflow remains one turn with complete ordinary text file and exact path notice', async () => {
  const f = fixture(); f.pending.push(event('a'), event('b'));
  const files = new Map<string, string>();
  const options = { ...f.options, maxInlineBytes: 1, writeOverflowInput: async (id: string, content: string) => {
    files.set(id, content); return { path: '/tmp/synthetic-wake/batch.txt', bytes: Buffer.byteLength(content) };
  } };
  assert.equal(await new WakeLoop(options).drain(), 1);
  assert.equal(f.inputs.length, 1); assert.equal(files.size, 1);
  assert.match(f.inputs[0]!.input, /2 accumulated wake requests are unread/);
  assert.match(f.inputs[0]!.input, /\/tmp\/synthetic-wake\/batch.txt/);
  assert.match(f.inputs[0]!.input, /ordinary file read tool/);
  assert.doesNotMatch(f.inputs[0]!.input, /Message a/);
  assert.match([...files.values()][0]!, /Message a/); assert.match([...files.values()][0]!, /Message b/);
});

test('recovery rematerializes missing overflow from immutable canonical batch before cognition', async () => {
  const batch = { ...run(), inputRecordId: 'saved-input' }; let writes = 0;
  const write = async (_id: string, content: string) => { writes++; assert.equal(content, renderWakeBatch(batch)); return { path: '/tmp/synthetic/batch.txt', bytes: Buffer.byteLength(content) }; };
  const first = await prepareWakeTurn(batch, write, 1);
  const second = await prepareWakeTurn(structuredClone(batch), write, 1);
  assert.deepEqual(second, first); assert.equal(writes, 2); assert.equal(second.inputRecordId, 'saved-input');
});

test('overflow write failure retains active batch and later invocation recovers it', async () => {
  const f = fixture(); f.pending.push(event('a'));
  await assert.rejects(new WakeLoop({ ...f.options, maxInlineBytes: 1, writeOverflowInput: async () => { throw Error('disk unavailable'); } }).drain(), /disk unavailable/);
  assert.equal(f.inputs.length, 0); assert.equal(f.completed.length, 0);
  assert.equal(await new WakeLoop(f.options).drain(), 1); assert.equal(f.inputs.length, 1);
});

test('ownership loss stops the loop and cancellation never claims pending requests', async () => {
  const f = fixture(); f.pending.push(event('a')); f.controller.abort(Error('ownership lost'));
  await assert.rejects(new WakeLoop(f.options).drain(), /ownership lost/); assert.equal(f.inputs.length, 0);
  const g = fixture(); g.pending.push(event('b')); const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(new WakeLoop(g.options).drain(controller.signal), /cancelled/); assert.equal(g.pending.length, 1);
});
