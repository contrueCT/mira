import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '@mira/extension-host';
import { toolName } from '../../packages/mcp-plugin/src/client.ts';
import { httpFixture } from '../fixtures/mcp/http.mts';
const plugin = path.resolve('packages/mcp-plugin/src/index.ts');
for (const protocol of ['legacy', '2026-07-28', 'auto']) test(`official SDK HTTP ${protocol} tools, refresh, known staleness and no effect retry`, { timeout: 30_000 }, async () => {
  const fixture = await httpFixture();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-http-')));
  const configurationFile = path.join(root, 'extensions.json');
  const entries = [{ id: 'remote', path: plugin, config: { transport: 'http', url: fixture.url, protocol } }];
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
  const execution = (callId: string) => ({ callId, signal: new AbortController().signal });
  try {
    await host.start(); assert.equal((await host.extensionSettings('remote'))?.status.state, 'connected');
    const old = (await host.prepare()).find(item => item.tool.name === toolName('remote', 'echo'))!;
    assert.match((await old.tool.execute({ text: 'hello' }, execution('echo'))).text, /hello/);
    if (protocol !== 'legacy') {
      const structured = (await host.prepare()).find(item => item.tool.name === toolName('remote', 'structured'))!;
      for (const value of [0, false, null, '']) {
        const result = await structured.tool.execute({ value }, execution(`structured-${String(value)}`));
        assert.equal(result.text, JSON.stringify(value));
        assert.deepEqual(result.details, { structuredContent: value });
        assert.equal(result.isError, false);
      }
    }
    fixture.change();
    if (protocol === 'legacy') { const settings = (await host.extensionSettings('remote'))!; await host.startSettingsAction('remote', 'refresh', settings.revision); }
    let next = old;
    for (let attempt = 0; attempt < 100; attempt++) {
      next = (await host.prepare()).find(item => item.tool.name === old.tool.name)!;
      if (next?.toolRevision !== old.toolRevision) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.notEqual(next.toolRevision, old.toolRevision);
    assert.deepEqual(next.tool.parameters.properties, { count: { type: 'number' } });
    assert.equal((await old.tool.execute({}, execution('stale'))).isError, true);
    for (const mode of ['unauthorized', 'header-mismatch', 'input-required', 'lost'] as const) {
      fixture.mode(mode); const before = fixture.calls.length;
      await assert.rejects(next.tool.execute({}, execution(mode)));
      assert.equal(fixture.calls.length, before + 1, `${mode} must not automatically replay tools/call`);
    }
  } finally { await host.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test('late MCP notifications during ownership-loss lifecycle drain do not strand client cleanup', { timeout: 10_000 }, async () => {
  const fixture = await httpFixture();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-retire-')));
  const blocker = path.join(root, 'blocker.mts');
  await writeFile(blocker, `export let entered=false,release; const gate=new Promise(resolve=>release=resolve); export default {name:'blocker',apply({mira:ctx}){ctx.onCleanup(async()=>{entered=true;await gate;});}};`);
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(blocker).href);
  const owner = new AbortController();
  const entries = [{ id: 'blocker', path: blocker }, { id: 'remote', path: plugin, config: { transport: 'http', url: fixture.url, protocol: '2026-07-28' } }];
  const configurationFile = path.join(root, 'extensions.json'); await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, ownerSignal: owner.signal, receive: async () => 'inserted' });
  try {
    await host.start(); assert.equal((await host.extensionSettings('remote'))?.status.state, 'connected');
    const retiring = host.requestChange('blocker', { action: 'disable' });
    for (let attempt = 0; attempt < 100 && !module.entered; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(module.entered, true);
    owner.abort(); fixture.change();
    // The lifecycle queue is deliberately held while the actual SDK receives
    // its list-change notification; Host publication is already fenced.
    await new Promise(resolve => setTimeout(resolve, 100));
    module.release(); await retiring; await host.close();
  } finally { module.release?.(); await host.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
