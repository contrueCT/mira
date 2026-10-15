import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionContext, ExtensionTool, ExtensionEvent, ExtensionWake, ContextProvider, Json } from '@mira/extension-sdk';
import { createFeishuExtension } from '../../packages/feishu-channel/src/index.ts';
import type { FeishuSdk, FeishuIncomingText, FeishuRegistrationOptions, FeishuCredentials } from '../../packages/feishu-channel/src/sdk.ts';

type Settings = { actions: Array<{ id: string; execute(context: { signal: AbortSignal }): Promise<void> }>; status(): { state: string; details?: Array<{ label: string; value: string }>; authorization?: { url: string } } };
const secret = 'synthetic-private-app-secret';
const credentials: FeishuCredentials = { appId: 'app-test', appSecret: secret, domain: 'feishu' };
const incoming = (overrides: Partial<FeishuIncomingText> = {}): FeishuIncomingText => ({ messageId: 'message-1', chatId: 'chat-owner', chatType: 'p2p', senderOpenId: 'user-owner', senderType: 'user', tenantKey: 'tenant-owner', createdAt: '2026-01-01T00:00:00.000Z', text: 'hello', messageType: 'text', ...overrides });
function fakeSdk() {
  const connections: Array<Parameters<FeishuSdk['connect']>[1] & { closed: boolean }> = [];
  const sends: Array<Parameters<FeishuSdk['send']>[1]> = [];
  let register: FeishuSdk['register'] = async () => credentials;
  let send: FeishuSdk['send'] = async () => ({ messageId: `sent-${sends.length}` });
  const calls = { verify: 0, register: 0, connect: 0 };
  const sdk: FeishuSdk = {
    async register(options) { calls.register++; return register(options); },
    async verify() { calls.verify++; return { botOpenId: 'bot-test', scopes: [] }; },
    async connect(_credentials, handlers) { calls.connect++; const record = { ...handlers, closed: false }; connections.push(record); handlers.onState('connected'); return { state: () => record.closed ? 'closed' : 'connected', async close() { record.closed = true; handlers.onState('closed'); } }; },
    async send(creds, message) { assert.equal(creds.appSecret, secret); sends.push(structuredClone(message)); return send(creds, message); },
  };
  return { sdk, connections, sends, calls, setRegister(fn: FeishuSdk['register']) { register = fn; }, setSend(fn: FeishuSdk['send']) { send = fn; }, receive(message = incoming()) { return connections.at(-1)!.onMessage(message); } };
}
async function fixture(t: test.TestContext, options: { directory?: string; secrets?: Map<string, string>; sdk?: ReturnType<typeof fakeSdk>; config?: Json } = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-channel-'));
  if (!options.directory) t.after(() => rm(directory, { recursive: true, force: true }));
  const secrets = options.secrets ?? new Map([['appSecret', secret]]);
  const sdk = options.sdk ?? fakeSdk(); const tools = new Map<string, ExtensionTool>(); const providers: ContextProvider[] = [];
  const cleanups: Array<() => void | Promise<void>> = []; const wakes: ExtensionWake[] = []; const events: ExtensionEvent[] = []; const reads: string[] = []; const accepted = new Map<string, ExtensionWake>();
  let failEvent = false;
  let failWake = false; let settings!: Settings;
  const context = {
    id: 'installation-test', privateDirectory: directory,
    credentials: { async get(key: string) { reads.push(key); return secrets.get(key) ?? null; }, async has(key: string) { return secrets.has(key); }, async set(key: string, value: string) { secrets.set(key, value); }, async delete(key: string) { secrets.delete(key); } },
    registerSettings(value: Settings) { settings = value; }, registerTool(tool: ExtensionTool) { tools.set(tool.name, tool); }, registerContextProvider(provider: ContextProvider) { providers.push(provider); }, onCleanup(cleanup: () => void | Promise<void>) { cleanups.push(cleanup); },
    async emitEvent(event: ExtensionEvent) { if (failEvent) throw new Error('synthetic event failure'); const old = events.find(value => value.id === event.id); if (old) { assert.deepEqual(old, event); return 'duplicate' as const; } events.push(structuredClone(event)); return 'inserted' as const; },
    async requestWake(wake: ExtensionWake) { wakes.push(structuredClone(wake)); if (failWake) throw new Error('synthetic wake persistence failure'); const old = accepted.get(wake.id); if (old) { assert.deepEqual(wake, old, 'durable host rejects conflicting immutable Wake identity'); return 'duplicate' as const; } accepted.set(wake.id, structuredClone(wake)); return 'inserted' as const; },
  };
  await createFeishuExtension(sdk.sdk).apply({ mira: context as unknown as ExtensionContext }, options.config ?? { appId: 'app-test' });
  const close = async () => { for (const cleanup of cleanups) await cleanup(); }; t.after(close);
  const action = (id: string, signal = new AbortController().signal) => settings.actions.find(item => item.id === id)!.execute({ signal });
  const send = async (callId: string, text: string, replyToMessageId?: string, signal = new AbortController().signal) => (await tools.get('feishu_send_message')!.execute({ text, ...(replyToMessageId ? { replyToMessageId } : {}) }, { callId, signal })).details as { status: string; sentParts: number; totalParts: number };
  const pair = async () => { await action('pair'); const challenge = settings.status().details!.find(item => item.value.startsWith('/mira pair '))!.value; await sdk.receive(incoming({ text: challenge, messageId: 'pair-message' })); await action('confirm'); };
  return { directory, secrets, sdk, settings, tools, providers, reads, wakes, events, failEvent(value: boolean) { failEvent = value; }, close, action, send, pair, failWake(value: boolean) { failWake = value; }, state: async () => JSON.parse(await readFile(path.join(directory, 'feishu-state.json'), 'utf8')) };
}

