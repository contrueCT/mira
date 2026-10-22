import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ExtensionEvent } from '@mira/extension-sdk';
import { FeishuPrivateStore } from '../../packages/feishu-channel/src/store.ts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtensionHost } from '@mira/extension-host';
const pluginUrl = pathToFileURL(path.resolve('packages/feishu-channel/src/index.ts')).href;
const until = async (ready: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('operation did not settle'); };
async function fixture(run: (host: ExtensionHost, state: { registrations: number; connections: number; closes: number; sends: number; holdSend: boolean; finishSend: ((unknown?: boolean) => void) | null; receive(text: string): Promise<void>; reconnecting(): void; finish(): void }) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-dialogue-')));
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

// Synthetic platform callbacks cross the actual Cordis projection validator and private SQLite.
// The receive writer below enforces immutable identity, without a live tenant/model.
async function durableFixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-durable-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'plugin.mjs'); const privateDirectory = path.join(root, 'private');
  await writeFile(entry, `import { createFeishuExtension } from ${JSON.stringify(pluginUrl)};
    export const state = {sends:0,unknown:false,receive:null};
    export default createFeishuExtension({
      async verify(){return {botOpenId:'synthetic-bot',scopes:[]};},
      async register(){throw Error('unexpected registration');},
      async connect(credentials,handlers){state.receive=(messageId,text)=>handlers.onMessage({messageId,chatId:'owner-chat',chatType:'p2p',senderOpenId:'owner',senderType:'user',tenantKey:'tenant',createdAt:new Date(0).toISOString(),text,messageType:'text'});handlers.onState('connected');return {state:()=> 'connected',async close(){}};},
      async send(){state.sends++;if(state.unknown)throw Error('synthetic unknown');return {messageId:'sent-'+state.sends};}
    });`);
  const { state } = await import(pathToFileURL(entry).href) as { state: { sends: number; unknown: boolean; receive(id: string, text: string): Promise<void> } };
  const entries = [{ id: 'owner-channel', path: entry, installationId: randomUUID(), config: { appId: 'synthetic-app' } }];
  const accepted = new Map<string, ExtensionEvent>(); let failPublication = false, failWake = false;
  let host!: ExtensionHost;
  const open = async () => {
    host = new ExtensionHost({ entries, privateDirectory, receive: async (_id, event, wake) => {
      if (wake ? failWake : failPublication) throw Error('synthetic writer unavailable');
      const previous = accepted.get(event.id); if (previous) { assert.deepEqual(event, previous); return 'duplicate'; }
      accepted.set(event.id, structuredClone(event)); return 'inserted';
    } }); await host.start();
  };
  const action = async (id: string) => {
    const view = (await host.extensionSettings('owner-channel'))!;
    await host.startSettingsAction('owner-channel', id, view.revision);
    await until(async () => (await host.extensionSettings('owner-channel'))?.operation?.state !== 'pending');
    assert.equal((await host.extensionSettings('owner-channel'))?.operation?.state, 'succeeded');
  };
  const pair = async () => { await action('pair'); const view = (await host.extensionSettings('owner-channel'))!; await state.receive('pair-'+randomUUID(), view.status.details!.find(item => item.value.startsWith('/mira pair '))!.value); };
  const saveSecret = async () => { const view = (await host.extensionSettings('owner-channel'))!; await host.saveExtensionSettings('owner-channel', { expectedRevision: view.revision, values: {}, secrets: { appSecret: 'synthetic-secret' } }); };
  const send = async (callId: string, text: string) => {
    const tool = (await host.prepare()).find(item => item.tool.name === 'feishu_send_message')!.tool;
    return (await tool.execute({ text }, { callId, signal: new AbortController().signal })).details as { status: string };
  };
  await open(); t.after(() => host.close()); await saveSecret(); await action('connect'); await pair();
  const directories = await readdir(privateDirectory); const file = path.join(privateDirectory, directories[0]!, 'data', 'feishu-state.json');
  return { state, accepted, file, send, action, pair, saveSecret, failPublication(value: boolean) { failPublication = value; }, failWake(value: boolean) { failWake = value; },
    restart: async () => { await host.close(); await open(); }, close: () => host.close() };
}

