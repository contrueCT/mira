import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '@mira/extension-host';
import { parseConfig } from '../../packages/mcp-plugin/src/config.ts';
import { resultProjection, toolName } from '../../packages/mcp-plugin/src/client.ts';
const plugin = path.resolve('packages/mcp-plugin/src/index.ts');
const fixture = path.resolve('tests/fixtures/mcp/server.mts');
const signal = () => new AbortController().signal;

test('MCP config validates transport, explicit local version, names and output projection', () => {
  assert.equal(parseConfig({ transport: 'stdio', command: process.execPath }).protocol, 'legacy');
  assert.equal(parseConfig({ transport: 'http', url: 'https://example.org/mcp' }).protocol, 'auto');
  assert.throws(() => parseConfig({ command: process.execPath, protocol: 'auto' }));
  assert.throws(() => parseConfig({ command: '/usr/bin/npx', argsJson: '["server@latest"]' }));
  assert.throws(() => parseConfig({ transport: 'http', url: 'http://example.org/mcp' }));
  assert.throws(() => parseConfig({ command: process.execPath, envSecrets: { NODE_OPTIONS: 'inject' } }));
  const name = toolName('long-installation'.repeat(10), 'same/name'.repeat(20));
  assert.match(name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  assert.notEqual(toolName('a', 'x/y'), toolName('a', 'x_y'));
  assert.notEqual(toolName('a', 'x'), toolName('b', 'x'));
  assert.equal(resultProjection({ content: [{ type: 'text', text: 'no' }], isError: true }).isError, true);
  for (const structuredContent of [0, false, null, '']) {
    const result = resultProjection({ content: [], structuredContent });
    assert.equal(result.text, JSON.stringify(structuredContent));
    assert.deepEqual(result.details, { structuredContent });
    assert.equal(result.isError, false);
  }
  assert.equal(resultProjection({ content: [{ type: 'text', text: '{"value":1}' }], structuredContent: { value: 1 } }).text, '{"value":1}');
  const unsupported = resultProjection({ content: [{ type: 'image', mimeType: 'image/png', data: 'hidden' }] });
  assert.equal(unsupported.isError, true); assert.match(unsupported.text, /not delivered/); assert.ok(!JSON.stringify(unsupported).includes('hidden'));
});
for (const protocol of ['legacy', '2026-07-28']) test(`real official SDK ${protocol} stdio connects once, isolates instances and cleans owned descendants`, { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-')));
  const marker = path.join(root, 'starts.txt');
  const configurationFile = path.join(root, 'extensions.json');
  const entries = ['one', 'two'].map(id => ({ id, path: plugin, config: { transport: 'stdio', command: process.execPath, argsJson: JSON.stringify([fixture, protocol, marker]), protocol } }));
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
  try {
    await host.start();
    const prepared = await host.prepare();
    assert.equal((await host.extensionSettings('one'))?.status.state, 'connected');
    assert.equal((await host.extensionSettings('two'))?.status.state, 'connected');
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2, 'one process per instance, no disposable probe launches');
    const echo = prepared.find(item => item.tool.name === toolName('one', 'echo'))!.tool;
    assert.equal((await echo.execute({ text: 'hello' }, { callId: 'a', signal: signal() })).text, 'hello\n{"text":"hello"}');
    const known = prepared.find(item => item.tool.name === toolName('one', 'known_error'))!.tool;
    assert.equal((await known.execute({}, { callId: 'b', signal: signal() })).isError, true);
    const child = prepared.find(item => item.tool.name === toolName('one', 'child'))!.tool;
    const pid = Number((await child.execute({}, { callId: 'c', signal: signal() })).text);
    assert.ok(pid > 1); process.kill(pid, 0);
    const disabled = await host.requestChange('one', { action: 'disable' }); assert.equal(disabled.status, 'applied', disabled.error);
    assert.equal((await echo.execute({}, { callId: 'stale', signal: signal() })).isError, true);
    assert.ok((await host.prepare()).some(item => item.tool.name === toolName('two', 'echo')));
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Linux containers can retain a reparented dead zombie briefly; /proc state
    // distinguishes a killed process from a live leaked descendant.
    if (process.platform === 'linux') {
      try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.match(stat, /\) Z /); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } else assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