test('Feishu activation is lazy; manual configuration explicitly verifies and connects', async t => {
  const f = await fixture(t); assert.deepEqual(f.sdk.calls, { register: 0, verify: 0, connect: 0 }); assert.deepEqual(f.reads, []);
  assert.equal(f.settings.status().state, 'unconfigured'); assert.equal((await f.send('before', 'hello')).status, 'not_sent');
  await f.action('connect'); assert.equal(f.sdk.calls.verify, 1); assert.equal(f.sdk.calls.connect, 1); assert.equal(f.settings.status().state, 'pending');
  assert.equal((await f.state()).app.appId, 'app-test'); assert.ok(!(await readFile(path.join(f.directory, 'feishu-state.json'), 'utf8')).includes(secret));
});
test('Feishu QR credentials stay private and authorization never enters model observations', async t => {
  const sdk = fakeSdk(); let finish!: (credentials: FeishuCredentials) => void;
  sdk.setRegister(async options => { options.onQRCode({ url: 'https://accounts.feishu.cn/authorize?token=private-qr', expireIn: 60 }); return new Promise(resolve => { finish = resolve; }); });
  const f = await fixture(t, { sdk, secrets: new Map() }); const registration = f.action('register');
  assert.equal(f.settings.status().authorization?.url, 'https://accounts.feishu.cn/authorize?token=private-qr');
  const publicProjection = JSON.stringify([await f.tools.get('feishu_status')!.execute({}, { callId: 'status', signal: new AbortController().signal }), await f.providers[0]!.provide({ signal: new AbortController().signal })]);
  assert.ok(!publicProjection.includes('private-qr')); assert.ok(!publicProjection.includes(secret));
  finish(credentials); await registration; assert.equal(f.secrets.get('appSecret'), secret); assert.equal(f.settings.status().authorization, undefined);
  assert.ok(!JSON.stringify(f.settings.status()).includes(secret)); assert.ok(!JSON.stringify(await f.state()).includes(secret));
});
test('Feishu pairing requires challenge and explicit candidate confirmation; strangers cannot auto-own', async t => {
  const f = await fixture(t); await f.action('connect'); await f.sdk.receive(); assert.equal((await f.state()).owner, null);
  await f.action('pair'); await f.sdk.receive(); await assert.rejects(f.action('confirm'));
  const challenge = f.settings.status().details!.find(item => item.value.startsWith('/mira pair '))!.value;
  await f.sdk.receive(incoming({ text: challenge, chatType: 'group' })); await assert.rejects(f.action('confirm'));
  await f.sdk.receive(incoming({ text: challenge, senderType: 'app' })); await assert.rejects(f.action('confirm'));
  await f.sdk.receive(incoming({ text: challenge })); assert.equal((await f.state()).owner, null); assert.equal(f.wakes.length, 0); assert.equal(f.sdk.sends.length, 0);
  await f.action('confirm'); assert.equal(f.settings.status().state, 'connected'); assert.equal(f.sdk.sends.length, 1);
  for (const overrides of [{ chatType: 'group' as const }, { senderType: 'app' }, { tenantKey: 'other' }, { senderOpenId: 'other' }, { chatId: 'other' }]) await f.sdk.receive(incoming(overrides));
  assert.equal(f.wakes.length, 0);
  await f.sdk.receive(incoming({ messageId: 'accepted', replyToMessageId: 'external-quote', rootMessageId: 'root' }));
  assert.equal(f.wakes.length, 1); assert.equal(f.wakes[0]!.event.type, 'feishu.owner_message');
  assert.equal((f.wakes[0]!.event.payload as Record<string, Json>).ownerVerified, true);
});
test('Feishu duplicate delivery uses exactly the same durable event and Wake identity', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair(); await f.sdk.receive(); await f.sdk.receive();
  assert.ok(f.wakes.length >= 1); for (const wake of f.wakes) assert.deepEqual(wake, f.wakes[0]);
  assert.equal(f.wakes[0]!.id, f.wakes[0]!.event.id);
});
test('Feishu retains failed inbox and replays exact identity after reconnect and restart', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair(); f.failWake(true);
  await assert.rejects(f.sdk.receive()); const pending = (await f.state()).inbox[0]; assert.deepEqual(pending, f.wakes[0]);
  await assert.rejects(f.action('reconnect')); assert.deepEqual(f.wakes[1], pending); assert.equal((await f.state()).inbox.length, 1);
  await f.close(); const reopened = await fixture(t, { directory: f.directory, secrets: f.secrets });
  assert.deepEqual(reopened.wakes, [pending]); assert.deepEqual((await reopened.state()).inbox, []);
});
test('Feishu unknown send is never replayed with same call, conflicting content, reconnect or restart', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  f.sdk.setSend(async () => { throw new Error(`unknown ${secret}`); });
  assert.equal((await f.send('uncertain', 'hello')).status, 'unknown'); const count = f.sdk.sends.length;
  assert.equal((await f.send('uncertain', 'hello')).status, 'unknown'); assert.equal((await f.send('uncertain', 'different')).status, 'not_sent');
  await f.action('reconnect'); assert.equal(f.sdk.sends.length, count);
  await f.close(); const reopened = await fixture(t, { directory: f.directory, secrets: f.secrets });
  assert.equal((await reopened.send('uncertain', 'hello')).status, 'unknown'); assert.equal(reopened.sdk.sends.length, 0);
  assert.ok(!JSON.stringify(await reopened.state()).includes(secret));
});
test('Feishu chunk sends preserve UTF-8 order, quote validation and partial/not-started outcomes', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  assert.equal((await f.send('badquote', 'hello', 'unverified')).status, 'not_sent');
  await f.sdk.receive(); const controller = new AbortController();
  f.sdk.setSend(async () => { controller.abort(); return { messageId: 'first-chunk' }; });
  const text = '你'.repeat(4001); const result = await f.send('chunks', text, 'message-1', controller.signal);
  assert.equal(result.status, 'partial'); assert.equal(result.sentParts, 1); assert.equal(result.totalParts, 3);
  assert.equal(Buffer.byteLength(f.sdk.sends.at(-1)!.text), 6000); assert.equal(f.sdk.sends.at(-1)!.replyToMessageId, 'message-1');
  const receipt = (await f.state()).sends.chunks; assert.deepEqual(receipt.parts.map((part: { status: string }) => part.status), ['sent', 'not_started', 'not_started']);
  const count = f.sdk.sends.length; assert.equal((await f.send('chunks', text, 'message-1')).status, 'partial'); assert.equal(f.sdk.sends.length, count);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.send('cancelled', 'hello', undefined, aborted.signal)); assert.equal((await f.state()).sends.cancelled, undefined);
});
test('Feishu retired callbacks cannot deliver or alter current connection state', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair(); const old = f.sdk.connections[0]!;
  await f.action('reconnect'); old.onState('failed'); assert.equal(f.settings.status().state, 'connected');
  await assert.rejects(old.onMessage(incoming({ messageId: 'retired' })), /Retired/); assert.equal(f.wakes.length, 0);
  await f.close(); await assert.rejects(f.action('test')); assert.equal(f.sdk.connections.at(-1)!.closed, true);
});
test('Feishu registration cancellation retires late QR and credentials', async t => {
  const sdk = fakeSdk(); let options!: FeishuRegistrationOptions; let finish!: (credentials: FeishuCredentials) => void;
  sdk.setRegister(async value => { options = value; return new Promise(resolve => { finish = resolve; }); });
  const f = await fixture(t, { sdk, secrets: new Map() }); const controller = new AbortController(); const registration = f.action('register', controller.signal);
  controller.abort(); options.onQRCode({ url: 'https://accounts.feishu.cn/late', expireIn: 60 }); finish(credentials);
  await assert.rejects(registration, /cancelled/); assert.equal(f.settings.status().authorization, undefined); assert.equal(f.secrets.size, 0); assert.equal(sdk.calls.connect, 0);
});
test('Feishu instances isolate binding, credentials, inbox, sends and unbind', async t => {
  const a = await fixture(t); const b = await fixture(t); await a.action('connect'); await a.pair();
  assert.equal(b.settings.status().state, 'unconfigured'); assert.equal(b.sdk.calls.connect, 0); assert.equal((await b.send('same-call', 'hello')).status, 'not_sent');
  await b.action('connect'); await b.pair(); await a.sdk.receive(); assert.equal(b.wakes.length, 0);
  assert.equal((await a.send('same-call', 'hello')).status, 'sent'); assert.equal((await b.send('same-call', 'different')).status, 'sent');
  await a.action('unbind'); assert.equal(a.secrets.has('appSecret'), false); assert.equal(b.secrets.has('appSecret'), true); assert.equal(b.settings.status().state, 'connected');
});

