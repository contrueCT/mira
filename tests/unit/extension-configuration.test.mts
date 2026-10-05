import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ExtensionHost, readExtensionConfiguration, type ChangeStatus, type ExtensionHostOptions, type RegisteredTool } from '@mira/extension-host';
import { defineExtension, type ExtensionContext, type Json } from '@mira/extension-sdk';

const sdkUrl = import.meta.resolve('@mira/extension-sdk');
const receive: ExtensionHostOptions['receive'] = async () => 'inserted';
const execution = { callId: 'offline-configuration-call', signal: new AbortController().signal };
interface FixtureState { applied: Json[]; saved: Json[]; cleaned: Json[] }
interface Fixture { extensionFile: string; configurationFile: string; state: FixtureState }

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-configuration-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function fixture(directory: string): Promise<Fixture> {
  const extensionFile = path.join(directory, 'configured.mjs');
  const configurationFile = path.join(directory, 'extensions.json');
  await writeFile(extensionFile, `
    import { readFile } from 'node:fs/promises';
    import { defineExtension } from ${JSON.stringify(sdkUrl)};
    export const state = { applied: [], saved: [], cleaned: [] };
    export default defineExtension({ name: 'configured', async apply(ctx, config) {
      if (config === undefined) throw Error('SDK exposed undefined configuration');
      state.applied.push(structuredClone(config));
      const document = JSON.parse(await readFile(${JSON.stringify(configurationFile)}, 'utf8'));
      state.saved.push(document.entries.find(entry => entry.id === ctx.id));
      ctx.onCleanup(() => { state.cleaned.push(structuredClone(config)); });
      ctx.registerTool({
        name: 'configured', description: 'Read the applied offline configuration',
        parameters: { type: 'object' },
        async execute() { return { text: JSON.stringify(config) }; },
      });
      if (config && config.fail) throw Error('Deliberate configuration activation failure');
    } });
  `);
  const module = await import(pathToFileURL(extensionFile).href) as { state: FixtureState };
  return { extensionFile, configurationFile, state: module.state };
}
async function writeDocument(file: string, document: unknown): Promise<string> {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(file, text);
  return text;
}
async function document(file: string): Promise<Record<string, unknown> & { entries: Array<Record<string, Json>> }> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> & { entries: Array<Record<string, Json>> };
}
async function savedHost(file: string): Promise<ExtensionHost> {
  return new ExtensionHost({ ...await readExtensionConfiguration(file), receive });
}
function receipt(host: ExtensionHost, accepted: ChangeStatus): ChangeStatus {
  const result = host.changeStatus().find(item => item.id === accepted.id);
  assert.ok(result, `Expected receipt ${accepted.id}`);
  return result;
}
function named(tools: RegisteredTool[]): RegisteredTool {
  assert.equal(tools.length, 1);
  const registered = tools[0]!;
  assert.equal(registered.tool.name, 'configured');
  return registered;
}
async function configured(tools: RegisteredTool[]): Promise<Json> {
  return JSON.parse((await named(tools).tool.execute(null, execution)).text) as Json;
}
async function assertNoTemporaryFiles(directory: string): Promise<void> {
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.extensions.json.') && name.endsWith('.tmp')), []);
}