test('large repeated sends keep the active ledger bounded while receipts and unknown identities survive restart', async t => {
  const f = await durableFixture(t); const body = 'x'.repeat(100_000);
  for (let index = 0; index < 25; index++) assert.equal((await f.send(`large-${index}`, body)).status, 'sent');
  await f.state.receive('after-large-sends', 'hello');
  const db = new DatabaseSync(`${f.file}.sqlite`);
  try {
    const ledger = db.prepare('SELECT value FROM ledger').get()!.value as string;
    assert.ok(Buffer.byteLength(ledger) < 10_000); assert.deepEqual(JSON.parse(ledger).sends, {});
    assert.equal(db.prepare('SELECT count(*) AS n FROM receipts').get()!.n, 25);
    for (const row of db.prepare('SELECT value FROM receipts').all()) {
      const receipt = JSON.parse(row.value as string); assert.ok(receipt.parts.every((part: { published?: boolean; publication?: unknown }) => part.published && !part.publication));
    }
  } finally { db.close(); }
  f.state.unknown = true; assert.equal((await f.send('persistent-unknown', 'uncertain')).status, 'unknown');
  f.state.unknown = false; const before = f.state.sends; await f.restart();
  assert.equal((await f.send('large-0', body)).status, 'sent');
  assert.equal((await f.send('large-0', 'conflicting body')).status, 'not_sent');
  assert.equal((await f.send('persistent-unknown', 'uncertain')).status, 'unknown'); assert.equal(f.state.sends, before);
  await f.state.receive('after-restart', 'hello again'); assert.equal((await f.send('fresh-after-restart', 'new send')).status, 'sent');
});

test('confirmed unpublished text survives restart and old binding publications stay isolated after unbind', async t => {
  const f = await durableFixture(t); f.failPublication(true);
  assert.equal((await f.send('pending-display', 'saved publication')).status, 'sent'); const count = f.state.sends;
  let db = new DatabaseSync(`${f.file}.sqlite`);
  try { assert.ok(JSON.parse(db.prepare('SELECT value FROM receipts WHERE call_id=?').get('pending-display')!.value as string).parts[0].publication); } finally { db.close(); }
  f.failPublication(false); await f.restart(); assert.equal(f.state.sends, count);
  assert.equal([...f.accepted.values()].filter(event => event.message?.text === 'saved publication').length, 1);
  f.failPublication(true); assert.equal((await f.send('retired-display', 'old binding publication')).status, 'sent');
  await f.action('unbind'); f.failPublication(false); await f.saveSecret(); await f.action('connect'); await f.pair(); await f.restart();
  assert.equal([...f.accepted.values()].filter(event => event.message?.text === 'old binding publication').length, 0);
  assert.equal((await f.send('retired-display', 'old binding publication')).status, 'not_sent');
  db = new DatabaseSync(`${f.file}.sqlite`);
  try { assert.ok(JSON.parse(db.prepare('SELECT value FROM receipts WHERE call_id=?').get('retired-display')!.value as string).parts[0].publication); } finally { db.close(); }
});

test('oversized, control and Unicode inbound text reaches the real Host with original payload and a bounded preview', async t => {
  const f = await durableFixture(t);
  const messages = ['a'.repeat(100_001), 'a'.repeat(99_930)+'🦊'.repeat(100), 'a\u0000b\u0008c\u000bd\u000c', '', '你'.repeat(50_000), 'lone-high\ud800', 'lone-low\udc00'];
  for (const [index, text] of messages.entries()) {
    await f.state.receive(`incoming-${index}`, text);
    const event = [...f.accepted.values()].find(event => (event.payload as Record<string, unknown>).messageId === `incoming-${index}`)!;
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.textEncoding === 'json-string' ? JSON.parse(payload.text as string) : payload.text, text);
    assert.equal(payload.textEncoding, text.includes('\u0000') || !text.isWellFormed() ? 'json-string' : undefined);
    assert.equal(event.message!.text.isWellFormed(), true);
    assert.ok(event.message!.text.length <= 100_000); assert.doesNotMatch(event.message!.text, /[\u0000\u0008\u000b\u000c]/u);
    if (index < 4) assert.match(event.message!.text, /original text is preserved/);
    if (index < 2) { assert.match(event.message!.text, /Preview truncated/); assert.doesNotMatch(event.message!.text, /[\ud800-\udbff](?![\udc00-\udfff])/u); }
  }
  await f.state.receive('ordinary-after-preview', 'hello'); await f.restart(); await f.state.receive('ordinary-after-restart', 'hello again');
  const db = new DatabaseSync(`${f.file}.sqlite`); try { assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM ledger').get()!.value as string).inbox, []); } finally { db.close(); }
});

