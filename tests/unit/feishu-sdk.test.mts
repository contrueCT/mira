import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeishuSdk, FEISHU_REQUIRED_SCOPES, parseFeishuMessage } from '../../packages/feishu-channel/src/sdk.ts';
import type { FeishuConnectionState, FeishuCredentials, FeishuHttpInstance, FeishuSdkDependencies, FeishuWsOptions, FeishuWsTransport } from '../../packages/feishu-channel/src/sdk.ts';

const credentials: FeishuCredentials = { appId: 'cli_synthetic', appSecret: 'synthetic-never-real', domain: 'feishu' };
type Request = { url?: string; method?: string; data?: unknown; params?: unknown; timeout?: number };
function transport(respond: (request: Request) => unknown | Promise<unknown>) {
  const calls: Request[] = [];
  const run = async (request: Request) => { calls.push(request); return respond(request); };
  const http = {
    request: run,
    post: (url: string, data: unknown, options: Request = {}) => run({ ...options, url, data, method: 'POST' }),
    get: (url: string, options: Request = {}) => run({ ...options, url, method: 'GET' }),
    put: () => assert.fail('unexpected PUT'), patch: () => assert.fail('unexpected PATCH'),
    delete: () => assert.fail('unexpected DELETE'), head: () => assert.fail('unexpected HEAD'), options: () => assert.fail('unexpected OPTIONS'),
  } as FeishuHttpInstance;
  return { calls, http };
}
function good(request: Request): unknown {
  if (request.url?.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 };
  if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'ou_bot' } };
  if (request.url?.endsWith('/application/v6/scopes')) return { code: 0, data: { scopes: FEISHU_REQUIRED_SCOPES.map(scope_name => ({ scope_name, grant_status: 1, scope_type: 'tenant' })) } };
  if (request.url?.includes('/im/v1/messages')) return { code: 0, data: { message_id: 'om_sent' } };
  assert.fail(`unexpected synthetic request ${request.url}`);
}
function raw(overrides: Record<string, unknown> = {}) {
  return { tenant_key: 'tenant_header', sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner', user_id: 'wrong-id' }, tenant_key: 'tenant_owner' }, message: {
    message_id: 'om_in', chat_id: 'oc_chat', chat_type: 'p2p', create_time: '1000', message_type: 'text', content: JSON.stringify({ text: 'hello' }), parent_id: 'om_quote', root_id: 'om_root', ...overrides,
  } };
}
function socketFixture(ready = true) {
  let options: FeishuWsOptions;
  let dispatcher: Parameters<FeishuWsTransport['start']>[0]['eventDispatcher'];
  let closed = false;
  const createWebSocket = (value: FeishuWsOptions): FeishuWsTransport => {
    options = value;
    return { async start(value) { dispatcher = value.eventDispatcher; if (ready) queueMicrotask(() => options.onReady?.()); }, close() { closed = true; }, getConnectionStatus() { return { state: ready && !closed ? 'connected' : 'connecting', reconnectAttempts: 0 }; } };
  };
  return { createWebSocket, get closed() { return closed; }, get options() { return options; }, async deliver(payload: unknown) {
    assert.ok(dispatcher);
    return dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: payload }, { needCheck: false });
  } };
}

test('Feishu registration uses official minimal options and never treats QR creation as verification', async () => {
  const abort = new AbortController(); const statuses: string[] = []; const qr: string[] = [];
  const register: NonNullable<FeishuSdkDependencies['registerApp']> = async options => {
    assert.equal(options.addons?.preset, false); assert.equal(options.createOnly, true);
    assert.deepEqual(options.addons?.scopes?.tenant, [...FEISHU_REQUIRED_SCOPES]);
    assert.deepEqual(options.addons?.events?.items?.tenant, ['im.message.receive_v1']);
    assert.equal(options.domain, 'accounts.larksuite.com'); assert.equal(options.signal, abort.signal);
    options.onQRCodeReady({ url: 'https://accounts.larksuite.com/synthetic', expireIn: 60 });
    options.onStatusChange?.({ status: 'polling' });
    return { client_id: 'cli_new', client_secret: 'synthetic', user_info: { open_id: 'ou_admin', tenant_brand: 'lark' } };
  };
  const sdk = createFeishuSdk({ registerApp: register });
  assert.deepEqual(await sdk.register({ domain: 'lark', signal: abort.signal, onQRCode: value => qr.push(value.url), onStatus: value => statuses.push(value) }), { appId: 'cli_new', appSecret: 'synthetic', ownerOpenId: 'ou_admin', domain: 'lark' });
  assert.equal(qr.length, 1); assert.deepEqual(statuses, ['polling']);
  abort.abort(); await assert.rejects(sdk.register({ domain: 'feishu', signal: abort.signal, onQRCode() { assert.fail(); }, onStatus() {} }), /registration_failed/);
});