// Independent trusted fixtures use only temporary ordinary files and Cordis.
// No Pi provider, network, PostgreSQL, or user workspace is involved.
test('enable, configure, and disable save the same ordinary JSON before apply and survive fresh hosts', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    const unrelatedEntry = { id: 'untouched', path: entry.extensionFile, enabled: false, config: { keep: ['this'] }, note: 'manual entry metadata' };
    const initial = {
      entries: [
        { id: 'configured', path: entry.extensionFile, enabled: false, config: { label: 'initial' }, note: 'keep this field' },
        unrelatedEntry,
      ],
      hmr: false,
      operator: { comment: 'Hand maintained configuration', flags: [true, null, 3] },
    };
    const original = await writeDocument(entry.configurationFile, initial);
    const loaded = await readExtensionConfiguration(entry.configurationFile);
    assert.equal(loaded.configurationFile, await realpath(entry.configurationFile));
    assert.deepEqual(Object.keys(loaded).sort(), ['configurationFile', 'entries', 'hmr']);
    assert.deepEqual(loaded.entries, initial.entries);
    assert.equal(loaded.hmr, false);
    const host = new ExtensionHost({ ...loaded, receive });
    try {
      await host.start();
      assert.deepEqual(await host.prepare(), []);
      const enable = host.requestChange('configured', { action: 'enable' });
      assert.equal(enable.status, 'accepted');
      assert.equal(enable.persistence, 'pending');
      assert.equal(await readFile(entry.configurationFile, 'utf8'), original);
      assert.deepEqual(entry.state.applied, []);
      assert.deepEqual(await configured(await host.prepare()), { label: 'initial' });
      assert.equal(receipt(host, enable).status, 'applied');
      assert.equal(receipt(host, enable).persistence, 'saved');
      assert.deepEqual(entry.state.saved[0], { ...initial.entries[0], enabled: true });

      const next = { label: 'updated', nested: [null, false, 0, ''] };
      const configure = host.requestChange('configured', { action: 'configure', config: next });
      next.label = 'mutated-after-request';
      assert.equal(configure.persistence, 'pending');
      assert.deepEqual((await document(entry.configurationFile)).entries[0]!['config'], { label: 'initial' });
      await host.finish();
      const expected = { label: 'updated', nested: [null, false, 0, ''] };
      assert.deepEqual(await configured(await host.prepare()), expected);
      assert.equal(receipt(host, configure).status, 'applied');
      assert.equal(receipt(host, configure).persistence, 'saved');
      assert.deepEqual(entry.state.saved.at(-1), { ...initial.entries[0], enabled: true, config: expected });

      const disable = host.requestChange('configured', { action: 'disable' });
      assert.equal(disable.persistence, 'pending');
      assert.equal((await document(entry.configurationFile)).entries[0]!['enabled'], true);
      await host.finish();
      assert.equal(receipt(host, disable).status, 'applied');
      assert.equal(receipt(host, disable).persistence, 'saved');
      assert.deepEqual(host.inspect().map(item => item.status), ['disabled', 'disabled']);
      assert.deepEqual(await host.prepare(), []);
      const saved = await document(entry.configurationFile);
      assert.deepEqual(saved, { ...initial, entries: [{ ...initial.entries[0], config: expected }, unrelatedEntry] });
      assert.deepEqual(entry.state.cleaned, [{ label: 'initial' }, expected]);
      assert.equal(enable.status, 'accepted', 'accepted receipts are detached snapshots');
      assert.equal(enable.persistence, 'pending');
      await assertNoTemporaryFiles(directory);
    } finally { await host.close(); }

    const restarted = await savedHost(entry.configurationFile);
    try {
      await restarted.start();
      assert.deepEqual(await restarted.prepare(), []);
      assert.deepEqual(restarted.inspect().map(item => item.status), ['disabled', 'disabled']);
      assert.deepEqual(restarted.changeStatus(), [], 'runtime receipts are not database/configuration history');
      const enable = restarted.requestChange('configured', { action: 'enable' });
      assert.deepEqual(await configured(await restarted.prepare()), { label: 'updated', nested: [null, false, 0, ''] });
      assert.equal(receipt(restarted, enable).persistence, 'saved');
    } finally { await restarted.close(); }

    const enabledRestart = await savedHost(entry.configurationFile);
    try {
      await enabledRestart.start();
      assert.deepEqual(await configured(await enabledRestart.prepare()), { label: 'updated', nested: [null, false, 0, ''] });
      assert.deepEqual(enabledRestart.inspect().map(item => item.status), ['active', 'disabled']);
    } finally { await enabledRestart.close(); }
    await assertNoTemporaryFiles(directory);
  });
});