test('Feishu complete and uncertain multipart delivery preserves content and never resumes later chunks', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  const text = '🦊'.repeat(3001); const before = f.sdk.sends.length;
  assert.equal((await f.send('complete-multipart', text)).status, 'sent');
  const chunks = f.sdk.sends.slice(before); assert.equal(chunks.map(item => item.text).join(''), text);
  assert.ok(chunks.every(item => Buffer.byteLength(item.text) <= 6000)); assert.equal(new Set(chunks.map(item => item.uuid)).size, 3);
  let count = 0; f.sdk.setSend(async () => { if (++count === 2) throw new Error('uncertain second part'); return { messageId: 'first' }; });
  const result = await f.send('unknown-multipart', text); assert.equal(result.status, 'unknown'); assert.equal(result.sentParts, 1); assert.equal(result.totalParts, 3);
  assert.deepEqual((await f.state()).sends['unknown-multipart'].parts.map((part: { status: string }) => part.status), ['sent', 'unknown', 'not_started']);
  await f.send('unknown-multipart', text); assert.equal(count, 2);
});
test('Feishu rejects untrusted QR domain without credential or connection effects', async t => {
  const sdk = fakeSdk(); sdk.setRegister(async options => { options.onQRCode({ url: 'https://feishu.cn.attacker.invalid/authorize', expireIn: 60 }); return credentials; });
  const f = await fixture(t, { sdk, secrets: new Map() }); await assert.rejects(f.action('register'), /not verified/);
  assert.equal(f.secrets.size, 0); assert.equal(sdk.calls.connect, 0); assert.equal(f.settings.status().authorization, undefined);
});
test('Feishu close cancels in-flight registration and ignores late QR callbacks', async t => {
  const sdk = fakeSdk(); let options!: FeishuRegistrationOptions; let finish!: (credentials: FeishuCredentials) => void;
  sdk.setRegister(async value => { options = value; return new Promise(resolve => { finish = resolve; }); });
  const f = await fixture(t, { sdk, secrets: new Map() }); const registration = f.action('register');
  await f.close(); assert.equal(options.signal.aborted, true);
  options.onQRCode({ url: 'https://accounts.feishu.cn/late', expireIn: 60 }); finish(credentials);
  await assert.rejects(registration, /cancelled/); assert.equal(f.secrets.size, 0); assert.equal(sdk.calls.connect, 0); assert.equal(f.settings.status().state, 'disconnected');
});
test('Feishu immutable host identity conflict remains durable rather than accepting altered duplicate', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair(); await f.sdk.receive();
  await assert.rejects(f.sdk.receive(incoming({ text: 'altered duplicate' })), /durable reception failed/);
  assert.equal((await f.state()).inbox.length, 1); assert.equal(f.wakes[0]!.id, f.wakes[1]!.id);
  assert.notDeepEqual(f.wakes[0]!.event.payload, f.wakes[1]!.event.payload);
});

