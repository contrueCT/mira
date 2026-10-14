import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatusPolling } from '../src/status-polling.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture() {
  let working = false, hidden = false, reads = 0;
  let release: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let held = false;
  // App.refresh already shares one request between manual and timer-driven refreshes.
  const refresh = () => {
    if (inFlight) return inFlight;
    reads++;
    const request = held ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    inFlight = request;
    void request.then(() => { polling.statusChanged(); inFlight = undefined; });
    return request;
  };
  const polling = createStatusPolling(refresh, () => working, () => hidden);
  return { polling, refresh, reads: () => reads, work: () => { working = true; }, idle: () => { working = false; },
    hide: () => { hidden = true; polling.visibilityChanged(); }, show: () => { hidden = false; polling.visibilityChanged(); },
    hold: () => { held = true; }, release: () => { held = false; release?.(); } };
}

test('manual idle-to-working refresh replaces the stale idle timer with the active interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.polling.stop());
  await f.polling.poll(); assert.equal(f.reads(), 1);
  t.mock.timers.tick(200); f.work(); await f.refresh();
  t.mock.timers.tick(1199); await flush(); assert.equal(f.reads(), 2);
  t.mock.timers.tick(1); await flush(); assert.equal(f.reads(), 3);
  t.mock.timers.tick(1200); await flush(); assert.equal(f.reads(), 4);
});

test('repeated working refreshes never postpone an active timer or leave a duplicate idle timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.polling.stop());
  await f.polling.poll(); f.work(); await f.refresh();
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(300); await f.refresh(); }
  assert.equal(f.reads(), 5);
  t.mock.timers.tick(300); await flush(); assert.equal(f.reads(), 6);
  // Returning to idle uses the same one-shot scheduler. The original 5s timer is gone.
  f.idle(); t.mock.timers.tick(1200); await flush(); assert.equal(f.reads(), 7);
  t.mock.timers.tick(2600); await flush(); assert.equal(f.reads(), 7);
  t.mock.timers.tick(2400); await flush(); assert.equal(f.reads(), 8);
});

test('working observation preserves a pending poll that is already sooner than the active interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.polling.stop());
  await f.polling.poll(); t.mock.timers.tick(4500); f.work(); await f.refresh();
  t.mock.timers.tick(500); await flush(); assert.equal(f.reads(), 3);
});

test('visibility cancellation clears the rearmed timer and resumes with one shared refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.polling.stop());
  await f.polling.poll(); f.work(); await f.refresh(); f.hide();
  t.mock.timers.tick(10_000); await flush(); assert.equal(f.reads(), 2);
  f.hold(); f.show(); f.hide(); f.show(); void f.refresh();
  assert.equal(f.reads(), 3); f.release(); await flush();
  t.mock.timers.tick(1200); await flush(); assert.equal(f.reads(), 4);
  t.mock.timers.tick(1200); await flush(); assert.equal(f.reads(), 5);
});

test('a hidden completion cannot rearm polling and disposal cancels both pending and late timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(); t.after(() => f.polling.stop());
  await f.polling.poll(); f.work(); await f.refresh();
  f.hold(); t.mock.timers.tick(1200); assert.equal(f.reads(), 3);
  f.hide(); f.release(); await flush(); t.mock.timers.tick(10_000); assert.equal(f.reads(), 3);
  f.show(); await flush(); f.polling.stop();
  f.polling.statusChanged(); f.show(); t.mock.timers.tick(10_000); await flush(); assert.equal(f.reads(), 4);
  const late = fixture(); late.hold(); void late.polling.poll(); late.polling.stop(); late.work(); late.release(); await flush();
  t.mock.timers.tick(10_000); await flush(); assert.equal(late.reads(), 1);
});