test('failed activation leaves saved desired configuration for restart and never claims rollback', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    await writeDocument(entry.configurationFile, { entries: [{ id: 'configured', path: entry.extensionFile, config: { label: 'working' } }], comment: 'preserved' });
    const host = await savedHost(entry.configurationFile);
    const failing = { label: 'saved-but-failing', fail: true };
    try {
      await host.start();
      assert.deepEqual(await configured(await host.prepare()), { label: 'working' });
      const change = host.requestChange('configured', { action: 'configure', config: failing });
      assert.deepEqual(await host.prepare(), []);
      assert.equal(receipt(host, change).status, 'failed');
      assert.equal(receipt(host, change).persistence, 'saved');
      assert.match(receipt(host, change).error ?? '', /Deliberate configuration activation failure/);
      assert.equal(host.inspect()[0]!.status, 'failed');
      assert.deepEqual(host.inspect()[0]!.tools, []);
      assert.deepEqual((await document(entry.configurationFile)).entries[0]!['config'], failing);
      assert.deepEqual(entry.state.saved.at(-1), { id: 'configured', path: entry.extensionFile, config: failing });
      assert.deepEqual(entry.state.cleaned, [{ label: 'working' }, failing]);
      await assertNoTemporaryFiles(directory);
    } finally { await host.close(); }

    const restarted = await savedHost(entry.configurationFile);
    try {
      await restarted.start();
      assert.deepEqual(await restarted.prepare(), []);
      assert.equal(restarted.inspect()[0]!.status, 'failed');
      assert.deepEqual(entry.state.applied, [{ label: 'working' }, failing, failing]);
      assert.deepEqual((await document(entry.configurationFile)).entries[0]!['config'], failing);
    } finally { await restarted.close(); }
  });
});

test('observed external edits reject queued saves without changing active runtime or clobbering any bytes', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    const initialEntry = { id: 'configured', path: entry.extensionFile, config: { label: 'runtime-original' } };
    await writeDocument(entry.configurationFile, { entries: [initialEntry], comment: 'original' });
    const host = await savedHost(entry.configurationFile);
    try {
      await host.start();
      const originalTool = named(await host.prepare());
      const originalStatus = host.inspect();
      const external = `${JSON.stringify({ entries: [{ ...initialEntry, config: { label: 'external-edit' } }], comment: 'edited outside the host' })}\n\n`;
      await writeFile(entry.configurationFile, external);
      for (const change of [{ action: 'configure', config: { label: 'must-not-apply' } }, { action: 'disable' }, { action: 'enable' }] as const) {
        const accepted = host.requestChange('configured', change);
        assert.equal(accepted.persistence, 'pending');
        const current = named(await host.prepare());
        assert.equal(receipt(host, accepted).status, 'failed');
        assert.equal(receipt(host, accepted).persistence, 'failed');
        assert.match(receipt(host, accepted).error ?? '', /changed externally/);
        assert.equal(current.activation, originalTool.activation);
        assert.deepEqual(host.inspect(), originalStatus);
        assert.deepEqual(await configured([current]), { label: 'runtime-original' });
        assert.equal(await readFile(entry.configurationFile, 'utf8'), external);
        assert.deepEqual(entry.state.applied, [{ label: 'runtime-original' }]);
        assert.deepEqual(entry.state.cleaned, []);
        await assertNoTemporaryFiles(directory);
      }
    } finally { await host.close(); }
    const restarted = await savedHost(entry.configurationFile);
    try {
      await restarted.start();
      assert.deepEqual(await configured(await restarted.prepare()), { label: 'external-edit' });
    } finally { await restarted.close(); }
  });
});

test('changed configuration between read and start is rejected before activating any extension', async () => {
  for (const mismatch of ['entries', 'hmr'] as const) await withDirectory(async directory => {
    const entry = await fixture(directory);
    const original = { entries: [{ id: 'configured', path: entry.extensionFile, config: { label: 'read' } }], hmr: false };
    await writeDocument(entry.configurationFile, original);
    const loaded = await readExtensionConfiguration(entry.configurationFile);
    const external = await writeDocument(entry.configurationFile, mismatch === 'hmr'
      ? { ...original, hmr: true }
      : { ...original, entries: [{ ...original.entries[0], config: { label: 'changed-before-start' } }] });
    const host = new ExtensionHost({ ...loaded, receive });
    try {
      await assert.rejects(host.start(), /changed since it was loaded/);
      assert.deepEqual(entry.state.applied, []);
      assert.equal(await readFile(entry.configurationFile, 'utf8'), external);
      await assertNoTemporaryFiles(directory);
    } finally { await host.close(); }
  });
});

