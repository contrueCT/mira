// Exercise a real watcher and real ConfigurationWriter save. The retained large
// JSON field makes ordinary async save I/O overlap HMR without patching internals.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost, readExtensionConfiguration } from '@mira/extension-host';

const action = process.argv[2];
assert.ok(['disable', 'configure'].includes(action));
const root = await mkdtemp(path.join(os.tmpdir(), 'mira-hmr-management-'));
const entry = path.join(root, 'entry.mjs');
const configurationFile = path.join(root, 'extensions.json');
const sdk = import.meta.resolve('@mira/extension-sdk');
const state = globalThis.hmrManagementRace = { imported: [], runs: [], gate: null, release: null };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const source = version => `
  import { defineExtension } from ${JSON.stringify(sdk)};
  globalThis.hmrManagementRace.imported.push(${version});
  export default defineExtension({ name: 'race', apply(ctx, config) {
    const run = { version: ${version}, label: config.label, ticks: 0, closed: false };
    globalThis.hmrManagementRace.runs.push(run);
    ctx.interval(() => run.ticks++, 5);
    ctx.provideService('race-resource', { read() { if (run.closed) throw Error('closed resource'); return run.version + ':' + run.label; } });
    ctx.onCleanup(() => { run.closed = true; });
    ctx.registerTool({ name: 'race', description: 'Read real execution-leased resource', parameters: { type: 'object' }, async execute() {
      await globalThis.hmrManagementRace.gate;
      return { text: ctx.service('race-resource').read() };
    } });
  } });
`;
const execute = tool => tool.tool.execute(null, { callId: 'race-call', signal: new AbortController().signal });
async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!await predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(await predicate(), label);
}
await writeFile(entry, source(1));
await writeFile(configurationFile, JSON.stringify({ entries: [{ id: 'race', path: entry, config: { label: 'initial' } }], hmr: true, retained: 'x'.repeat(64 * 1024 * 1024) }));
const originalInode = (await stat(configurationFile)).ino;
const host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive: async () => 'inserted' });
let changing;
let completed = false;
try {
  await host.start();
  const old = (await host.prepare())[0];
  assert.ok(old);
  await sleep(200); // The official watcher does not expose its initial scan.
  state.gate = new Promise(resolve => { state.release = resolve; });
  const executing = execute(old);
  changing = host.requestChange('race', action === 'configure' ? { action, config: { label: 'updated' } } : { action });
  await until(async () => (await readdir(root)).some(name => name.startsWith('.extensions.json.') && name.endsWith('.tmp')), 'Real configuration save must begin before the source edit');
  await writeFile(entry, source(2));
  await until(() => state.imported.includes(2) && host.inspect()[0].status === 'unloading', 'HMR must retire the executing generation during the save');
  assert.equal(host.inspect()[0].enabled, true, 'HMR reaches the old runtime before the management mutation');
  assert.deepEqual(host.inspect()[0].config, { label: 'initial' });
  await until(async () => (await stat(configurationFile)).ino !== originalInode, 'Real desired configuration must be atomically published');
  // Atomic publication precedes the writer's final temporary-file cleanup.
  // Keep the real call running while that I/O completes and management resumes.
  await sleep(100);
  assert.equal(state.runs[0].closed, false, 'The actual call still owns its resource after persistence');
  state.release(); state.gate = null;
  assert.equal((await executing).text, '1:initial');
  const receipt = await changing;
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.persistence, 'saved');
  assert.equal(receipt.runtime.diagnostic, null);
  assert.deepEqual(receipt.runtime, host.inspect()[0]);
  const tools = await host.prepare();
  if (action === 'disable') {
    assert.equal(receipt.runtime.status, 'disabled');
    assert.deepEqual(receipt.runtime.tools, []);
    assert.deepEqual(tools, []);
    assert.ok(state.runs.every(run => run.closed), 'Disable disposes every HMR generation, including native timers/services');
    const stopped = structuredClone(state.runs);
    await writeFile(entry, source(3));
    await sleep(200);
    assert.deepEqual(state.runs, stopped, 'Later HMR must not resurrect a disabled runtime or timer');
    assert.deepEqual(await host.prepare(), []);
  } else {
    assert.equal(receipt.runtime.status, 'active');
    assert.deepEqual(receipt.runtime.config, { label: 'updated' });
    assert.equal((await execute(tools[0])).text, '2:updated', 'The actual HMR replacement uses the saved configuration');
    assert.ok(state.runs.slice(0, -1).every(run => run.closed));
    assert.notEqual(tools[0].activation, old.activation);
  }
  assert.equal((await execute(old)).details.executed, false);
  const saved = JSON.parse(await readFile(configurationFile, 'utf8'));
  assert.equal(saved.retained.length, 64 * 1024 * 1024);
  if (action === 'disable') assert.equal(saved.entries[0].enabled, false);
  else assert.deepEqual(saved.entries[0].config, { label: 'updated' });
  completed = true;
} finally {
  state.release?.();
  await changing;
  await host.close();
  if (completed) assert.ok(state.runs.every(run => run.closed));
  delete globalThis.hmrManagementRace;
  await rm(root, { recursive: true, force: true });
}
console.log(`HMR_MANAGEMENT_RACE_COMPLETE:${action}`);
