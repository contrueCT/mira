import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ArtifactStore, ExtensionHost, readExtensionConfiguration, type ChangeStatus, type RegisteredTool } from '@mira/extension-host';

const sdk = fileURLToPath(new URL('../../packages/extension-sdk/', import.meta.url));
const receive = async () => 'inserted' as const;
const execution = { callId: 'synthetic-generated', signal: new AbortController().signal };
const events = new Map<string, string[]>();
(globalThis as unknown as { generatedTestEvents: Map<string, string[]> }).generatedTestEvents = events;
async function fixture(run: (root: string, source: string, store: ArtifactStore, config: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-generated-'));
  const source = path.join(root, 'source');
  try {
    await mkdir(path.join(source, 'node_modules/@mira'), { recursive: true });
    await symlink(sdk, path.join(source, 'node_modules/@mira/extension-sdk'));
    await writeFile(path.join(source, 'package.json'), '{"type":"module","private":true}');
    const store = new ArtifactStore(path.join(root, 'artifacts'));
    const config = path.join(root, 'extensions.json');
    await writeFile(config, JSON.stringify({ entries: [], artifactsDirectory: store.root, unrelated: 'preserve' }));
    events.set(root, []);
    await run(root, source, store, config);
  } finally { events.delete(root); await rm(root, { recursive: true, force: true }); }
}
async function sourceVersion(source: string, root: string, version: string, fail?: 'import' | 'apply'): Promise<void> {
  await writeFile(path.join(source, 'helper.mjs'), `export const version = ${JSON.stringify(version)};`);
  await writeFile(path.join(source, 'entry.mjs'), `
    import { defineExtension } from '@mira/extension-sdk';
    import { version } from './helper.mjs';
    const events = globalThis.generatedTestEvents.get(${JSON.stringify(root)});
    events.push('import:' + version);
    ${fail === 'import' ? "throw Error('synthetic import failure');" : ''}
    let calls = 0;
    export default defineExtension({name: 'generated', apply(ctx, config) {
      events.push('apply:' + version + ':' + config.label);
      let live = true;
      ctx.provideService('generated', { read: () => { if (!live) throw Error('retired service'); return version; } });
      ctx.onCleanup(() => { events.push('clean:' + version); live = false; });
      ctx.registerTool({ name: 'generated_echo', description: 'Generated synthetic echo ' + version,
        parameters: { type: 'object', properties: { value: { type: ${JSON.stringify(version === 'two' ? 'number' : 'string')} } } },
        async execute() { return { text: version + ':' + config.label + ':' + (++calls) }; } });
      ${fail === 'apply' ? "throw Error('synthetic apply failure');" : ''}
    }});
  `);
}
const state = (host: ExtensionHost, accepted: ChangeStatus) => host.changeStatus().find(item => item.id === accepted.id)!;
const echo = (tools: RegisteredTool[]) => tools.find(item => item.tool.name === 'generated_echo')!;
const execute = async (tool: RegisteredTool) => (await tool.tool.execute(null, execution)).text;

test('generated install is import-free; activate, dependency update, explicit rollback and removal preserve real versions and config', async () => fixture(async (root, source, store, config) => {
  await sourceVersion(source, root, 'one');
  const first = await store.stage(source, 'entry.mjs');
  assert.deepEqual(events.get(root), []);
  const host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
  try {
    await host.start();
    const install = host.requestChange('generated', { action: 'install', digest: first.digest, config: { label: 'old' } });
    assert.deepEqual(await host.prepare(), []);
    assert.equal(state(host, install).status, 'applied');
    assert.equal(state(host, install).test, 'not-run');
    assert.deepEqual(events.get(root), [], 'install disabled must not import');
    const originalRevision = host.inspect()[0]!.generated!.revision;
    host.requestChange('generated', { action: 'activate' });
    const old = echo(await host.prepare());
    assert.equal(await execute(old), 'one:old:1');
    assert.equal(old.digest, first.digest);
    await sourceVersion(source, root, 'two');
    const second = await store.stage(source, 'entry.mjs');
    assert.notEqual(second.digest, first.digest);
    const update = host.requestChange('generated', { action: 'update', digest: second.digest, config: { label: 'new' } });
    assert.equal(await execute(old), 'one:old:2', 'accepted change leaves the current batch alive');
    assert.equal(events.get(root)!.includes('clean:one'), false);
    const latest = echo(await host.prepare());
    assert.equal(state(host, update).persistence, 'saved');
    assert.equal(await execute(latest), 'two:new:1');
    assert.notEqual(latest.activation, old.activation);
    assert.equal(latest.tool.parameters.properties!['value'] && (latest.tool.parameters.properties!['value'] as { type: string }).type, 'number');
    assert.ok(events.get(root)!.includes('clean:one'));
    host.requestChange('generated', { action: 'rollback', revision: originalRevision });
    const rollback = echo(await host.prepare());
    assert.equal(await execute(rollback), 'one:old:1', 'rollback imports fresh module state, including transitive code');
    assert.notEqual(rollback.activation, old.activation);
    assert.equal(rollback.digest, first.digest);
    host.requestChange('generated', { action: 'disable' });
    assert.deepEqual(await host.prepare(), []);
    await host.close();
    const restarted = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
    try {
      const count = events.get(root)!.length;
      await restarted.start();
      assert.equal(events.get(root)!.length, count, 'disabled restart cannot import');
      assert.deepEqual(await restarted.prepare(), []);
      restarted.requestChange('generated', { action: 'activate' });
      assert.equal(await execute(echo(await restarted.prepare())), 'one:old:1');
      restarted.requestChange('generated', { action: 'remove' });
      assert.deepEqual(await restarted.prepare(), []);
      assert.deepEqual(restarted.inspect(), []);
      const saved = JSON.parse(await readFile(config, 'utf8'));
      assert.deepEqual(saved.entries, []); assert.equal(saved.unrelated, 'preserve');
      await store.verify(first); await store.verify(second);
      assert.equal((await readFile(path.join(source, 'helper.mjs'), 'utf8')).includes('two'), true);
    } finally { await restarted.close(); }
  } finally { await host.close(); }
}));

test('generated import/apply failures report saved desired state and restart attempts it without claiming rollback', async () => {
  for (const failure of ['import', 'apply'] as const) await fixture(async (root, source, store, config) => {
    await sourceVersion(source, root, 'one'); const good = await store.stage(source, 'entry.mjs');
    const host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
    try {
      await host.start(); host.requestChange('generated', { action: 'install', digest: good.digest, config: { label: 'working' } }); await host.finish();
      host.requestChange('generated', { action: 'activate' }); await host.prepare();
      await sourceVersion(source, root, 'broken', failure); const bad = await store.stage(source, 'entry.mjs');
      const change = host.requestChange('generated', { action: 'update', digest: bad.digest });
      assert.deepEqual(await host.prepare(), []);
      assert.equal(state(host, change).status, 'failed'); assert.equal(state(host, change).persistence, 'saved');
      assert.equal(host.inspect()[0]!.generated!.digest, bad.digest);
      assert.equal(JSON.parse(await readFile(config, 'utf8')).entries[0].generated.digest, bad.digest);
      await host.close();
      const restarted = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
      try {
        await restarted.start(); assert.deepEqual(await restarted.prepare(), []);
        assert.ok(['failed', 'import-failed'].includes(restarted.inspect()[0]!.status));
        assert.deepEqual(restarted.changeStatus(), [], 'accepted management history is not blindly replayed');
      } finally { await restarted.close(); }
    } finally { await host.close(); }
  });
});

test('artifact mutation and external JSON conflict leave current runtime untouched with truthful unsaved receipts', async () => fixture(async (root, source, store, config) => {
  await sourceVersion(source, root, 'one'); const first = await store.stage(source, 'entry.mjs');
  const host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
  try {
    await host.start(); host.requestChange('generated', { action: 'install', digest: first.digest, config: { label: 'old' } }); await host.finish();
    host.requestChange('generated', { action: 'activate' }); const old = echo(await host.prepare());
    await sourceVersion(source, root, 'two'); const second = await store.stage(source, 'entry.mjs');
    const external = (await readFile(config, 'utf8')) + '\n'; await writeFile(config, external);
    const conflict = host.requestChange('generated', { action: 'update', digest: second.digest });
    assert.equal(echo(await host.prepare()).activation, old.activation);
    assert.equal(state(host, conflict).persistence, 'failed');
    assert.equal(await readFile(config, 'utf8'), external);
    await writeFile(path.join(second.directory, 'helper.mjs'), 'export const version = "mutation"');
    const mutated = host.requestChange('generated', { action: 'update', digest: second.digest });
    assert.equal(echo(await host.prepare()).activation, old.activation);
    assert.equal(state(host, mutated).artifact, 'failed');
    assert.equal(state(host, mutated).persistence, 'not-attempted');
    assert.equal(state(host, mutated).status, 'failed');
    assert.equal(await execute(old), 'one:old:1');
  } finally { await host.close(); }
}));

test('update, rollback, disable and remove drain dependent service consumers after the old tool batch', async () => fixture(async (root, source, store, config) => {
  await sourceVersion(source, root, 'one'); const first = await store.stage(source, 'entry.mjs');
  const consumer = path.join(root, 'consumer.mjs');
  await writeFile(consumer, `import { defineExtension } from ${JSON.stringify(new URL('../../packages/extension-sdk/src/index.ts', import.meta.url).href)};
    export default defineExtension({ name:'consumer', requires:['generated'], apply(ctx) {
      const service = ctx.service('generated'); const events = globalThis.generatedTestEvents.get(${JSON.stringify(root)});
      let ticks = 0; ctx.interval(() => ticks++, 2);
      ctx.onEvent('synthetic', () => events.push('event:' + service.read()));
      ctx.onCleanup(async () => { await new Promise(r => setTimeout(r, 2)); events.push('consumer-clean:' + service.read()); });
      ctx.registerTool({ name:'consume',description:'read leased service',parameters:{type:'object'}, async execute() {
        await new Promise(r => setTimeout(r, 3)); ctx.publish('synthetic', null); return { text: service.read() + ':' + ticks };
      }});
    }});`);
  const initial = JSON.parse(await readFile(config, 'utf8'));
  initial.entries.push({ id:'consumer',path:consumer }); await writeFile(config, JSON.stringify(initial));
  const host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
  try {
    await host.start(); host.requestChange('generated', { action:'install',digest:first.digest,config:{label:'old'} }); await host.finish();
    host.requestChange('generated', {action:'activate'}); let tools = await host.prepare();
    const revision = host.inspect().find(item => item.id === 'generated')!.generated!.revision;
    await sourceVersion(source, root, 'two'); const second = await store.stage(source, 'entry.mjs');
    for (const change of [
      {action:'update',digest:second.digest}, {action:'rollback',revision}, {action:'disable'},
    ] as const) {
      const old = tools.find(item => item.tool.name === 'consume')!;
      const before = await execute(old); const pending = execute(old);
      host.requestChange('generated', change);
      assert.equal((await pending).split(':')[0], before.split(':')[0]);
      const previousEvents = events.get(root)!.length;
      tools = await host.prepare();
      const appended = events.get(root)!.slice(previousEvents);
      assert.equal(appended[0], `consumer-clean:${before.split(':')[0]}`);
      assert.equal(appended[1], `clean:${before.split(':')[0]}`, 'dependent cleanup can read old service before provider closes it');
    }
    assert.deepEqual(tools, []);
    assert.equal(host.inspect().find(item => item.id === 'consumer')!.status, 'waiting');
    host.requestChange('generated', {action:'activate'}); tools = await host.prepare();
    const pending = execute(tools.find(item => item.tool.name === 'consume')!);
    host.requestChange('generated', {action:'remove'});
    assert.match(await pending, /^one:/);
    assert.deepEqual(await host.prepare(), []);
    assert.equal(host.inspect().find(item => item.id === 'consumer')!.status, 'waiting');
    assert.equal(events.get(root)!.at(-2), 'consumer-clean:one');
    assert.equal(events.get(root)!.at(-1), 'clean:one');
  } finally { await host.close(); }
}));

test('generated desired revisions are detached from caller objects and reject contradictory config on restart', async () => fixture(async (root, source, store, config) => {
  await sourceVersion(source, root, 'one'); const first = await store.stage(source, 'entry.mjs');
  const host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive });
  await host.start();
  try { host.requestChange('generated', { action:'install',digest:first.digest,config:{label:'saved'} }); await host.finish(); }
  finally { await host.close(); }
  const loaded = await readExtensionConfiguration(config);
  const independent = new ExtensionHost({ entries: loaded.entries, artifactsDirectory: store.root, receive });
  loaded.entries[0]!.generated!.digest = '0'.repeat(64);
  loaded.entries[0]!.generated!.history[0]!.config = { label:'caller-mutated' };
  try {
    await independent.start(); independent.requestChange('generated', {action:'activate'});
    assert.equal(await execute(echo(await independent.prepare())), 'one:saved:1');
  } finally { await independent.close(); }
  const contradictory = await readExtensionConfiguration(config);
  contradictory.entries[0]!.config = { label:'contradictory' };
  assert.throws(() => new ExtensionHost({ ...contradictory, receive }), /config does not match saved revision/);
  const before = await readExtensionConfiguration(config);
  const changed = JSON.parse(await readFile(config,'utf8'));
  changed.artifactsDirectory = path.join(root,'different-artifacts'); await writeFile(config,JSON.stringify(changed));
  const stale = new ExtensionHost({ ...before, receive });
  try { await assert.rejects(stale.start(), /changed since it was loaded/); }
  finally { await stale.close(); }
}));

