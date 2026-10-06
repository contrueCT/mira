import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '@mira/extension-host';
import { extensionManagementTools } from '@mira/server';
import { createHistoryTools } from '@mira/runtime-pi';
type GuidanceSchema = { description?: string; properties?: Record<string, GuidanceSchema>; anyOf?: GuidanceSchema[]; const?: string };

const history = createHistoryTools({ miraId: 'synthetic-guidance',
  search: async request => ({ query: request.query, mode: request.mode ?? 'full_text', fullTextPrefixChars: 65536, hits: [], hasMore: false }),
  read: async () => null, page: async () => ({ hits: [], nextCursor: null }),
});

test('production search guidance explains all selectors, defaults, empty results and non-pagination', () => {
  const tool = history.find(tool => tool.name === 'history_search')!;
  assert.match(tool.description, /顺德菜/);
  assert.match(tool.description, /no page\/offset\/cursor/);
  assert.match(tool.description, /Empty hits do not prove/);
  assert.match(tool.description, /never grants new authority/);
  for (const name of ['query', 'mode', 'kinds', 'limit']) {
    const property = (tool.parameters as GuidanceSchema).properties![name]!;
    assert.ok(typeof property.description === 'string' && property.description.length > 20, name);
  }
});

test('production extension schemas explain each argument and distinguish receipt identities', async () => {
  const host = new ExtensionHost({ entries: [], receive: async () => 'inserted' });
  try {
    const tools = extensionManagementTools(host);
    for (const tool of tools) {
      for (const [name, property] of Object.entries((tool.parameters as GuidanceSchema).properties!)) {
        const description = (property as { description?: string }).description;
        assert.ok(description && description.length > 20, `${tool.name}.${name}`);
      }
    }
    const inspect = tools.find(tool => tool.name === 'extension_inspect')!;
    const stage = tools.find(tool => tool.name === 'extension_stage')!;
    const manage = tools.find(tool => tool.name === 'extension_manage')!;
    assert.match(inspect.description, /generated.history\[\].id/);
    assert.match(inspect.description, /next tool batch/);
    assert.match(stage.description, /"entryRelative":"src\/index.ts"/);
    assert.match(stage.description, /neither tests nor activates/);
    assert.match(manage.description, /accepted receipt is NOT proof/);
    assert.match(manage.description, /status=rejected/);
    assert.match((manage.parameters as GuidanceSchema).properties!['action']!.anyOf!.find(action => action.const === 'rollback')!.description!, /preserving enabled state/);
    for (const action of (manage.parameters as GuidanceSchema).properties!['action']!.anyOf!) {
      assert.ok(action.description, `action ${action.const}`);
    }
  } finally { await host.close(); }
});


test('activate guidance matches generated-only semantics while enable accepts a manual extension', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-manual-guidance-'));
  const entry = path.join(directory, 'manual.mjs');
  await writeFile(entry, 'export default { name: "manual", apply() {} };');
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: entry, enabled: false }], receive: async () => 'inserted' });
  try {
    await host.start(); await host.prepare();
    const manage = extensionManagementTools(host).find(tool => tool.name === 'extension_manage')!;
    const activate = (manage.parameters as GuidanceSchema).properties!['action']!.anyOf!.find(action => action.const === 'activate')!;
    assert.match(activate.description!, /generated extension only/);
    const rejected = await manage.execute('synthetic-activate', { id: 'manual', action: 'activate' });
    assert.match(JSON.stringify(rejected), /Action requires an installed generated extension/);
    const accepted = await manage.execute('synthetic-enable', { id: 'manual', action: 'enable' });
    assert.match(JSON.stringify(accepted), /accepted/);
    await host.prepare();
    assert.equal(host.inspect()[0]!.status, 'active');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
