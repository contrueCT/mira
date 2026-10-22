import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeRecord } from '@mira/context';
import { ExtensionHost } from '@mira/extension-host';
import type { Json } from '@mira/extension-sdk';
import { extensionReceiver } from '@mira/server';
import { FeishuPrivateStore } from '../../packages/feishu-channel/src/store.ts';
import { createTestDatabase } from '../integration/database.mts';

const pluginUrl = pathToFileURL(path.resolve('packages/feishu-channel/src/index.ts')).href;
const extensionId = 'synthetic-feishu-inbound';
const namespace = (id: string) => JSON.stringify(['extension', extensionId, id]);
const until = async (ready: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('synthetic settings action did not settle'); };
const record = (parentId: string | null): RuntimeRecord => ({ formatVersion: 1, runtime: 'synthetic', runtimeVersion: '1', id: randomUUID(), parentId, kind: 'message', occurredAt: new Date(0).toISOString(), payload: { text: 'Synthetic completed Wake; no model request' } });
const originalText = (value: Json): string => { const payload = value as { text: string; textEncoding?: string }; return payload.textEncoding === 'json-string' ? JSON.parse(payload.text) as string : payload.text; };

test('Feishu NUL and lone-surrogate text preserves original content through real Host, PG History, Wake and current pending recovery', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-pg-')));
  const entry = path.join(root, 'plugin.mjs'), privateDirectory = path.join(root, 'private');
  await writeFile(entry, `import { createFeishuExtension } from ${JSON.stringify(pluginUrl)};
    export const state = {receive:null};
    export default createFeishuExtension({
      async verify(){return {botOpenId:'synthetic-bot',scopes:[]};},
      async register(){throw Error('unexpected registration');},
      async send(){throw Error('no network sends in this fixture');},
      async connect(credentials,handlers){state.receive=(messageId,text)=>handlers.onMessage({messageId,chatId:'owner-chat',chatType:'p2p',senderOpenId:'owner',senderType:'user',tenantKey:'tenant',createdAt:new Date(0).toISOString(),text,messageType:'text'});handlers.onState('connected');return {state:()=> 'connected',async close(){}};}
    });`);
  const { state } = await import(pathToFileURL(entry).href) as { state: { receive(id: string, text: string): Promise<void> } };
  const entries = [{ id: extensionId, path: entry, installationId: randomUUID(), config: { appId: 'synthetic-app' } }];
  let writer = await db.acquire('synthetic-feishu-mira'); let host: ExtensionHost | undefined, failWake = false;
  const open = async () => { const receive = extensionReceiver(writer); host = new ExtensionHost({ entries, privateDirectory, receive: async (...args) => { if (failWake) throw Error('synthetic writer unavailable'); return receive(...args); } }); await host.start(); };
  const action = async (id: string) => { const view = (await host!.extensionSettings(extensionId))!; await host!.startSettingsAction(extensionId, id, view.revision); await until(async () => (await host!.extensionSettings(extensionId))?.operation?.state !== 'pending'); assert.equal((await host!.extensionSettings(extensionId))?.operation?.state, 'succeeded'); };
  const finishAndRead = async (expected: string) => {
    const run = await writer.claimWakeBatch(); assert.ok(run); assert.equal(run.requests.length, 1);
    const event = run.requests[0]!.event; const envelope = event.payload as { data: Json; message: { text: string } };
    assert.equal(originalText(envelope.data), expected); assert.equal(envelope.message.text.isWellFormed(), true); assert.ok(!envelope.message.text.includes('\u0000'));
    const snapshot = await writer.load(); const input = record(snapshot.records.at(-1)?.id ?? null);
    const version = await writer.appendWakeInput(run.id, snapshot.version, input); await writer.appendWakeFinal(run.id, version, record(input.id)); await writer.completeWakeRun(run.id);
    const history = db.store.history(writer.miraId); const requests = await history.readRunRequests({ id: run.id });
    assert.ok(requests); assert.equal(requests.items[0]!.source, 'extension');
    const saved = await history.read({ id: run.requests[0]!.eventId, maxBytes: 1_048_576 }); assert.ok(saved?.kind === 'event');
    assert.equal(originalText((saved.event.payload as { data: Json }).data), expected);
    const query = await db.admin.query<{ source: string }>("SELECT event->>'source' AS source FROM life_events WHERE mira_id=$1", [writer.miraId]); assert.ok(query.rows.every(row => row.source === 'extension'));
    await writer.verifyActive(); return event.id;
  };
  try {
    // Independently lock the PostgreSQL failure mode: json storage accepts the bytes,
    // while object-field extraction must materialize invalid text and fails.
    for (const text of ['a\u0000b', 'a\ud800b', 'a\udc00b']) await assert.rejects(db.admin.query("SELECT ($1::json)->>'source'", [JSON.stringify({ source: 'extension', payload: { text } })]), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && ['22P05', '22P02'].includes(String(error.code)));
    await writer.initializeDreaming(); await open();
    let view = (await host!.extensionSettings(extensionId))!; await host!.saveExtensionSettings(extensionId, { expectedRevision: view.revision, values: {}, secrets: { appSecret: 'synthetic-secret' } });
    await action('connect'); await action('pair'); view = (await host!.extensionSettings(extensionId))!;
    await state.receive('pair', view.status.details!.find(item => item.value.startsWith('/mira pair '))!.value);
    const originals = ['a\u0000b', 'a\ud800b', 'a\udc00b', 'a\u0008b\u000bc\u000cd', '正常 🦊 text', 'x'.repeat(100_001)];
    for (const [index, text] of originals.entries()) { await state.receive(`incoming-${index}`, text); await finishAndRead(text); }
    await host!.close(); host = undefined; await writer.close(); writer = await db.acquire('synthetic-feishu-mira'); await open();
    for (const [index, text] of originals.entries()) await state.receive(`incoming-${index}`, text);
    assert.equal(await writer.claimWakeBatch(), null, 'restart duplicates do not create another Wake');
    failWake = true; const pendingOriginal = 'old\u0000pending\ud800'; await assert.rejects(state.receive('pending-before-restart', pendingOriginal));
    await host!.close(); host = undefined;
    const directories = await readdir(privateDirectory); const file = path.join(privateDirectory, directories[0]!, 'data', 'feishu-state.json');
    const store = new FeishuPrivateStore<{ inbox: Array<{ id: string; event: { payload: { text: string; textEncoding?: string }; message: { text: string } } }> }>(file, path.resolve('packages/feishu-channel'));
    const pending = (await store.load())!; const wake = pending.inbox[0]!;
    wake.event.payload.text = pendingOriginal; delete wake.event.payload.textEncoding;
    // A preceding preview fix may already have made the projection legal while raw payload remained poisonous.
    wake.event.message.text = '[Previous legal preview]'; const stableId = wake.id; await store.save(pending);
    failWake = false; await open(); assert.equal(await finishAndRead(pendingOriginal), namespace(stableId));
    assert.deepEqual((await store.load())!.inbox, []);
    await state.receive('ordinary-after-repair', 'healthy ordinary message'); await finishAndRead('healthy ordinary message');
    await writer.requestDreaming({ idleMs: 30 * 60_000, intervalMs: 24 * 60 * 60_000, minCompactions: 3, instruction: 'Synthetic health check; no model call' });
    await writer.verifyActive(); assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0]!.n, originals.length + 2);
    const history = db.store.history(writer.miraId); assert.ok((await history.search({ query: 'healthy', mode: 'substring' })).hits.length); assert.ok((await history.page({ limit: 100 })).hits.length);
    const current = await new FeishuPrivateStore(file, path.resolve('packages/feishu-channel')).load(); assert.ok(!JSON.stringify(current).includes('old\\u0000pending'));
    assert.equal((await host!.extensionSettings(extensionId))?.status.state, 'connected');
  } finally { await host?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
