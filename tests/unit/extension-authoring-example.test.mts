import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { Cleanup, ExtensionContext, ExtensionEvent, ExtensionTool, ExtensionWake, Json } from '@mira/extension-sdk';
import watcher, { type Observation, type WatchConfig, type WatchSource } from '../../skills/mira-extension-authoring/examples/watch-and-wake.ts';

const fact = (id: string, status: string): Observation => ({
  id, revision: 'revision-1', occurredAt: '2026-01-02T03:04:05.000Z', status, payload: { synthetic: true },
});
const config: WatchConfig = { intervalMilliseconds: 1000, targetStatus: 'failed', statusToolName: 'test_watch_status' };
const unexpected = (): never => { throw new Error('Unexpected SDK capability in watcher example'); };

type Status = { running: boolean; stopping: boolean; completedPolls: number; failureCount: number; lastFailure: { phase: string } | null };
async function start(source: WatchSource, delivery?: (kind: 'event' | 'wake') => Promise<'inserted' | 'duplicate'>) {
  const events: ExtensionEvent[] = [], wakes: ExtensionWake[] = [], cleanups: Cleanup[] = [], tools: ExtensionTool[] = [];
  let tick: (() => void) | undefined;
  let serviceReads = 0;
  const context: ExtensionContext = {
    privateDirectory: null, registerSettings: unexpected, credentials: {get: unexpected, has: unexpected, set: unexpected, delete: unexpected},
    schedules: { create: unexpected, get: unexpected, list: unexpected, replace: unexpected, cancel: unexpected },
    id: 'synthetic-watcher',
    service: <T,>(name: string): T => { assert.equal(name, 'watch-source'); serviceReads++; return source as T; },
    onCleanup: cleanup => { cleanups.push(cleanup); },
    registerTool: tool => { tools.push(tool); }, registerContextProvider: unexpected,
    interval: (callback, milliseconds) => { assert.equal(milliseconds, 1000); tick = callback; },
    emitEvent: async event => { events.push(event); return delivery ? delivery('event') : 'inserted'; },
    requestWake: async wake => { wakes.push(wake); return delivery ? delivery('wake') : 'inserted'; },
    onEvent: unexpected, publish: unexpected, provideService: unexpected,
  };
  await watcher.apply({ mira: context }, config);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, config.statusToolName);
  assert.deepEqual(watcher.inject, ['mira.extension.watch-source']);
  return {
    events, wakes, tools,
    tick: () => tick!(),
    serviceReads: () => serviceReads,
    cleanup: async () => { for (const cleanup of cleanups) await cleanup(); },
    status: async (): Promise<Status> => JSON.parse((await tools[0]!.execute({}, {
      callId: 'synthetic-status-call', signal: new AbortController().signal,
    })).text) as Status,
  };
}

// setImmediate only drains known promise continuations; no wall-clock interval,
// credentials, live network, database or model participates in these tests.
test('watcher captures its provider, skips overlapping ticks, and filters facts before Wake', async () => {
  const result = Promise.withResolvers<readonly Observation[]>();
  let polls = 0;
  const source: WatchSource = { id: 'synthetic-source', poll: async () => { polls++; return result.promise; } };
  const running = await start(source);
  try {
    running.tick(); running.tick();
    assert.equal(polls, 1);
    assert.equal((await running.status()).running, true);
    result.resolve([fact('green', 'passed'), fact('red', 'failed')]);
    await setImmediate();
    assert.equal(running.events.length, 1);
    assert.equal(running.wakes.length, 1);
    assert.equal(running.events[0]!.payload && (running.events[0]!.payload as { status: Json }).status, 'passed');
    assert.equal(running.wakes[0]!.event.occurredAt, '2026-01-02T03:04:05.000Z');
    assert.equal(running.wakes[0]!.id, running.wakes[0]!.event.id);
    assert.deepEqual(await running.status(), { running: false, stopping: false, completedPolls: 1, failureCount: 0, lastFailure: null });
    running.tick();
    await setImmediate();
    assert.equal(polls, 2);
    assert.equal(running.events[0]!.id, running.events[1]!.id);
    assert.equal(running.wakes[0]!.id, running.wakes[1]!.id);
    assert.equal(running.serviceReads(), 1);
  } finally { await running.cleanup(); }
});

test('stable source fact IDs survive a new activation and distinguish revisions', async () => {
  const first = await start({ id: 'source', poll: async () => [fact('record', 'failed')] });
  await setImmediate();
  await first.cleanup();
  const second = await start({ id: 'source', poll: async () => [fact('record', 'failed'), { ...fact('record', 'failed'), revision: 'revision-2' }] });
  try {
    await setImmediate();
    assert.equal(first.wakes[0]!.id, second.wakes[0]!.id);
    assert.notEqual(second.wakes[0]!.id, second.wakes[1]!.id);
    assert.deepEqual(JSON.parse(second.wakes[0]!.event.id), ['watch', 'source', 'record', 'revision-1']);
  } finally { await second.cleanup(); }
});