test('QR-created credentials survive verification failure for reconnect without creating another app', async t => {
  const sdk = fakeSdk(); const connect = sdk.sdk.connect; sdk.sdk.connect = async () => { throw new Error('tenant approval pending'); };
  const f = await fixture(t, { sdk, secrets: new Map() });
  await assert.rejects(f.action('register'));
  assert.equal(f.secrets.get('appSecret'), secret); assert.equal((await f.state()).app.appId, credentials.appId);
  assert.equal(sdk.calls.register, 1); assert.equal(sdk.calls.connect, 0);
  sdk.sdk.connect = connect; await f.action('reconnect');
  assert.equal(sdk.calls.register, 1); assert.equal(sdk.calls.connect, 1);
});

test('sourced display is durable and deduped without retrying delivered or unknown sends', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  await f.sdk.receive(); assert.equal(f.wakes[0]!.event.message?.direction, 'inbound');
  assert.equal(f.wakes[0]!.event.message?.senderId, 'user-owner');
  const before = f.events.length; f.failEvent(true);
  assert.equal((await f.send('display-failure', 'confirmed text')).status, 'sent');
  const sends = f.sdk.sends.length; assert.equal(f.events.length, before);
  f.failEvent(false); assert.equal((await f.send('display-failure', 'confirmed text')).status, 'sent');
  assert.equal(f.sdk.sends.length, sends); assert.equal(f.events.length, before + 1);
  assert.equal(f.events.at(-1)!.message?.text, 'confirmed text');
  await f.send('display-failure', 'confirmed text'); assert.equal(f.events.length, before + 1);
  f.sdk.setSend(async () => { throw new Error('unknown transport outcome'); });
  await f.send('display-unknown', 'unknown text'); assert.equal(f.events.length, before + 1);
});