test('real SDK verification checks bot identity and actual granted tenant scopes on selected domain', async () => {
  const { http, calls } = transport(good); const sdk = createFeishuSdk({ httpInstance: http });
  assert.deepEqual(await sdk.verify({ ...credentials, domain: 'lark' }), { botOpenId: 'ou_bot', scopes: [...FEISHU_REQUIRED_SCOPES] });
  assert.ok(calls.every(call => call.url?.startsWith('https://open.larksuite.com/')));
  assert.ok(calls.every(call => call.timeout === 15_000));
  const denied = transport(request => request.url?.endsWith('/application/v6/scopes') ? { code: 0, data: { scopes: FEISHU_REQUIRED_SCOPES.map(scope_name => ({ scope_name, grant_status: 2 })) } } : good(request));
  await assert.rejects(createFeishuSdk({ httpInstance: denied.http }).verify(credentials), /verification_failed/);
  for (const scope_type of [undefined, 'user']) {
    const ambiguous = transport(request => request.url?.endsWith('/application/v6/scopes') ? { code: 0, data: { scopes: FEISHU_REQUIRED_SCOPES.map(scope_name => ({ scope_name, grant_status: 1, scope_type })) } } : good(request));
    await assert.rejects(createFeishuSdk({ httpInstance: ambiguous.http }).verify(credentials), /verification_failed/);
  }
  const missingBot = transport(request => request.url?.endsWith('/bot/v3/info') ? { code: 0, bot: {} } : good(request));
  await assert.rejects(createFeishuSdk({ httpInstance: missingBot.http }).verify(credentials), /verification_failed/);
});

test('real SDK outbound is one text create or reply, preserving uuid and no automatic fallback', async () => {
  const { http, calls } = transport(good); const sdk = createFeishuSdk({ httpInstance: http });
  await sdk.send(credentials, { chatId: 'oc_chat', text: 'hello', uuid: 'stable-uuid' });
  await sdk.send(credentials, { chatId: 'oc_chat', text: 'reply', uuid: 'reply-uuid', replyToMessageId: 'om_quote' });
  const sends = calls.filter(call => call.url?.includes('/im/v1/messages'));
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0]?.data, { msg_type: 'text', content: '{"text":"hello"}', uuid: 'stable-uuid', receive_id: 'oc_chat' });
  assert.deepEqual(sends[0]?.params, { receive_id_type: 'chat_id' });
  assert.ok(sends[1]?.url?.endsWith('/om_quote/reply'));
  assert.deepEqual(sends[1]?.data, { msg_type: 'text', content: '{"text":"reply"}', uuid: 'reply-uuid' });
  const uncertain = transport(request => { if (request.url?.includes('/im/v1/messages')) throw new Error('secret raw upstream failure'); return good(request); });
  await assert.rejects(createFeishuSdk({ httpInstance: uncertain.http }).send(credentials, { chatId: 'oc_chat', text: 'x', uuid: 'unknown', replyToMessageId: 'om_quote' }), error => error instanceof Error && error.message === 'Feishu send_unknown' && !('cause' in error));
  assert.equal(uncertain.calls.filter(call => call.url?.includes('/im/v1/messages')).length, 1);
});

test('raw message projection preserves actual IDs, quote, old timestamp and unsupported marker', () => {
  assert.deepEqual(parseFeishuMessage(raw()), { messageId: 'om_in', chatId: 'oc_chat', chatType: 'p2p', senderOpenId: 'ou_owner', senderType: 'user', tenantKey: 'tenant_owner', createdAt: '1970-01-01T00:00:01.000Z', text: 'hello', messageType: 'text', replyToMessageId: 'om_quote', rootMessageId: 'om_root' });
  assert.match(parseFeishuMessage(raw({ message_type: 'image', content: '{"image_key":"not-fetched"}' })).text, /Unsupported/);
  assert.throws(() => parseFeishuMessage(raw({ content: 'malformed' })), /receive_failed/);
  assert.throws(() => parseFeishuMessage({ ...raw(), sender: { sender_id: { user_id: 'must-not-substitute' } } }), /receive_failed/);
});

