import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '@mira/extension-host';
import { parseConfig } from '../../packages/mcp-plugin/src/config.ts';
import { resultProjection } from '../../packages/mcp-plugin/src/client.ts';
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
  const entries = ['one', 'two'].map(id => ({ id, path: plugin, config: { transport: 'stdio', command: process.execPath, argsJson: JSON.stringify([fixture, protocol, marker]), toolsJson: JSON.stringify(id === 'one' ? ['echo', 'child'] : ['known_error']), protocol } }));
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
  try {
    await host.start();
    const prepared = await host.prepare();
    assert.equal((await host.extensionSettings('one'))?.status.state, 'connected');
    assert.equal((await host.extensionSettings('two'))?.status.state, 'connected');
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 2, 'one process per instance, no disposable probe launches');
    const echo = prepared.find(item => item.tool.name === 'echo')!.tool;
    assert.equal((await echo.execute({ text: 'hello' }, { callId: 'a', signal: signal() })).text, 'hello\n{"text":"hello"}');
    const known = prepared.find(item => item.tool.name === 'known_error')!.tool;
    assert.equal((await known.execute({}, { callId: 'b', signal: signal() })).isError, true);
    const child = prepared.find(item => item.tool.name === 'child')!.tool;
    const pid = Number((await child.execute({}, { callId: 'c', signal: signal() })).text);
    assert.ok(pid > 1); process.kill(pid, 0);
    const disabled = await host.requestChange('one', { action: 'disable' }); assert.equal(disabled.status, 'applied', disabled.error);
    assert.equal((await echo.execute({}, { callId: 'stale', signal: signal() })).isError, true);
    assert.ok((await host.prepare()).some(item => item.tool.name === 'known_error'));
    assert.ok(!(await host.prepare()).some(item => item.tool.name === 'echo'));
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

test('real MCP installations reject actual duplicate names without redirecting the first instance', { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-duplicate-')));
  const entries = ['first', 'second'].map(id => ({ id, path: plugin, config: { command: process.execPath,
    argsJson: JSON.stringify([fixture, 'legacy']), toolsJson: '["echo"]' } }));
  const configurationFile = path.join(root, 'extensions.json');
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
  try {
    await host.start();
    const tools = await host.prepare();
    assert.equal(tools.length, 1); assert.equal(tools[0]!.tool.name, 'echo');
    const owner = tools[0]!.extensionId;
    const rejected = owner === 'first' ? 'second' : 'first';
    assert.equal((await host.extensionSettings(owner))?.status.state, 'connected');
    const status = (await host.extensionSettings(rejected))!.status;
    assert.equal(status.state, 'error'); assert.equal(status.code, 'name_conflict');
    assert.match(status.details![0]!.value, /Duplicate tool name/);
    assert.equal((await tools[0]!.tool.execute({ text: 'original' }, { callId: 'original', signal: signal() })).text, 'original\n{"text":"original"}');
    await host.requestChange(owner, { action: 'disable' });
    const retry = (await host.extensionSettings(rejected))!;
    await host.startSettingsAction(rejected, 'connect', retry.revision);
    for (let attempt = 0; attempt < 200 && (await host.extensionSettings(rejected))?.operation?.state === 'pending'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await host.extensionSettings(rejected))?.status.state, 'connected');
    assert.equal((await host.prepare())[0]!.extensionId, rejected);
    assert.equal((await tools[0]!.tool.execute({ text: 'old' }, { callId: 'old', signal: signal() })).isError, true);
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
