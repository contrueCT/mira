import assert from 'node:assert/strict';
import test from 'node:test';
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
    for (const action of (manage.parameters as GuidanceSchema).properties!['action']!.anyOf!) {
      assert.ok(action.description, `action ${action.const}`);
    }
  } finally { await host.close(); }
});