test('filesystem failure after preparing a save removes its temporary file and leaves runtime untouched', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    const original = await writeDocument(entry.configurationFile, { entries: [{ id: 'configured', path: entry.extensionFile, config: { label: 'still-running' } }] });
    const host = await savedHost(entry.configurationFile);
    try {
      await host.start();
      const originalTool = named(await host.prepare());
      const originalStatus = host.inspect();
      // A directory replacement makes the expected-content read fail only after
      // the writer has created, written, and synced its sibling temporary file.
      const backup = path.join(directory, 'external-backup.json');
      await rename(entry.configurationFile, backup);
      await mkdir(entry.configurationFile);
      const accepted = host.requestChange('configured', { action: 'disable' });
      const current = named(await host.prepare());
      assert.equal(receipt(host, accepted).status, 'failed');
      assert.equal(receipt(host, accepted).persistence, 'failed');
      assert.ok(receipt(host, accepted).error);
      assert.equal(current.activation, originalTool.activation);
      assert.deepEqual(await configured([current]), { label: 'still-running' });
      assert.deepEqual(host.inspect(), originalStatus);
      assert.deepEqual(entry.state.applied, [{ label: 'still-running' }]);
      assert.deepEqual(entry.state.cleaned, []);
      assert.equal((await stat(entry.configurationFile)).isDirectory(), true);
      assert.equal(await readFile(backup, 'utf8'), original);
      await assertNoTemporaryFiles(directory);
    } finally { await host.close(); }
  });
});

test('queued configuration changes while disabled save in order without activating until enabled', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    await writeDocument(entry.configurationFile, { entries: [{ id: 'configured', path: entry.extensionFile, enabled: false, config: { label: 'initial' } }] });
    const host = await savedHost(entry.configurationFile);
    const finalConfig = { label: 'configured-while-disabled', nested: { keep: true } };
    try {
      await host.start();
      const first = host.requestChange('configured', { action: 'configure', config: { label: 'first-queued' } });
      const second = host.requestChange('configured', { action: 'configure', config: finalConfig });
      assert.deepEqual(await host.prepare(), []);
      for (const change of [first, second]) {
        assert.equal(receipt(host, change).status, 'applied');
        assert.equal(receipt(host, change).persistence, 'saved');
      }
      assert.deepEqual(entry.state.applied, []);
      assert.equal(host.inspect()[0]!.status, 'disabled');
      assert.deepEqual((await document(entry.configurationFile)).entries[0]!['config'], finalConfig);
    } finally { await host.close(); }
    const restarted = await savedHost(entry.configurationFile);
    try {
      await restarted.start();
      assert.deepEqual(await restarted.prepare(), []);
      const enable = restarted.requestChange('configured', { action: 'enable' });
      assert.deepEqual(await configured(await restarted.prepare()), finalConfig);
      assert.equal(receipt(restarted, enable).persistence, 'saved');
      assert.deepEqual(entry.state.applied, [finalConfig]);
    } finally { await restarted.close(); }
    await assertNoTemporaryFiles(directory);
  });
});

test('start adopts unrelated manual keys changed after read without discarding them on the next save', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    const entries = [{ id: 'configured', path: entry.extensionFile, config: { label: 'same-entry' } }];
    await writeDocument(entry.configurationFile, { entries });
    const loaded = await readExtensionConfiguration(entry.configurationFile);
    assert.equal(Object.hasOwn(loaded, 'hmr'), false);
    const metadata = { comments: ['Added between read and start'], unknown: { keep: true } };
    await writeDocument(entry.configurationFile, { entries, ...metadata });
    const host = new ExtensionHost({ ...loaded, receive });
    try {
      await host.start();
      const change = host.requestChange('configured', { action: 'disable' });
      await host.finish();
      assert.equal(receipt(host, change).persistence, 'saved');
      assert.deepEqual(await document(entry.configurationFile), { entries: [{ ...entries[0], enabled: false }], ...metadata });
    } finally { await host.close(); }
  });
});

test('restart is runtime-only even with a saved configuration and does not rewrite the file', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    const original = await writeDocument(entry.configurationFile, { entries: [{ id: 'configured', path: entry.extensionFile, config: { label: 'reload' } }] });
    const host = await savedHost(entry.configurationFile);
    try {
      await host.start();
      const before = named(await host.prepare());
      const change = host.requestChange('configured', { action: 'reload' });
      assert.equal(change.persistence, 'not-required');
      const after = named(await host.prepare());
      assert.notEqual(after.activation, before.activation);
      assert.equal(receipt(host, change).status, 'applied');
      assert.equal(receipt(host, change).persistence, 'not-required');
      assert.equal(await readFile(entry.configurationFile, 'utf8'), original);
      await assertNoTemporaryFiles(directory);
    } finally { await host.close(); }
  });
});

