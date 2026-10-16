import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ExtensionHost } from '@mira/extension-host';
import { extensionManagementTools } from '@mira/server';

type Operation = { id: string; action: string; state: 'pending' | 'succeeded' | 'failed' | 'cancelled' };
type Receipt = { operation?: Operation | null; status?: string; error?: string };
type SettingsMetadata = { revision: string; actions: string[] };
type Inspection = { extensions: Array<{ id: string; status: string; config: unknown; settings: SettingsMetadata | null }> };
type FixtureState = {
  starts: number;
  cleanups: number;
  visibleActions: string[];
  handles: Array<{ start(action: string): Promise<Operation>; current(): Promise<Operation | null> }>;
};
const sdk = import.meta.resolve('@mira/extension-sdk');
const privateError = 'synthetic-private-settings-failure';
const settingsOnly = ['synthetic-field-label', 'synthetic-action-label', 'synthetic-status-detail', 'https://auth.example.invalid/authorize?state=synthetic-oauth-state'];

async function call<T>(tool: AgentTool, args: Record<string, unknown>): Promise<T> {
  const result = await tool.execute('synthetic-settings-management', args);
  assert.equal(result.details, null);
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return JSON.parse((content as { text: string }).text) as T;
}
async function fixture(run: (host: ExtensionHost, state: FixtureState, manage: AgentTool, inspect: AgentTool) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mira-settings-management-'));
  const file = path.join(directory, 'ordinary-extension.mjs');
  const plain = path.join(directory, 'plain-extension.mjs');
  await writeFile(file, `import { defineExtension } from ${JSON.stringify(sdk)};
    export const state = { starts: 0, cleanups: 0, visibleActions: ['synchronize', 'complete', 'fail'], handles: [] };
    export default defineExtension({ name: 'ordinary-service', async apply(ctx) {
      await ctx.credentials.set('token', 'synthetic-private-token');
      const handle = ctx.registerSettings({
        fields: [{ key: 'account', label: 'synthetic-field-label', type: 'text' }, { key: 'token', label: 'Token', type: 'secret' }],
        actions: [
          { id: 'synchronize', label: 'synthetic-action-label', async execute({signal}) {
            state.starts++;
            await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
          } },
          { id: 'complete', label: 'Complete', async execute() { state.starts++; } },
          { id: 'fail', label: 'Fail', async execute() { state.starts++; throw Error(${JSON.stringify(privateError)}); } },
          { id: 'hidden', label: 'Hidden', async execute() { state.starts++; } },
        ],
        status: () => ({ state: 'pending', visibleActions: state.visibleActions,
          details: [{ label: 'Provider', value: 'synthetic-status-detail' }],
          authorization: { url: ${JSON.stringify(settingsOnly[3])}, label: 'Open authorization', qr: true } }),
      });
      state.handles.push(handle);
      ctx.onCleanup(() => { state.cleanups++; });
    }});`);
  await writeFile(plain, 'export default { name: "plain", apply() {} };');
  const { state } = await import(pathToFileURL(file).href) as { state: FixtureState };
  const entries = [{ id: 'ordinary', path: file, config: { account: 'ordinary-public-config' } }, { id: 'plain', path: plain }];
  const configurationFile = path.join(directory, 'extensions.json');
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
  const tools = extensionManagementTools(host);
  try {
    await host.start();
    assert.deepEqual(tools.map(tool => tool.name), ['extension_inspect', 'extension_stage', 'extension_manage']);
    assert.deepEqual(host.inspect().find(entry => entry.id === 'ordinary')?.tools, []);
    await run(host, state, tools.find(tool => tool.name === 'extension_manage')!, tools.find(tool => tool.name === 'extension_inspect')!);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
}
async function settings(inspect: AgentTool): Promise<SettingsMetadata> {
  const view = await call<Inspection>(inspect, {});
  const metadata = view.extensions.find(entry => entry.id === 'ordinary')?.settings;
  assert.ok(metadata);
  return metadata;
}
function assertSafe(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of [...settingsOnly, privateError, 'synthetic-private-token']) assert.ok(!text.includes(forbidden), forbidden);
}

test('existing inspect exposes only revision and available action IDs for any ordinary extension', async () => {
  await fixture(async (host, _state, manage, inspect) => {
    const view = await call<Inspection>(inspect, {});
    const ordinary = view.extensions.find(entry => entry.id === 'ordinary')!;
    assert.deepEqual(ordinary.settings, { revision: (await host.extensionSettings('ordinary'))!.revision, actions: ['synchronize', 'complete', 'fail'] });
    assert.deepEqual(ordinary.config, { account: 'ordinary-public-config' }, 'existing lifecycle inspection remains unchanged');
    assert.equal(view.extensions.find(entry => entry.id === 'plain')!.settings, null);
    assertSafe(view);
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), { operation: null });
    const rejected = await call<Receipt>(manage, { id: 'plain', action: 'settings-start', actionId: 'synchronize', expectedRevision: ordinary.settings!.revision });
    assert.equal(rejected.status, 'rejected');
    assertSafe(rejected);
  });
});