test('confirmed receipt remains truthful while the connection is offline', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  assert.equal((await f.send('confirmed-offline', 'receipt text')).status, 'sent');
  const count = f.sdk.sends.length; f.sdk.connections.at(-1)!.onState('reconnecting');
  assert.equal((await f.send('confirmed-offline', 'receipt text')).status, 'sent');
  assert.equal((await f.send('new-offline', 'new text')).status, 'not_sent');
  assert.equal(f.sdk.sends.length, count);
});

test('restart repairs only confirmed display events and never repeats network sends', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair(); f.failEvent(true);
  assert.equal((await f.send('restart-display', 'saved delivery')).status, 'sent'); await f.close();
  const restarted = await fixture(t, { directory: f.directory, secrets: f.secrets });
  assert.equal(restarted.sdk.sends.length, 0);
  assert.equal(restarted.events.filter(event => event.message?.text === 'saved delivery').length, 1);
  assert.equal((await restarted.send('restart-display', 'saved delivery')).status, 'sent');
  assert.equal(restarted.sdk.sends.length, 0);
});

test('inbound persistence is not blocked by an outstanding outbound HTTP request', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<{ messageId: string }>();
  f.sdk.setSend(async () => { entered.resolve(); return release.promise; });
  const sending = f.send('slow-http', 'slow outgoing'); await entered.promise;
  try {
    await Promise.race([f.sdk.receive(incoming({ messageId: 'while-sending', text: 'received during HTTP' })), new Promise((_, reject) => setTimeout(() => reject(Error('inbound blocked on HTTP')), 500))]);
    assert.equal(f.wakes.at(-1)!.event.message?.text, 'received during HTTP');
    assert.equal((await f.state()).inbox.length, 0);
  } finally { release.resolve({ messageId: 'slow-confirmed' }); }
  assert.equal((await sending).status, 'sent');
  assert.ok((await f.state()).recentMessages.includes('while-sending'));
});

