// Separate --expose-internals process: the test exercises real watcher delivery
// through the host, without reaching into private Cordis or host internals.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '@mira/extension-host';

const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-host-hmr-'));
const entry = path.join(directory, 'entry.mjs');
const state = globalThis.extensionHostProbe = { runs: [], received: [], gate: null, release: null };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sdk = import.meta.resolve('@mira/extension-sdk');
const source = version => `
  import { defineExtension } from ${JSON.stringify(sdk)};
  export default defineExtension({ name: 'host-hmr', apply(ctx) {
    const run = { version: ${version}, ticks: 0, events: 0, closed: false };
    globalThis.extensionHostProbe.runs.push(run);
    ctx.provideService('lease-resource', { read() { if (run.closed) throw Error('resource closed'); return run.version; } });
    ctx.interval(() => { run.ticks++; }, 5);
    ctx.onEvent('lease-ping', () => { run.events++; });
    ctx.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 10)); run.closed = true; });
    ctx.registerContextProvider({ id: 'observation', async provide({signal}) {
      signal.throwIfAborted(); await globalThis.extensionHostProbe.gate;
      return { text: 'provider:' + ctx.service('lease-resource').read() };
    } });
    ctx.registerTool({ name: 'lease', description: 'Use an execution-leased generation', parameters: { type: 'object' },
      async execute() {
        await globalThis.extensionHostProbe.gate;
        ctx.publish('lease-ping', null);
        const resource = ctx.service('lease-resource');
        await ctx.emitEvent({ id: 'event-' + run.version + '-' + run.events, type: 'lease-test', occurredAt: '2026-10-05T00:00:00.000Z', payload: { version: run.version } });
        return { text: run.version + ':' + resource.read() };
      }
    });
  } });
`;
const host = new ExtensionHost({
  entries: [{ id: 'host-hmr', path: entry }], hmr: true,
  async receive(source, event, wake) { state.received.push({ source, event, wake }); return 'inserted'; },
});
async function until(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), `${label}; status=${JSON.stringify(host.inspect())}; runs=${JSON.stringify(state.runs)}`);
}
const execute = tool => tool.tool.execute(null, { callId: 'hmr-lease-call', signal: new AbortController().signal });
let success = false;
try {
  await writeFile(entry, source(1));
  await host.start();
  assert.equal(host.hmrEnabled, true);
  const initial = await host.prepareCapabilities();
  const first = initial.tools[0];
  const firstProvider = initial.contextProviders[0];
  assert.equal((await firstProvider.sample(new AbortController().signal)).text, 'provider:1');
  assert.ok(first);
  assert.equal((await execute(first)).text, '1:1');
  await until(() => state.runs[0].ticks > 0, 'initial timer should tick');
  // HMR exposes no public ready promise; allow chokidar's initial scan, then
  // require an observed unloading state rather than assuming a change happened.
  await sleep(200);
  state.gate = new Promise(resolve => { state.release = resolve; });
  const pending = execute(first);
  const pendingSample = firstProvider.sample(new AbortController().signal);
  await writeFile(entry, source(2));
  await until(() => host.inspect()[0].status === 'unloading', 'HMR should reach the held generation');
  const old = state.runs[0];
  const ticksDuringUnload = old.ticks;
  assert.equal(old.closed, false);
  assert.equal((await firstProvider.sample(new AbortController().signal)).status, 'stale');
  assert.equal(state.runs.length, 1, 'new apply must wait for the actual in-flight call');
  assert.deepEqual((await execute(first)).details, { status: 'stale', executed: false, extensionId: 'host-hmr', activation: first.activation, toolName: 'lease' });
  assert.equal(old.events, 1, 'unloading activation rejects new calls before entering its closure');
  await until(() => old.ticks > ticksDuringUnload, 'pinned timer should stay live during disposal');
  assert.equal(state.received.length, 1);
  state.release(); state.gate = null;
  assert.equal((await pending).text, '1:1', 'executing call can still use old service, listener and emit during disposal');
  assert.equal((await pendingSample).text, 'provider:1', 'sampling retains its own generation through HMR');
  assert.equal(state.received.length, 2);
  assert.equal(state.received[1].source, 'host-hmr');
  assert.equal(state.received[1].wake, undefined);
  assert.deepEqual(state.received[1].event.payload, { version: 1 });
  await until(() => state.runs.length === 2 && old.closed, 'HMR must complete without another request boundary');
  const replacement = await host.prepareCapabilities();
  const second = replacement.tools[0];
  const secondProvider = replacement.contextProviders[0];
  assert.notEqual(secondProvider.activation, firstProvider.activation);
  assert.equal((await secondProvider.sample(new AbortController().signal)).text, 'provider:2');
  assert.equal((await firstProvider.sample(new AbortController().signal)).status, 'stale');
  assert.ok(second, 'next boundary should publish the replacement tool');
  assert.equal(old.closed, true, 'boundary awaits async old cleanup');
  assert.notEqual(second.activation, first.activation);
  assert.equal((await execute(second)).text, '2:2');
  const oldTicks = old.ticks;
  await until(() => state.runs[1].ticks > 0, 'replacement timer should run');
  await sleep(20);
  assert.equal(old.ticks, oldTicks, 'retired timer cannot leak');
  assert.equal(old.events, 2, 'retired listener cannot leak');
  assert.equal((await execute(first)).details.executed, false, 'retired declaration cannot emit new activity');
  assert.equal(state.received.length, 3);
  await host.finish();
  success = true;
} finally {
  state.release?.();
  await host.close();
  if (success) {
    const final = structuredClone(state.runs);
    await sleep(20);
    assert.deepEqual(state.runs, final);
    assert.ok(state.runs.every(run => run.closed));
  }
  delete globalThis.extensionHostProbe;
  await rm(directory, { recursive: true, force: true });
}
console.log('MIRA_HOST_HMR_RESULT:passed');
