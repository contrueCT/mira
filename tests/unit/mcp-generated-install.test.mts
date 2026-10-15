import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, ExtensionHost, readExtensionConfiguration } from '@mira/extension-host';
import { prepareExtensionPackage } from '../../scripts/prepare-extension-package.mts';
const source = path.resolve(import.meta.dirname, '../../packages/mcp-plugin');

test('shipped MCP package follows real prepare, stage, content-test, install, activate and cleanup workflow', { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-install-')));
  let host: ExtensionHost | undefined;
  try {
    const workspace = await prepareExtensionPackage(source, path.join(root, 'workspace'));
    assert.ok(workspace.packages > 2, 'published SDK transitive runtime closure is included');
    const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
    const artifact = await artifacts.stage(workspace.directory, workspace.entryRelative);
    const checked = await artifacts.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', "const {default: plugin} = await import('./entry.mjs'); if (plugin.name !== 'mira-mcp-plugin') throw Error('wrong export');"] });
    assert.equal(checked.passed, true, checked.stderr); assert.equal(checked.unchanged, true);
    const config = path.join(root, 'extensions.json'); await writeFile(config, JSON.stringify({ entries: [], artifactsDirectory: artifacts.root }));
    host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive: async () => { assert.fail('unconfigured extension must not wake'); } });
    await host.start();
    const install = await host.requestChange('mcp', { action: 'install', digest: artifact.digest, config: { transport: 'stdio' } });
    assert.equal(install.status, 'applied'); assert.equal(install.test, 'passed'); assert.deepEqual(await host.prepare(), []);
    const activation = await host.requestChange('mcp', { action: 'activate' }); assert.equal(activation.status, 'applied', activation.error);
    const settings = await host.extensionSettings('mcp'); assert.ok(settings); assert.equal(settings.status.state, 'unconfigured');
    assert.equal(settings.fields.find(field => field.key === 'bearerToken')?.configured, false);
    const tools = await host.prepare(); assert.equal(tools.length, 1); assert.match(tools[0]!.tool.name, /^mcp_control_/);
    const status = tools[0]!;
    const operation = await status.tool.execute({ operation: 'current' }, { callId: 'status', signal: new AbortController().signal });
    assert.equal(operation.text, 'null');
    assert.ok(!JSON.stringify(await host.inspect()).includes('bearerToken'), 'private key is not extension configuration');
    await host.requestChange('mcp', { action: 'disable' }); assert.equal(await host.extensionSettings('mcp'), null); assert.deepEqual(await host.prepare(), []);
    const stale = await status.tool.execute({}, { callId: 'retired', signal: new AbortController().signal }); assert.equal((stale.details as { status: string }).status, 'stale');
    const persisted = await readExtensionConfiguration(config); assert.equal(persisted.entries[0]!.enabled, false);
    await host.close(); host = new ExtensionHost({ ...persisted, receive: async () => 'inserted' }); await host.start(); assert.deepEqual(await host.prepare(), []);
    await host.requestChange('mcp', { action: 'enable' }); assert.ok(await host.extensionSettings('mcp'));
    await host.requestChange('mcp', { action: 'remove' }); assert.deepEqual(host.inspect(), []); assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).entries, []);
    await artifacts.verify(artifact);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