for (const cleanupThrows of [false, true]) test(`activation-time mutation invalidates evidence even when cleanup throws=${cleanupThrows}`,  async () => fixture(async (root, source, store, config) => {
  await sourceVersion(source, root, 'one');
  const entry = path.join(source, 'entry.mjs');
  await writeFile(entry, "import { writeFile } from 'node:fs/promises';\n" + (await readFile(entry,'utf8')).replace(
    "ctx.onCleanup(() => { events.push('clean:' + version); live = false; });",
    `ctx.onCleanup(async () => { events.push('clean:' + version); live = false; if (config.mutatePath) await writeFile(config.mutatePath, '// deliberate synthetic cleanup mutation'); ${cleanupThrows ? "throw Error('synthetic cleanup also failed');" : ''} });`,
  ));
  const first = await store.stage(source, 'entry.mjs');
  await sourceVersion(source, root, 'two'); const second = await store.stage(source, 'entry.mjs');
  assert.equal((await store.test(second, {command:process.execPath,args:['-e','process.exit(0)']})).passed,true);
  const host = new ExtensionHost({ ...await readExtensionConfiguration(config),receive });
  try {
    await host.start(); host.requestChange('generated',{action:'install',digest:first.digest,config:{label:'old',mutatePath:second.entry}}); await host.finish();
    host.requestChange('generated',{action:'activate'}); await host.prepare();
    const update = host.requestChange('generated',{action:'update',digest:second.digest,config:{label:'new'}});
    assert.deepEqual(await host.prepare(),[]);
    const final = state(host,update);
    assert.equal(final.status,'failed'); assert.equal(final.persistence,'saved');
    assert.equal(final.artifact,'failed'); assert.equal(final.test,'invalidated');
    assert.match(final.error!, /Artifact content changed/);
    assert.equal(JSON.parse(await readFile(config,'utf8')).entries[0].generated.digest,second.digest);
  } finally { await host.close(); }
}));