test('generic settings start, current and exact cancellation share the single-flight runner', async () => {
  await fixture(async (_host, state, manage, inspect) => {
    const metadata = await settings(inspect);
    const started = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: metadata.revision });
    assert.ok(started.operation);
    assert.deepEqual(Object.keys(started), ['operation']);
    assert.deepEqual(Object.keys(started.operation), ['id', 'action', 'state']);
    assert.equal(started.operation.action, 'synchronize');
    assert.equal(started.operation.state, 'pending');
    assert.equal(state.starts, 1);
    assertSafe(started);
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), started);
    const concurrent = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: (await settings(inspect)).revision });
    assert.equal(concurrent.status, 'rejected');
    assert.equal(state.starts, 1);
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'settings-cancel', operationId: 'wrong-operation' })).status, 'rejected');
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), started);
    const cancelled = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-cancel', operationId: started.operation.id });
    assert.equal(cancelled.operation?.id, started.operation.id);
    assert.ok(['pending', 'cancelled'].includes(cancelled.operation!.state));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), { operation: { ...started.operation, state: 'cancelled' } });
    for (const [actionId, expectedState] of [['complete', 'succeeded'], ['fail', 'failed']]) {
      const receipt = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId, expectedRevision: (await settings(inspect)).revision });
      await new Promise(resolve => setImmediate(resolve));
      const current = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-current' });
      assert.equal(current.operation?.id, receipt.operation?.id);
      assert.equal(current.operation?.state, expectedState);
      assertSafe(receipt); assertSafe(current);
    }
    assert.equal(state.starts, 3);
  });
});

test('settings revisions and operation identities fence changed visibility and retired activations', async () => {
  await fixture(async (host, state, manage, inspect) => {
    const before = await settings(inspect);
    state.visibleActions = ['complete'];
    const stale = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: before.revision });
    assert.equal(stale.status, 'rejected');
    const hidden = await settings(inspect);
    assert.deepEqual(hidden.actions, ['complete']);
    assert.notEqual(hidden.revision, before.revision);
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: hidden.revision })).status, 'rejected');
    assert.equal(state.starts, 0);
    state.visibleActions = ['synchronize', 'complete', 'fail'];
    const first = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: (await settings(inspect)).revision });
    const oldHandle = state.handles[0]!;
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'reload' })).status, 'applied');
    assert.equal(state.cleanups, 1);
    await assert.rejects(() => oldHandle.start('synchronize'));
    await assert.rejects(() => oldHandle.current());
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: before.revision })).status, 'rejected');
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), { operation: null });
    const second = await call<Receipt>(manage, { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: (await settings(inspect)).revision });
    assert.notEqual(second.operation?.id, first.operation?.id);
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'settings-cancel', operationId: first.operation!.id })).status, 'rejected');
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), second);
    assert.equal(state.starts, 2);
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'disable' })).status, 'applied');
    assert.equal((await call<Inspection>(inspect, {})).extensions.find(entry => entry.id === 'ordinary')?.settings, null);
    assert.deepEqual(await call(manage, { id: 'ordinary', action: 'settings-current' }), { operation: null });
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'enable' })).status, 'applied');
    assert.equal(host.inspect().find(entry => entry.id === 'ordinary')?.status, 'active');
    const configure = await call<Receipt>(manage, { id: 'ordinary', action: 'configure', config: { account: 'replacement-public-config' } });
    assert.equal(configure.status, 'applied');
    assert.deepEqual(host.inspect().find(entry => entry.id === 'ordinary')?.config, { account: 'replacement-public-config' });
    assert.equal((await call<Receipt>(manage, { id: 'ordinary', action: 'remove' })).status, 'applied');
    assert.ok(!host.inspect().some(entry => entry.id === 'ordinary'));
  });
});

test('settings management never forwards view fields, extra operation fields or raw errors', async () => {
  await fixture(async (host, _state, manage, inspect) => {
    const metadata = await settings(inspect);
    const realView = host.extensionSettings.bind(host);
    const view = (await realView('ordinary'))!;
    const operation = { id: 'synthetic-operation', action: 'synchronize', state: 'pending' as const, private: privateError };
    host.extensionSettings = async () => ({ ...view, operation });
    host.startSettingsAction = async () => ({ ...view, operation });
    host.cancelSettingsAction = async () => {};
    for (const args of [
      { id: 'ordinary', action: 'settings-current' },
      { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: metadata.revision },
      { id: 'ordinary', action: 'settings-cancel', operationId: operation.id },
    ]) {
      const receipt = await call(manage, args);
      assert.deepEqual(receipt, { operation: { id: operation.id, action: operation.action, state: operation.state } });
      assertSafe(receipt);
    }
    assertSafe(await call(inspect, {}));
    const throwPrivate = async (): Promise<never> => { throw new Error(privateError); };
    host.extensionSettings = throwPrivate;
    host.startSettingsAction = throwPrivate;
    host.cancelSettingsAction = throwPrivate;
    const unavailable = await call<Inspection>(inspect, {});
    assert.ok(unavailable.extensions.every(entry => entry.settings === null));
    assertSafe(unavailable);
    for (const args of [
      { id: 'ordinary', action: 'settings-current' },
      { id: 'ordinary', action: 'settings-start', actionId: 'synchronize', expectedRevision: metadata.revision },
      { id: 'ordinary', action: 'settings-cancel', operationId: operation.id },
      { id: 'ordinary', action: 'settings-start' },
      { id: 'ordinary', action: 'settings-cancel' },
    ]) {
      const receipt = await call<Receipt>(manage, args);
      assert.equal(receipt.status, 'rejected');
      assert.equal(receipt.error, 'Extension settings request could not be confirmed. Inspect current state before retrying. Raw diagnostics are hidden.');
      assertSafe(receipt);
    }
  });
});