test('programmatic hosts remain ephemeral and never infer a configuration file', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    const entries = [{ id: 'configured', path: entry.extensionFile, config: { label: 'on-disk' } }];
    const original = await writeDocument(entry.configurationFile, { entries });
    const host = new ExtensionHost({ entries, receive });
    try {
      await host.start();
      await host.prepare();
      const configure = host.requestChange('configured', { action: 'configure', config: { label: 'runtime-only' } });
      assert.equal(configure.persistence, 'not-required');
      assert.deepEqual(await configured(await host.prepare()), { label: 'runtime-only' });
      assert.equal(receipt(host, configure).status, 'applied');
      assert.equal(receipt(host, configure).persistence, 'not-required');
      const disable = host.requestChange('configured', { action: 'disable' });
      await host.finish();
      assert.equal(receipt(host, disable).persistence, 'not-required');
      assert.equal(await readFile(entry.configurationFile, 'utf8'), original);
      await assertNoTemporaryFiles(directory);
    } finally { await host.close(); }
    const restarted = new ExtensionHost({ entries, receive });
    try {
      await restarted.start();
      assert.deepEqual(await configured(await restarted.prepare()), { label: 'on-disk' });
    } finally { await restarted.close(); }
  });
});

test('omitted configuration is exposed as null and explicit null survives disable, enable, and restart', async () => {
  await withDirectory(async directory => {
    const entry = await fixture(directory);
    await writeDocument(entry.configurationFile, { entries: [{ id: 'configured', path: entry.extensionFile }] });
    const host = await savedHost(entry.configurationFile);
    try {
      await host.start();
      assert.equal(await configured(await host.prepare()), null);
      assert.deepEqual(entry.state.applied, [null]);
      assert.equal(Object.hasOwn((await document(entry.configurationFile)).entries[0]!, 'config'), false);
      assert.throws(() => {
        // @ts-expect-error A configure request must contain JSON, never undefined.
        host.requestChange('configured', { action: 'configure', config: undefined });
      }, /plain finite JSON/);
      assert.deepEqual(host.changeStatus(), []);
      const nullChange = host.requestChange('configured', { action: 'configure', config: null });
      assert.equal(await configured(await host.prepare()), null);
      assert.equal(receipt(host, nullChange).status, 'applied');
      assert.equal(receipt(host, nullChange).persistence, 'saved');
      assert.equal((await document(entry.configurationFile)).entries[0]!['config'], null);
      host.requestChange('configured', { action: 'disable' });
      assert.deepEqual(await host.prepare(), []);
      host.requestChange('configured', { action: 'enable' });
      assert.equal(await configured(await host.prepare()), null);
      assert.ok(entry.state.applied.every(value => value === null));
    } finally { await host.close(); }
    const restarted = await savedHost(entry.configurationFile);
    try {
      await restarted.start();
      assert.equal(await configured(await restarted.prepare()), null);
      assert.equal(entry.state.applied.at(-1), null);
      assert.equal((await document(entry.configurationFile)).entries[0]!['config'], null);
    } finally { await restarted.close(); }
  });
});

test('SDK normalizes Cordis undefined to JSON null while preserving valid falsy JSON values', async () => {
  const applied: Json[] = [];
  const extension = defineExtension({ name: 'config-contract', apply(_context, config: Json) { applied.push(config); } });
  const environment = { mira: {} as ExtensionContext };
  await extension.apply(environment, undefined as unknown as Json);
  for (const value of [null, false, 0, '', [], {}] as Json[]) await extension.apply(environment, value);
  assert.deepEqual(applied, [null, null, false, 0, '', [], {}]);
});

test('configuration reader rejects malformed ordinary JSON documents without rewriting them', async () => {
  await withDirectory(async directory => {
    const file = path.join(directory, 'extensions.json');
    for (const text of ['{', 'null', '[]', '{}', '{"entries":{}}', '{"entries":[],"hmr":"yes"}', '{"entries":[{"id":"configured","path":"/tmp/code.mjs","enabled":"false"}]}']) {
      await writeFile(file, text);
      await assert.rejects(readExtensionConfiguration(file));
      assert.equal(await readFile(file, 'utf8'), text);
      await assertNoTemporaryFiles(directory);
    }
  });
});