test('unbind drains the outstanding part, stops the tail and never assigns late success to a new binding', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair(); const original = (await f.state()).connectionId;
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<{ messageId: string }>();
  f.sdk.setSend(async () => { entered.resolve(); return release.promise; });
  const sending = f.send('retire-http', 'x'.repeat(7000)); await entered.promise;
  let unbound = false; const unbind = f.action('unbind').then(() => { unbound = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(unbound, false);
  release.resolve({ messageId: 'old-binding-success' }); assert.equal((await sending).status, 'partial'); await unbind;
  assert.notEqual((await f.state()).connectionId, original); assert.equal((await f.state()).app, null);
  const published = f.events.find(event => event.id.startsWith(`sent:${original}:`) && event.message?.text.startsWith('xxx'))!;
  assert.ok(published); assert.equal(f.sdk.sends.filter(send => send.text.startsWith('xxx')).length, 1);
  f.secrets.set('appSecret', secret); await f.action('connect'); assert.equal(f.events.filter(event => event.id === published.id).length, 1);
});

test('close waits for only the in-flight request and preserves unknown instead of publishing late success', async t => {
  const f = await fixture(t); await f.action('connect'); await f.pair();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<{ messageId: string }>();
  f.sdk.setSend(async () => { entered.resolve(); return release.promise; });
  const sending = f.send('close-http', 'x'.repeat(7000)); await entered.promise;
  const close = f.close(); release.resolve({ messageId: 'late-after-close' });
  assert.equal((await sending).status, 'unknown'); await close;
  assert.equal((await f.state()).sends['close-http'].parts[0].status, 'unknown');
  assert.equal(f.events.some(event => event.message?.text.startsWith('xxx')), false);
  assert.equal(f.sdk.sends.filter(send => send.text.startsWith('xxx')).length, 1);
});

test('invalid private state blocks new app registration before any provider request', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'feishu-state.json'), '{"version":99}', { mode: 0o600 });
  const f = await fixture(t, { directory: root, secrets: new Map() });
  assert.equal(f.settings.status().state, 'error'); await assert.rejects(f.action('register'));
  assert.deepEqual(f.sdk.calls, { register: 0, connect: 0, verify: 0 });
});

test('startup inbox replay and newly arriving owner messages use the same state queue', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-startup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const oldWake: ExtensionWake = { id: 'old-id', reason: 'saved before restart', event: { id: 'old-id', type: 'feishu.owner_message', occurredAt: '2026-01-01T00:00:00Z', payload: { text: 'old' } } };
  await writeFile(path.join(root, 'feishu-state.json'), JSON.stringify({ version: 1, connectionId: 'restart-binding', app: { appId: 'app-test', domain: 'feishu' }, owner: { tenantKey: 'tenant-owner', senderOpenId: 'user-owner', chatId: 'chat-owner' }, tested: true, inbox: [oldWake], recentMessages: [], sends: {} }), { mode: 0o600 });
  const sdk = fakeSdk(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const received: ExtensionWake[] = []; let closed: (() => Promise<void> | void) | undefined;
  const context = { id: 'restart', privateDirectory: root, credentials: { get: async () => secret },
    registerSettings() {}, registerTool() {}, registerContextProvider() {}, onCleanup(value: () => Promise<void> | void) { closed = value; },
    async requestWake(wake: ExtensionWake) { received.push(structuredClone(wake)); if (received.length === 1) { entered.resolve(); await release.promise; } return 'inserted'; }, async emitEvent() { return 'inserted'; } };
  const initializing = createFeishuExtension(sdk.sdk).apply({ mira: context as unknown as ExtensionContext }, {});
  await entered.promise; let acknowledged = false;
  const delivery = sdk.receive(incoming({ messageId: 'arrived-during-startup', text: 'new after restart' })).then(() => { acknowledged = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(acknowledged, false, 'new receive must wait behind startup state mutation, never ACK a lost message');
    assert.equal(received.length, 1, 'startup must not have a concurrent inbox flusher');
  } finally { release.resolve(); await initializing; await delivery; await closed?.(); }
  assert.deepEqual(received.map(wake => (wake.event.payload as { text: string }).text), ['old', 'new after restart']);
  const saved = JSON.parse(await readFile(path.join(root, 'feishu-state.json'), 'utf8'));
  assert.equal(saved.inbox.length, 0); assert.ok(saved.recentMessages.includes('arrived-during-startup'));
});