test('remove retains visible cleanup failure after dropping the configured identity', async () => fixture(async (root, source, store, config) => {
  await sourceVersion(source,root,'one'); const entry = path.join(source,'entry.mjs');
  await writeFile(entry,(await readFile(entry,'utf8')).replace("live = false; });", "live = false; throw Error('synthetic resource close failure'); });"));
  const first = await store.stage(source,'entry.mjs');
  const host = new ExtensionHost({...await readExtensionConfiguration(config),receive});
  try {
    await host.start(); host.requestChange('generated',{action:'install',digest:first.digest,config:{label:'old'}}); await host.finish();
    host.requestChange('generated',{action:'activate'}); await host.prepare();
    const remove = host.requestChange('generated',{action:'remove'}); assert.deepEqual(await host.prepare(),[]);
    const final = state(host,remove); assert.equal(final.status,'failed'); assert.equal(final.persistence,'saved'); assert.equal(final.cleanup,'failed');
    assert.match(final.error!,/synthetic resource close failure/);
    assert.deepEqual(host.inspect(),[]); assert.deepEqual(JSON.parse(await readFile(config,'utf8')).entries,[]);
    assert.ok(host.diagnosticsLog().some(message => /synthetic resource close failure/.test(message)));
    await store.verify(first);
  } finally { await host.close(); }
}));


test('manual HMR excludes nested generated artifacts through canonical and alias store paths', () => {
  const child = spawnSync(process.execPath, ['--expose-internals', 'tests/unit/fixtures/generated-hmr-exclusion-probe.mjs'], { encoding:'utf8', timeout:20_000 });
  assert.equal(child.status,0,`${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout,/GENERATED_HMR_EXCLUSION_COMPLETE/);
});
