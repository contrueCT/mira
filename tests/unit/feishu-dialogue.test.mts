import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtensionHost } from '@mira/extension-host';
const pluginUrl = pathToFileURL(path.resolve('packages/feishu-channel/src/index.ts')).href;
const until = async (ready: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('operation did not settle'); };
async function fixture(run: (host: ExtensionHost, state: { registrations: number; connections: number; closes: number; sends: number; holdSend: boolean; finishSend: ((unknown?: boolean) => void) | null; receive(text: string): Promise<void>; reconnecting(): void; finish(): void }) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-dialogue-'));
  const entry = path.join(root, 'plugin.mjs'); const configurationFile = path.join(root, 'extensions.json');
  await writeFile(entry, `import { createFeishuExtension } from ${JSON.stringify(pluginUrl)};
    export const state = {registrations:0,connections:0,closes:0,finish:null,sends:0,holdSend:false,finishSend:null,receive:null,reconnecting:null};
    export default createFeishuExtension({
      async register(options) { state.registrations++; options.onQRCode({url:'https://accounts.feishu.cn/synthetic-private-challenge',expireIn:600}); return new Promise((resolve,reject)=>{const abort=()=>reject(Error('synthetic cancelled'));options.signal.addEventListener('abort',abort,{once:true});state.finish=()=>{options.signal.removeEventListener('abort',abort);resolve({appId:'cli_synthetic',appSecret:'synthetic-private-credential',domain:'feishu'});};}); },
      async verify(){return {botOpenId:'bot',scopes:[]};},
      async connect(credentials,handlers){state.connections++;state.reconnecting=()=>handlers.onState('reconnecting');state.receive=text=>handlers.onMessage({messageId:'pair',chatId:'owner-chat',chatType:'p2p',senderOpenId:'owner',senderType:'user',tenantKey:'tenant',createdAt:new Date(0).toISOString(),text,messageType:'text'});handlers.onState('connected');return {state:()=> 'connected',async close(){state.closes++;}};},
      async send(){state.sends++;if(state.holdSend)return new Promise((resolve,reject)=>{state.finishSend=unknown=>unknown?reject(Error('synthetic unknown')):resolve({messageId:'sent-'+state.sends});});return {messageId:'sent-'+state.sends};}
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


for (const action of ['reconnect', 'unbind']) test(`cancelled ${action} preserves binding and restores future sends without replay`, async () => {
  await fixture(async (host, state) => {
    await execute(host); await until(async () => state.registrations === 1); state.finish();
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'succeeded');
    const start = async (id: string) => { const view = (await host.extensionSettings('owner-channel'))!; return host.startSettingsAction('owner-channel', id, view.revision); };
    await start('pair'); await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'succeeded');
    const challenge = (await host.extensionSettings('owner-channel'))!.status.details!.find(item => item.value.startsWith('/mira pair '))!.value;
    await state.receive(challenge);
    await until(async () => (await host.extensionSettings('owner-channel'))?.status.state === 'connected');
    const sendTool = (await host.prepare()).find(item => item.tool.name === 'feishu_send_message')!.tool;
    const send = (id: string, text = 'synthetic owner message') => sendTool.execute({ text }, { callId: id, signal: new AbortController().signal });
    const longText = 'x'.repeat(7000);
    state.holdSend = true; const inFlight = send('in-flight', longText);
    await until(async () => !!state.finishSend);
    const queued = send('queued-old-generation').catch(error => error);
    const pending = await start(action); await host.cancelSettingsAction('owner-channel', pending.operation!.id);
    state.holdSend = false; state.finishSend!(action === 'unbind');
    const outcome = await inFlight;
    assert.equal((await queued).name, 'AbortError');
    assert.equal(state.sends, 1, 'only the first in-flight part reached HTTP; no automatic pairing test, tail or queued replay');
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'cancelled');
    const after = (await host.extensionSettings('owner-channel'))!;
    assert.equal(after.status.state, 'connected'); assert.equal(after.fields.find(field => field.key === 'appSecret')?.configured, true);
    assert.equal(state.closes, 0); assert.equal(state.connections, 1);
    assert.match(JSON.stringify(after.status.details), /owner-chat/);
    const beforeReplay = state.sends; assert.equal(JSON.parse((await send('in-flight', longText)).text).status, JSON.parse(outcome.text).status); assert.equal(state.sends, beforeReplay);
    assert.equal(JSON.parse((await send('new-send')).text).status, 'sent'); assert.equal(state.sends, beforeReplay + 1);
    await execute(host); assert.equal(state.registrations, 1); assert.equal(state.connections, 1);
  });
});


test('background WebSocket reconnect retains usable generic recovery actions without a pending settings operation', async () => {
  await fixture(async (host, state) => {
    await execute(host); await until(async () => state.registrations === 1); state.finish();
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'succeeded');
    state.reconnecting();
    const view = (await host.extensionSettings('owner-channel'))!;
    assert.equal(view.status.state, 'connecting'); assert.equal(view.operation?.state, 'succeeded');
    assert.deepEqual(view.actions.map(action => action.id), ['connect', 'unbind']);
    await host.startSettingsAction('owner-channel', 'connect', view.revision);
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state === 'succeeded');
    assert.equal(state.connections, 2); assert.equal(state.registrations, 1); assert.equal(state.closes, 1);
    state.reconnecting(); const recovery = (await host.extensionSettings('owner-channel'))!;
    await host.startSettingsAction('owner-channel', 'unbind', recovery.revision);
    await until(async () => (await host.extensionSettings('owner-channel'))?.status.state === 'unconfigured');
    assert.equal(state.closes, 2); assert.equal(state.sends, 0);
  });
});