test('cleanup aborts and joins the source poll without reporting expected cancellation', async () => {
  let polls = 0, aborted = false;
  const running = await start({ id: 'source', poll: async signal => {
    polls++;
    return new Promise<readonly Observation[]>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    });
  } });
  await running.cleanup();
  running.tick();
  await setImmediate();
  assert.equal(aborted, true);
  assert.equal(polls, 1);
  assert.equal(running.events.length + running.wakes.length, 0);
  assert.deepEqual(await running.status(), { running: false, stopping: true, completedPolls: 0, failureCount: 0, lastFailure: null });
});

test('cleanup joins pending delivery and submits no later fact after stopping', async () => {
  const delivery = Promise.withResolvers<'inserted' | 'duplicate'>();
  const running = await start({ id: 'source', poll: async () => [fact('one', 'failed'), fact('two', 'failed')] }, () => delivery.promise);
  await setImmediate();
  assert.equal(running.wakes.length, 1);
  let drained = false;
  const cleanup = running.cleanup().then(() => { drained = true; });
  await setImmediate();
  assert.equal(drained, false);
  delivery.resolve('inserted');
  await cleanup;
  running.tick();
  await setImmediate();
  assert.equal(drained, true);
  assert.equal(running.wakes.length, 1);
  assert.equal((await running.status()).running, false);
});

test('poll failures are observed without leaking exception messages and a later tick can succeed', async () => {
  let calls = 0;
  const running = await start({ id: 'source', poll: async () => {
    if (calls++ === 0) throw new Error('Synthetic sensitive message must not appear in status');
    return [];
  } });
  try {
    await setImmediate();
    assert.deepEqual(await running.status(), { running: false, stopping: false, completedPolls: 0, failureCount: 1, lastFailure: { phase: 'poll' } });
    running.tick();
    await setImmediate();
    const status = await running.status();
    assert.equal(status.completedPolls, 1);
    assert.equal(status.failureCount, 1);
    assert.doesNotMatch(JSON.stringify(status), /sensitive/);
    assert.equal(running.wakes.length, 0);
  } finally { await running.cleanup(); }
});

test('event and Wake delivery failures remain observed and the next tick retries identical IDs', async () => {
  for (const target of ['event', 'wake'] as const) {
    let deliveries = 0;
    const running = await start({ id: 'source', poll: async () => [fact('record', target === 'wake' ? 'failed' : 'passed')] }, async kind => {
      assert.equal(kind, target);
      if (deliveries++ === 0) throw new Error('Synthetic delivery failure');
      return 'duplicate';
    });
    try {
      await setImmediate();
      assert.equal((await running.status()).lastFailure?.phase, target);
      running.tick();
      await setImmediate();
      assert.equal((await running.status()).completedPolls, 1);
      const ids = target === 'wake' ? running.wakes.map(wake => wake.event.id) : running.events.map(event => event.id);
      assert.equal(ids.length, 2);
      assert.equal(ids[0], ids[1]);
    } finally { await running.cleanup(); }
  }
});

test('unrelated delivery errors during stopping are not swallowed as cancellation', async () => {
  const delivery = Promise.withResolvers<'inserted' | 'duplicate'>();
  const running = await start({ id: 'source', poll: async () => [fact('one', 'failed')] }, () => delivery.promise);
  await setImmediate();
  const cleanup = running.cleanup();
  delivery.reject(new DOMException('Synthetic delivery abort', 'AbortError'));
  await cleanup;
  assert.equal((await running.status()).failureCount, 1);
  assert.equal((await running.status()).lastFailure?.phase, 'wake');
});

test('invalid config fails before any resource or source is touched', async () => {
  const context: ExtensionContext = {
    privateDirectory: null, registerSettings: unexpected, credentials: {get: unexpected, has: unexpected, set: unexpected, delete: unexpected},
    schedules: { create: unexpected, get: unexpected, list: unexpected, replace: unexpected, cancel: unexpected },
    id: 'invalid', registerTool: unexpected, registerContextProvider: unexpected, emitEvent: unexpected, requestWake: unexpected,
    provideService: unexpected, service: unexpected, onCleanup: unexpected,
    onEvent: unexpected, publish: unexpected, interval: unexpected,
  };
  for (const invalid of [null, {}, { ...config, intervalMilliseconds: 0 }, { ...config, intervalMilliseconds: Infinity },
    { ...config, intervalMilliseconds: 0.5 }, { ...config, intervalMilliseconds: 2 ** 40 }, { ...config, targetStatus: '' }]) {
    assert.throws(() => watcher.apply({ mira: context }, invalid as WatchConfig), /Expected positive/);
  }
});

test('malformed fact identity is observed without submitting it', async () => {
  const running = await start({ id: 'source', poll: async () => [{ ...fact('record', 'failed'), revision: '' }] });
  try {
    await setImmediate();
    assert.equal(running.events.length + running.wakes.length, 0);
    assert.equal((await running.status()).failureCount, 1);
  } finally { await running.cleanup(); }
});

test('the status tool honors the ordinary tool cancellation signal', async () => {
  const running = await start({ id: 'source', poll: async () => [] });
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(running.tools[0]!.execute({}, { callId: 'cancelled-status', signal: controller.signal }), { name: 'AbortError' });
  } finally { await running.cleanup(); }
});
