import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DreamingScheduler, dreamingDefaults, dreamingInstruction, dreamingPolicy } from '../../apps/server/src/dreaming.ts';

const pause = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
test('Dreaming policy is separate from compaction and defaults to the approved conjunction', () => {
  assert.deepEqual(dreamingDefaults, { idleMs: 1_800_000, intervalMs: 86_400_000, minCompactions: 3 });
  assert.equal(dreamingPolicy({ enabled: false }).enabled, false);
  for (const field of ['idleMs', 'intervalMs', 'minCompactions'] as const) {
    for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => dreamingPolicy({ [field]: value }));
  }
  assert.match(dreamingInstruction, /current files before editing/);
  assert.match(dreamingInstruction, /No change is a valid result/);
  assert.match(dreamingInstruction, /new user request priority/);
  assert.match(dreamingInstruction, /Do not announce routine memory maintenance/);
});
test('one timer uses durable next deadline, no-change stops and close cancels', async () => {
  let calls = 0;
  const scheduler = new DreamingScheduler(async () => ++calls === 1 ? new Date(Date.now() + 15).toISOString() : null, error => { throw error; });
  scheduler.schedule();
  await pause(60); assert.equal(calls, 2);
  await pause(); assert.equal(calls, 2);
  await scheduler.close(); scheduler.schedule(); await pause(); assert.equal(calls, 2);
});
test('concurrent lifecycle signals recheck after current work without overlapping', async () => {
  let release!: () => void; let entered!: () => void; let calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new DreamingScheduler(async () => { calls++; if (calls === 1) { entered(); await gate; } return null; }, error => { throw error; });
  scheduler.schedule(); await started;
  scheduler.schedule(); scheduler.schedule(); assert.equal(calls, 1);
  release(); await pause(); assert.equal(calls, 2); await scheduler.close();
});
test('failed eligibility check never hot-retries; later explicit lifecycle can check again', async () => {
  let calls = 0; const errors: unknown[] = [];
  const scheduler = new DreamingScheduler(async () => { calls++; throw Error('fixture'); }, error => errors.push(error));
  scheduler.schedule(); scheduler.schedule();
  await pause(40); assert.equal(calls, 1); assert.equal(errors.length, 1);
  scheduler.schedule(); await pause(); assert.equal(calls, 2); await scheduler.close();
});
test('close awaits a check already in flight and prevents its deadline from rearming', async () => {
  let release!: () => void; let entered!: () => void; let calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new DreamingScheduler(async () => { calls++; entered(); await gate; return new Date().toISOString(); }, error => { throw error; });
  scheduler.schedule(); await started;
  let closed = false; const closing = scheduler.close().then(() => { closed = true; });
  await pause(); assert.equal(closed, false);
  release(); await closing; await pause(); assert.equal(calls, 1);
});
