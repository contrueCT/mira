import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, ExtensionHost, readExtensionConfiguration } from '@mira/extension-host';
import { prepareExtensionPackage } from '../../scripts/prepare-extension-package.mts';
const source = path.resolve(import.meta.dirname, '../../packages/feishu-channel');

test('shipped Feishu package follows real prepare, stage, content-test, install, activate and cleanup workflow', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-install-'));
  let host: ExtensionHost | undefined;
  try {
    const workspace = await prepareExtensionPackage(source, path.join(root, 'workspace'));
    assert.ok(workspace.packages > 2, 'published SDK transitive runtime closure is included');
    const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
    const artifact = await artifacts.stage(workspace.directory, workspace.entryRelative);
    const checked = await artifacts.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', "const {default: plugin} = await import('./entry.mjs'); if (plugin.name !== 'mira-feishu-channel') throw Error('wrong export');"] });
    assert.equal(checked.passed, true, checked.stderr); assert.equal(checked.unchanged, true);
    const config = path.join(root, 'extensions.json'); await writeFile(config, JSON.stringify({ entries: [], artifactsDirectory: artifacts.root }));
    host = new ExtensionHost({ ...await readExtensionConfiguration(config), receive: async () => { assert.fail('unconfigured extension must not wake'); } });
    await host.start();
    const install = await host.requestChange('feishu', { action: 'install', digest: artifact.digest, config: { domain: 'feishu' } });
    assert.equal(install.status, 'applied'); assert.equal(install.test, 'passed'); assert.deepEqual(await host.prepare(), []);
    const activation = await host.requestChange('feishu', { action: 'activate' }); assert.equal(activation.status, 'applied', activation.error);
    const settings = await host.extensionSettings('feishu'); assert.ok(settings); assert.equal(settings.status.state, 'unconfigured');
    assert.equal(settings.fields.find(field => field.key === 'appSecret')?.configured, false);
    const tools = await host.prepare(); assert.deepEqual(tools.map(tool => tool.tool.name).sort(), ['feishu_connect', 'feishu_send_message', 'feishu_status']);
    const status = tools.find(tool => tool.tool.name === 'feishu_status')!;
    assert.equal(JSON.parse((await status.tool.execute({}, { callId: 'status', signal: new AbortController().signal })).text).ownerBound, false);
    assert.ok(!JSON.stringify(await host.inspect()).includes('appSecret'), 'private key is not extension configuration');
    await host.requestChange('feishu', { action: 'disable' }); assert.equal(await host.extensionSettings('feishu'), null); assert.deepEqual(await host.prepare(), []);
    const stale = await status.tool.execute({}, { callId: 'retired', signal: new AbortController().signal }); assert.equal((stale.details as { status: string }).status, 'stale');
    await host.requestChange('feishu', { action: 'enable' }); assert.ok(await host.extensionSettings('feishu'));
    await host.requestChange('feishu', { action: 'remove' }); assert.deepEqual(host.inspect(), []); assert.deepEqual(JSON.parse(await readFile(config, 'utf8')).entries, []);
    await artifacts.verify(artifact);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
