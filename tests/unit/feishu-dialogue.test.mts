import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtensionHost } from '@mira/extension-host';
const pluginUrl = pathToFileURL(path.resolve('packages/feishu-channel/src/index.ts')).href;
const until = async (ready: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('operation did not settle'); };
async function fixture(run: (host: ExtensionHost, state: { registrations: number; connections: number; closes: number; finish(): void }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-dialogue-'));
  const entry = path.join(root, 'plugin.mjs'); const configurationFile = path.join(root, 'extensions.json');
  await writeFile(entry, `import { createFeishuExtension } from ${JSON.stringify(pluginUrl)};
    export const state = {registrations:0,connections:0,closes:0,finish:null};
    export default createFeishuExtension({
      async register(options) { state.registrations++; options.onQRCode({url:'https://accounts.feishu.cn/synthetic-private-challenge',expireIn:600}); return new Promise((resolve,reject)=>{const abort=()=>reject(Error('synthetic cancelled'));options.signal.addEventListener('abort',abort,{once:true});state.finish=()=>{options.signal.removeEventListener('abort',abort);resolve({appId:'cli_synthetic',appSecret:'synthetic-private-credential',domain:'feishu'});};}); },
      async verify(){return {botOpenId:'bot',scopes:[]};},
      async connect(credentials,handlers){state.connections++;handlers.onState('connected');return {state:()=> 'connected',async close(){state.closes++;}};},
      async send(){throw Error('No messages authorized in this fixture');}
    });`);
  const entries = [{ id: 'owner-channel', path: entry, config: { domain: 'feishu' } }];
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => { assert.fail('connection must not wake'); } });
  try { await host.start(); const { state } = await import(pathToFileURL(entry).href); await run(host, state); }
  finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}
const execute = async (host: ExtensionHost, args = {}) => {
  const tool = (await host.prepare()).find(item => item.tool.name === 'feishu_connect')!;
  return tool.tool.execute(args, { callId: 'connect-dialogue', signal: new AbortController().signal });
};
test('Feishu dialogue starts the actual shared settings runner and UI cancellation fences retry', async () => {
  await fixture(async (host, state) => {
    const receipt = await execute(host); const operation = JSON.parse(receipt.text).operation;
    assert.equal(operation.state, 'pending'); assert.equal(operation.action, 'register');
    assert.ok(!receipt.text.includes('synthetic-private'));
    await until(async () => !!(await host.extensionSettings('owner-channel'))?.status.authorization);
    const view = (await host.extensionSettings('owner-channel'))!;
    assert.equal(view.operation?.id, operation.id);
    assert.equal(view.status.authorization?.url, 'https://accounts.feishu.cn/synthetic-private-challenge');
    assert.equal(JSON.parse((await execute(host)).text).operation.id, operation.id);
    assert.equal(state.registrations, 1);
    await assert.rejects(host.startSettingsAction('owner-channel', 'register', view.revision));
    await host.cancelSettingsAction('owner-channel', operation.id);
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'cancelled');
    assert.equal((await host.extensionSettings('owner-channel'))?.status.authorization, undefined);
    assert.match((await execute(host)).text, /结果未知/); assert.equal(state.registrations, 1);
    await host.requestChange('owner-channel', { action: 'reload' });
    assert.match((await execute(host)).text, /结果未知/); assert.equal(state.registrations, 1);
  });
});
test('Feishu tool cancellation targets the shared operation and completed connection is reused', async () => {
  await fixture(async (host, state) => {
    const receipt = JSON.parse((await execute(host)).text);
    await until(async () => state.registrations === 1);
    await assert.rejects(execute(host, { cancelOperationId: 'wrong-operation' }));
    state.finish();
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'succeeded');
    const ready = await execute(host); assert.ok(!ready.text.includes('synthetic-private'));
    assert.equal(state.registrations, 1); assert.equal(state.connections, 1);
    await host.requestChange('owner-channel', { action: 'reload' });
    await execute(host); assert.equal(state.registrations, 1); assert.equal(state.connections, 2);
    assert.ok(receipt.operation.id);
  });
});
test('Feishu dialogue cancel and disable retire the same pending registration without late credentials', async () => {
  await fixture(async (host, state) => {
    const receipt = JSON.parse((await execute(host)).text);
    await until(async () => state.registrations === 1);
    await execute(host, { cancelOperationId: receipt.operation.id });
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'cancelled');
    state.finish(); await host.requestChange('owner-channel', { action: 'disable' });
    assert.equal(state.connections, 0); assert.equal(await host.extensionSettings('owner-channel'), null);
  });
});