test('an existing pending inbox with an over-limit projection recovers without losing its immutable original text', async t => {
  const f = await durableFixture(t); f.failWake(true); const original = 'a'.repeat(100_001);
  await assert.rejects(f.state.receive('pending-oversized', original)); await f.close();
  const store = new FeishuPrivateStore<Record<string, any>>(f.file, path.resolve('packages/feishu-channel'));
  const state = (await store.load())!; state.inbox[0].event.message.text = original; const identity = state.inbox[0].id;
  await store.save(state); f.failWake(false); await f.restart();
  const accepted = f.accepted.get(identity)!; assert.equal((accepted.payload as Record<string, unknown>).text, original); assert.match(accepted.message!.text, /Preview truncated/);
  await f.state.receive('pending-oversized', original); await f.state.receive('short-after-repair', 'hello');
});

test('current v1 channel receipts migrate together and retain unknown identity plus pending publication', async t => {
  const f = await durableFixture(t); f.failPublication(true);
  assert.equal((await f.send('old-pending', 'original pending body')).status, 'sent');
  f.state.unknown = true; assert.equal((await f.send('old-unknown', 'uncertain old body')).status, 'unknown'); f.state.unknown = false;
  const before = f.state.sends; await f.close();
  const db = new DatabaseSync(`${f.file}.sqlite`);
  const data = JSON.parse(db.prepare('SELECT value FROM ledger').get()!.value as string);
  data.sends = Object.fromEntries(db.prepare('SELECT call_id, value FROM receipts').all().map(row => [row.call_id, JSON.parse(row.value as string)]));
  const original = JSON.stringify(data); const revision = createHash('sha256').update(original).digest('hex');
  db.exec('DROP INDEX pending_receipts; DROP TABLE receipts; DROP TABLE ledger; CREATE TABLE ledger (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT, revision TEXT NOT NULL, legacy_revision TEXT NOT NULL) STRICT; PRAGMA user_version=1');
  db.prepare('INSERT INTO ledger VALUES (1,?,?,?)').run(original, revision, revision); db.close();
  await writeFile(f.file, original, { mode: 0o600 }); f.failPublication(false); await f.restart();
  assert.equal(await readFile(f.file, 'utf8'), original);
  assert.equal((await f.send('old-unknown', 'uncertain old body')).status, 'unknown'); assert.equal(f.state.sends, before);
  assert.equal([...f.accepted.values()].filter(event => event.message?.text === 'original pending body').length, 1);
  const current = new DatabaseSync(`${f.file}.sqlite`);
  try { assert.equal(current.prepare('PRAGMA user_version').get()!.user_version, 2); assert.deepEqual(JSON.parse(current.prepare('SELECT value FROM ledger').get()!.value as string).sends, {}); } finally { current.close(); }
});

test('a confirmed HTTP send with failed local outcome save remains unknown and is never repeated', async t => {
  const f = await durableFixture(t); const original = DatabaseSync.prototype.prepare; let failOutcome = true;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (!sql.startsWith('INSERT INTO receipts')) return statement;
    const run = statement.run;
    t.mock.method(statement, 'run', function(this: typeof statement, ...args: Parameters<typeof run>) {
      const receipt = JSON.parse(args[1] as string);
      if (failOutcome && receipt.parts.some((part: { status: string }) => part.status === 'sent')) { failOutcome = false; throw Error('synthetic outcome save failure'); }
      return run.apply(this, args);
    }); return statement;
  });
  assert.equal((await f.send('outcome-save-unknown', 'may have arrived')).status, 'unknown'); const count = f.state.sends;
  t.mock.restoreAll(); await f.restart();
  assert.equal((await f.send('outcome-save-unknown', 'may have arrived')).status, 'unknown'); assert.equal(f.state.sends, count);
  assert.equal([...f.accepted.values()].filter(event => event.message?.text === 'may have arrived').length, 0);
});