test('official EventDispatcher awaits durable receive, retains duplicates and never batches', async () => {
  const { http } = transport(good); const socket = socketFixture(); const states: FeishuConnectionState[] = []; const received: string[] = [];
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const connection = await createFeishuSdk({ httpInstance: http, createWebSocket: socket.createWebSocket }).connect(credentials, { onState: state => states.push(state), async onMessage(message) { received.push(message.text); await gate; } });
  let acknowledged = false; const delivery = socket.deliver(raw()).then(() => { acknowledged = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acknowledged, false); finish(); await delivery;
  await socket.deliver(raw()); assert.deepEqual(received, ['hello', 'hello']); assert.equal(connection.state(), 'connected');
  await connection.close(); assert.equal(socket.closed, true); assert.equal(connection.state(), 'closed'); assert.deepEqual(states, ['connecting', 'connected', 'closed']);
});

test('durable failure propagates through real dispatcher, marks failure and stops ingress without dedup', async () => {
  const { http } = transport(good); const socket = socketFixture(); const states: FeishuConnectionState[] = [];
  const connection = await createFeishuSdk({ httpInstance: http, createWebSocket: socket.createWebSocket }).connect(credentials, { onState: state => states.push(state), async onMessage() { throw new Error('private database secret'); } });
  await assert.rejects(socket.deliver(raw()), /receive_failed/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(socket.closed, true); assert.equal(connection.state(), 'receive_failed');
  await assert.rejects(socket.deliver(raw()), /receive_failed/); assert.ok(states.includes('receive_failed'));
  await connection.close();
});

test('connection never succeeds before real ready status and closes timed-out attempts', async () => {
  const { http } = transport(good); const socket = socketFixture(false); const states: FeishuConnectionState[] = [];
  await assert.rejects(createFeishuSdk({ httpInstance: http, createWebSocket: socket.createWebSocket, connectTimeoutMs: 10 }).connect(credentials, { onState: state => states.push(state), async onMessage() {} }), /connection_failed/);
  assert.equal(socket.closed, true); assert.deepEqual(states, ['connecting', 'failed']);
});


test('registration rejects an unexpected returned tenant brand instead of silently changing domain', async () => {
  const sdk = createFeishuSdk({ registerApp: async () => ({ client_id: 'cli_other', client_secret: 'synthetic', user_info: { tenant_brand: 'lark' } }) });
  await assert.rejects(sdk.register({ domain: 'feishu', signal: new AbortController().signal, onQRCode() {}, onStatus() {} }), /registration_failed/);
});

test('real SDK token-invalid and deleted-reply API results never replay the effectful request', async () => {
  for (const code of [99991663, 230011]) {
    const fixture = transport(request => request.url?.includes('/im/v1/messages') ? { code, msg: 'synthetic rejection' } : good(request));
    await assert.rejects(createFeishuSdk({ httpInstance: fixture.http }).send(credentials, { chatId: 'oc_chat', text: 'x', uuid: 'stable', replyToMessageId: 'om_deleted' }), /send_unknown/);
    assert.equal(fixture.calls.filter(call => call.url?.includes('/im/v1/messages')).length, 1);
  }
});

test('SDK retry callback order restores ready only after the SDK clears its connecting flag', async () => {
  const { http } = transport(good);
  let options!: FeishuWsOptions;
  let actual: 'connecting' | 'reconnecting' | 'connected' = 'connecting';
  let closed = false;
  const states: FeishuConnectionState[] = [];
  const createWebSocket = (value: FeishuWsOptions): FeishuWsTransport => {
    options = value;
    return { async start() {
      actual = 'reconnecting'; options.onReady?.(); actual = 'connected';
    }, close() { closed = true; }, getConnectionStatus() { return { state: actual, reconnectAttempts: 1 }; } };
  };
  const connection = await createFeishuSdk({ httpInstance: http, createWebSocket }).connect(credentials, { onState: state => states.push(state), async onMessage() {} });
  assert.equal(closed, false); assert.equal(connection.state(), 'connected');
  actual = 'reconnecting'; options.onReconnecting?.(); options.onReconnected?.(); actual = 'connected';
  await new Promise<void>(resolve => queueMicrotask(resolve));
  assert.equal(connection.state(), 'connected'); assert.deepEqual(states, ['connecting', 'connected', 'reconnecting', 'connected']);
  await connection.close();
});

test('pending inbound handlers cannot overwrite closed state after explicit shutdown', async () => {
  for (const fails of [false, true]) {
    const { http } = transport(good); const socket = socketFixture(); const states: FeishuConnectionState[] = [];
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const connection = await createFeishuSdk({ httpInstance: http, createWebSocket: socket.createWebSocket }).connect(credentials, { onState: state => states.push(state), async onMessage() { await gate; if (fails) throw Error('synthetic receiver failure'); } });
    const delivery = socket.deliver(raw({ message_type: 'image' }));
    const observed = fails ? assert.rejects(delivery, /receive_failed/) : delivery;
    await new Promise(resolve => setImmediate(resolve)); await connection.close(); finish(); await observed;
    assert.equal(connection.state(), 'closed'); assert.deepEqual(states, ['connecting', 'connected', 'closed']);
  }
});


test('registration preserves only safe expiry/denial classifications and never raw provider errors', async () => {
  for (const [provider, expected] of [['expired_token', 'registration_expired'], ['access_denied', 'registration_denied'], ['unknown', 'registration_failed']]) {
    const sdk = createFeishuSdk({ registerApp: async () => { throw { code: provider, description: 'synthetic-secret-never-project' }; } });
    await assert.rejects(sdk.register({ domain: 'feishu', signal: new AbortController().signal, onQRCode() {}, onStatus() {} }), error => error instanceof Error && error.message === `Feishu ${expected}`);
  }
});
