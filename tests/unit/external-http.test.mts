import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { test, type TestContext } from 'node:test';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createMiraClient, MiraClientError, type ExternalEvent } from '@mira/external-sdk';
import type { LifeEvent, WakeReceipt } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { createLocalHttp, ExternalAccessStore, type ExternalAccessStatus, type WebBackend, type WebSettings } from '@mira/server';
import { createExternalIngress, type ExternalIngress } from '../../apps/server/src/external-ingress.ts';
import { allowLocalTestHttp } from '../deny-model-network.mts';

const token = 'a'.repeat(43);
const senderId = 'fixture-watcher';
const event: ExternalEvent = { id: 'revision-1', type: 'watcher.change', occurredAt: '2026-10-11T18:00:00.000Z', payload: { count: 2 } };
const notification = { id: 'notice-1', occurredAt: event.occurredAt, text: 'Synthetic local notification' };
const credentials = () => ({ senderId, token });
const headers = (port: number) => ({ host: `127.0.0.1:${port}`, 'x-mira-client': 'external', 'x-mira-sender': senderId, authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const settings = (): WebSettings => ({ revision: 'a'.repeat(64), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null });
function backend(): WebBackend {
  return {
    status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null }),
    timeline: async () => ({ items: [], nextCursor: null }),
    submit: async input => ({ id: input.id, receipt: 'inserted' }),
    settings: async () => settings(), saveSettings: async value => value as WebSettings,
    discover: async () => ({ endpoint: 'http://127.0.0.1:1/unused', models: [] }),
  };
}

/** Exact in-memory receipt fixture only. These HTTP tests do not test PostgreSQL,
 * process recovery, a real model, or externally delivered notifications. */
function receiptFixture() {
  const saved = new Map<string, { event: LifeEvent; wake?: WakeReceipt }>();
  const wakes = new Map<string, string>();
  let kicks = 0; let calls = 0;
  const ingress = createExternalIngress({ receive: async (input, wake) => {
    calls++;
    const next = { event: structuredClone(input), ...(wake ? { wake: structuredClone(wake) } : {}) };
    const existing = saved.get(input.id);
    if (existing) {
      if (!isDeepStrictEqual(existing, next)) throw new PersistenceError('duplicate', 'Synthetic immutable receipt conflict');
      return 'duplicate';
    }
    if (wake && wakes.has(wake.id)) throw new PersistenceError('duplicate', 'Synthetic Wake identity conflict');
    saved.set(input.id, next);
    if (wake) wakes.set(wake.id, input.id);
    return 'inserted';
  } }, () => { kicks++; });
  return { ingress, saved, kicks: () => kicks, calls: () => calls };
}

async function unusedPort(): Promise<number> {
  const reserve = net.createServer();
  await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function fixture(t: TestContext, options: { ingress?: ExternalIngress; authenticate?: (sender: string, bearer: string) => Promise<boolean> } = {}) {
  const port = await unusedPort();
  const receipts = receiptFixture();
  const app = createLocalHttp({ backend: backend(), port, external: {
    ingress: options.ingress ?? receipts.ingress,
    access: { authenticate: options.authenticate ?? (async (sender, bearer) => sender === senderId && bearer === token) },
  } });
  await app.listen({ port, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${port}`;
  const revoke = allowLocalTestHttp(origin);
  t.after(async () => { revoke(); await app.close(); });
  return { app, port, origin, receipts };
}
function clientFailure(code: MiraClientError['code'], outcome: MiraClientError['outcome'], status?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MiraClientError);
    assert.equal(error.code, code); assert.equal(error.outcome, outcome);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}
async function rawRequest(port: number, extraHeaders: string[]): Promise<string> {
  const body = JSON.stringify(event);
  return await new Promise<string>((resolve, reject) => {
    // A fixed fixture socket is needed to preserve duplicate raw headers that
    // fetch normalizes. No general HTTP/model request escape is exported.
    const socket = net.connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setTimeout(3_000, () => socket.destroy(Error('Synthetic local request timed out')));
    socket.setEncoding('utf8'); socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject); socket.once('end', () => resolve(response));
    socket.once('connect', () => socket.write([
      'POST /api/external/events HTTP/1.1', ...Object.entries(headers(port)).map(([name, value]) => `${name}: ${value}`),
      ...extraHeaders, `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body,
    ].join('\r\n')));
  });
}

test('offline network guard permits only explicitly registered fixture origins and blocks redirect escapes', async t => {
  for (const origin of ['https://127.0.0.1:4317', 'http://localhost:4317', 'http://127.1:4317', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:04317', 'http://127.0.0.1:4317/', 'http://127.0.0.1:4317/path', 'http://user@127.0.0.1:4317', 'http://127.0.0.1:4317?allow=all']) {
    assert.throws(() => allowLocalTestHttp(origin), /explicit local fixture/);
  }
  let hits = 0;
  const server = http.createServer((request, reply) => {
    hits++;
    if (request.url === '/redirect') { reply.writeHead(302, { location: 'https://invalid.invalid/never' }); reply.end(); }
    else if (request.url === '/local-redirect') { reply.writeHead(302, { location: '/redirect-target' }); reply.end(); }
    else reply.end('fixture only');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  assert.throws(() => fetch(origin), /may not call HTTP/);
  const revoke = allowLocalTestHttp(origin); const revokeSecond = allowLocalTestHttp(origin);
  try {
    for (const url of ['https://invalid.invalid/', 'http://127.0.0.1:1/', `http://localhost:${address.port}/`, `http://127.1:${address.port}/`, `http://127.0.0.1:${address.port}@invalid.invalid/`]) {
      assert.throws(() => fetch(url), /may not call HTTP/);
    }
    const disguised = new Request('https://invalid.invalid/never');
    Object.defineProperty(disguised, 'url', { value: `${origin}/disguised` });
    assert.throws(() => fetch(disguised), /may not call HTTP/);
    for (const request of [() => http.request(origin), () => http.get(origin), () => https.request('https://invalid.invalid'), () => https.get('https://invalid.invalid')]) assert.throws(request, /may not call HTTP/);
    assert.equal(await (await fetch(`${origin}/ok`)).text(), 'fixture only');
    assert.equal(await (await fetch(new Request(`${origin}/request`))).text(), 'fixture only');
    await assert.rejects(fetch(`${origin}/redirect`, { redirect: 'follow' }));
    await assert.rejects(fetch(`${origin}/local-redirect`, { redirect: 'follow' }));
    assert.equal(hits, 4, 'redirect destinations must never be requested');
    revoke(); revoke();
    assert.equal(await (await fetch(`${origin}/still-registered`)).text(), 'fixture only');
  } finally { revoke(); revokeSecond(); }
  assert.throws(() => fetch(origin), /may not call HTTP/);
});

test('real SDK and HTTP listener preserve external provenance and separate Event, Wake and notification receipts', async t => {
  const f = await fixture(t);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createMiraClient({ baseUrl: f.origin, credentials, fetch: (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) }); return fetch(url, init);
  } });
  const payload = { source: 'user', senderId: 'spoofed-owner', approved: true, count: 2 };
  const input = { ...event, payload };
  assert.deepEqual(await client.emitEvent(input), { operation: 'event', id: event.id, receipt: 'inserted', durability: 'persisted' });
  assert.equal(f.receipts.kicks(), 0);
  assert.deepEqual(await client.emitEvent(input), { operation: 'event', id: event.id, receipt: 'duplicate', durability: 'persisted' });
  assert.equal(f.receipts.saved.size, 1);
  const persisted = f.receipts.saved.get(JSON.stringify(['external', senderId, event.id])); assert.ok(persisted);
  assert.deepEqual(persisted, { event: {
    id: JSON.stringify(['external', senderId, event.id]), type: event.type, source: 'external', occurredAt: event.occurredAt,
    payload: { senderId, operation: 'event', eventId: event.id, data: payload },
  } });
  const wake = { id: 'wake-1', reason: 'A synthetic matching change', event: { ...event, id: 'wake-event-1' } };
  assert.deepEqual(await client.requestWake(wake), { operation: 'wake', id: wake.id, eventId: wake.event.id, receipt: 'inserted', durability: 'persisted' });
  assert.equal(f.receipts.kicks(), 1);
  assert.equal((await client.requestWake(wake)).receipt, 'duplicate'); assert.equal(f.receipts.kicks(), 1);
  assert.deepEqual(await client.sendNotification(notification), { operation: 'notification', id: notification.id, receipt: 'inserted', durability: 'persisted' });
  assert.equal((await client.sendNotification(notification)).receipt, 'duplicate'); assert.equal(f.receipts.kicks(), 1);
  assert.equal(f.receipts.saved.size, 3);
  assert.deepEqual(f.receipts.saved.get(JSON.stringify(['external-notification', senderId, notification.id])), { event: {
    id: JSON.stringify(['external-notification', senderId, notification.id]), source: 'external', type: 'external.notification', occurredAt: notification.occurredAt,
    payload: { senderId, operation: 'notification', notificationId: notification.id, text: notification.text },
  } });
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST'); assert.equal(call.init?.redirect, 'error'); assert.equal(call.init?.credentials, 'omit');
    const sent = new Headers(call.init?.headers);
    assert.equal(sent.get('x-mira-client'), 'external'); assert.equal(sent.get('x-mira-sender'), senderId);
    assert.equal(sent.get('authorization'), `Bearer ${token}`); assert.equal(sent.get('origin'), null);
  }
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/external/events', '/api/external/events', '/api/external/wake', '/api/external/wake', '/api/external/notifications', '/api/external/notifications']);
});

test('authenticated sender identities isolate equal caller IDs and cannot impersonate each other', async t => {
  const secondSender = 'fixture-second'; const secondToken = 'c'.repeat(43);
  const allowed = new Map([[senderId, token], [secondSender, secondToken]]);
  const f = await fixture(t, { authenticate: async (sender, bearer) => allowed.get(sender) === bearer });
  const first = createMiraClient({ baseUrl: f.origin, credentials });
  const second = createMiraClient({ baseUrl: f.origin, credentials: () => ({ senderId: secondSender, token: secondToken }) });
  const spoofed = createMiraClient({ baseUrl: f.origin, credentials: () => ({ senderId: secondSender, token }) });
  assert.equal((await first.emitEvent(event)).receipt, 'inserted');
  assert.equal((await second.emitEvent(event)).receipt, 'inserted');
  assert.equal((await first.emitEvent(event)).receipt, 'duplicate');
  assert.equal((await second.emitEvent(event)).receipt, 'duplicate');
  await assert.rejects(spoofed.emitEvent(event), clientFailure('http_error', 'rejected', 401));
  assert.deepEqual([...f.receipts.saved.keys()], [JSON.stringify(['external', senderId, event.id]), JSON.stringify(['external', secondSender, event.id])]);
  assert.equal(f.receipts.calls(), 4); assert.equal(f.receipts.kicks(), 0);
});

test('lost real HTTP response is unknown, never automatically retried, and exact caller retry recovers one Wake receipt', async t => {
  const f = await fixture(t); const bodies: string[] = []; let loseResponse = true;
  const client = createMiraClient({ baseUrl: f.origin, credentials, fetch: async (url, init) => {
    bodies.push(String(init?.body));
    const response = await fetch(url, init);
    if (loseResponse) { loseResponse = false; await response.arrayBuffer(); throw Error(`Synthetic lost response ${token}`); }
    return response;
  } });
  const wake = { id: 'uncertain-wake-1', reason: 'Exact original reason', event };
  await assert.rejects(client.requestWake(wake), clientFailure('network_error', 'unknown'));
  assert.equal(bodies.length, 1); assert.equal(f.receipts.saved.size, 1); assert.equal(f.receipts.kicks(), 1);
  assert.deepEqual(await client.requestWake(wake), { operation: 'wake', id: wake.id, eventId: event.id, receipt: 'duplicate', durability: 'persisted' });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(f.receipts.kicks(), 1);
  assert.equal(f.receipts.saved.size, 1);
  await assert.rejects(client.requestWake({ ...wake, reason: 'Changed retry is a conflict' }), clientFailure('http_error', 'rejected', 409));
  assert.equal(f.receipts.kicks(), 1);
});

test('credentials reload on every real HTTP call and rotation/revocation never changes sender receipt scope', async t => {
  let accepted: string | null = token; let supplied = token; let loads = 0;
  const f = await fixture(t, { authenticate: async (sender, bearer) => sender === senderId && bearer === accepted });
  const client = createMiraClient({ baseUrl: f.origin, credentials: () => { loads++; return { senderId, token: supplied }; } });
  assert.equal((await client.emitEvent(event)).receipt, 'inserted');
  accepted = 'b'.repeat(43);
  await assert.rejects(client.emitEvent(event), clientFailure('http_error', 'rejected', 401));
  assert.equal(f.receipts.calls(), 1);
  supplied = accepted;
  assert.equal((await client.emitEvent(event)).receipt, 'duplicate');
  accepted = null;
  await assert.rejects(client.emitEvent({ ...event, id: 'revoked-event' }), clientFailure('http_error', 'rejected', 401));
  assert.equal(loads, 4); assert.equal(f.receipts.calls(), 2); assert.equal(f.receipts.saved.size, 1); assert.equal(f.receipts.kicks(), 0);
});

test('actual access CLI, private credential files, HTTP server and SDK compose without restart or extra Wake', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-external-http-'));
  const home = path.join(directory, 'home');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const store = new ExternalAccessStore({ miraHome: home, sourceDirectory: root });
  const f = await fixture(t, { authenticate: store.authenticate.bind(store) });
  const outputs: string[] = [];
  const execute = promisify(execFile);
  const command = async (operation: string, sender?: string): Promise<ExternalAccessStatus> => {
    const { stdout, stderr } = await execute(process.execPath, [
      path.join(root, 'apps/server/src/external-access-cli.mts'), operation, '--home', home,
      ...(sender ? ['--id', sender] : []),
    ], {
      timeout: 8_000,
      env: { PATH: process.env['PATH'], HOME: directory, NODE_OPTIONS: `--import=${path.join(root, 'tests/deny-model-network.mts')}` },
    });
    outputs.push(stdout, stderr); assert.equal(stderr, '');
    assert.ok(!stdout.includes('"token"'));
    return JSON.parse(stdout) as ExternalAccessStatus;
  };
  assert.equal((await command('status')).enabled, false);
  const unconfigured = createMiraClient({ baseUrl: f.origin, credentials });
  await assert.rejects(unconfigured.emitEvent(event), clientFailure('http_error', 'rejected', 401));
  const created = await command('create', senderId);
  assert.equal(created.enabled, false); assert.equal(created.sender?.state, 'active'); assert.ok(created.sender);
  let loads = 0;
  const load = async () => {
    loads++;
    const privateFile = JSON.parse(await readFile(created.sender!.credentialFile, 'utf8')) as { id: string; token: string };
    return { senderId: privateFile.id, token: privateFile.token };
  };
  // The SDK callback reads this disposable private file on each request. No
  // credential is passed on a command line, through environment, or to a model.
  const dynamic = createMiraClient({ baseUrl: f.origin, credentials: load });
  await assert.rejects(dynamic.emitEvent(event), clientFailure('http_error', 'rejected', 401));
  assert.equal(f.receipts.calls(), 0); assert.equal(f.receipts.kicks(), 0);
  const original = await load();
  const stale = createMiraClient({ baseUrl: f.origin, credentials: () => original });
  assert.equal((await command('enable')).enabled, true);
  assert.equal((await dynamic.emitEvent(event)).receipt, 'inserted');
  assert.equal((await command('rotate', senderId)).sender?.state, 'active');
  await assert.rejects(stale.emitEvent(event), clientFailure('http_error', 'rejected', 401));
  const rotated = await load(); assert.ok(original.token !== rotated.token);
  assert.equal((await dynamic.emitEvent(event)).receipt, 'duplicate');
  const cached = createMiraClient({ baseUrl: f.origin, credentials: () => rotated });
  assert.equal((await command('revoke', senderId)).sender?.state, 'revoked');
  await assert.rejects(cached.emitEvent({ ...event, id: 'revoked-at-http' }), clientFailure('http_error', 'rejected', 401));
  await assert.rejects(dynamic.emitEvent(event), clientFailure('credentials_unavailable', 'not_sent'));
  assert.equal(f.receipts.calls(), 2); assert.equal(f.receipts.saved.size, 1); assert.equal(f.receipts.kicks(), 0);
  assert.equal(loads, 6);
  await writeFile(store.accessFile, '{"synthetic-private-marker":', { mode: 0o600 });
  const broken = await fetch(`${f.origin}/api/external/events`, {
    method: 'POST', headers: { ...headers(f.port), authorization: `Bearer ${rotated.token}` }, body: JSON.stringify(event),
  });
  assert.equal(broken.status, 401);
  const body = await broken.text();
  assert.ok(!body.includes('synthetic-private-marker')); assert.ok(!body.includes(home));
  for (const output of [...outputs, body]) {
    assert.ok(!output.includes(original.token)); assert.ok(!output.includes(rotated.token));
  }
  assert.equal(f.receipts.calls(), 2); assert.equal(f.receipts.kicks(), 0);
});

test('external endpoints are disabled by default and preserve original web Origin and parser protections', async t => {
  const port = 4317;
  const closed = createLocalHttp({ backend: backend(), port }); t.after(() => closed.close());
  for (const url of ['/api/external/events', '/api/external/wake', '/api/external/notifications']) {
    assert.equal((await closed.inject({ method: 'POST', url, headers: headers(port), payload: event })).statusCode, 404);
  }
  const f = await fixture(t);
  const web = { host: `127.0.0.1:${f.port}`, 'x-mira-client': 'web', 'content-type': 'application/json' };
  const message = { id: 'message-1', text: 'Synthetic user message', occurredAt: event.occurredAt };
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/messages', headers: web, payload: message })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/messages', headers: { ...web, origin: f.origin }, payload: message })).statusCode, 201);
  for (const payload of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}']) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/messages', headers: { ...web, origin: f.origin }, payload })).statusCode, 400);
  }
  assert.equal((await f.app.inject({ url: '/api/settings', headers: headers(f.port) })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/external/events', headers: { ...web, origin: f.origin }, payload: event })).statusCode, 403);
});

test('external HTTP rejects host aliases, browser metadata, duplicate raw credentials and invalid authentication before ingress', async t => {
  let authentications = 0;
  const f = await fixture(t, { authenticate: async (sender, bearer) => { authentications++; return sender === senderId && bearer === token; } });
  for (const host of ['localhost:' + f.port, '127.0.0.1', '127.0.0.1:1', '[::1]:' + f.port, 'evil.example:' + f.port, `127.0.0.1:${f.port}, evil.example`]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/external/events', headers: { ...headers(f.port), host }, payload: event })).statusCode, 403);
  }
  for (const extra of [
    { origin: f.origin }, { origin: 'null' }, { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'document' }, { 'sec-fetch-mode': 'same-origin' }, { 'sec-fetch-mode': 'no-cors' },
    { 'x-mira-client': 'web' }, { 'x-mira-client': 'external, external' },
  ]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/external/events', headers: { ...headers(f.port), ...extra }, payload: event })).statusCode, 403, JSON.stringify(extra));
  }
  for (const duplicate of [`Host: 127.0.0.1:${f.port}`, `Authorization: Bearer ${token}`, `X-Mira-Sender: ${senderId}`, 'X-Mira-Client: external']) {
    const response = await rawRequest(f.port, [duplicate]);
    assert.match(response, /^HTTP\/1\.1 (?:400|403) /, duplicate);
    assert.ok(!response.includes(token));
  }
  assert.equal(authentications, 0); assert.equal(f.receipts.calls(), 0);
  for (const extra of [
    { authorization: '' }, { authorization: 'Basic synthetic' }, { authorization: `Bearer ${'a'.repeat(42)}` },
    { authorization: `Bearer ${'a'.repeat(44)}` }, { authorization: `Bearer ${'b'.repeat(43)}` },
    { 'x-mira-sender': '' }, { 'x-mira-sender': 'not a sender' }, { 'x-mira-sender': 'other-sender' },
  ]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/external/events', headers: { ...headers(f.port), ...extra }, payload: event });
    assert.equal(response.statusCode, 401); assert.ok(!response.body.includes(token));
  }
  assert.equal(f.receipts.calls(), 0);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/external/events', headers: { ...headers(f.port), 'sec-fetch-mode': 'cors' }, payload: event })).statusCode, 201);
});

test('external HTTP validates envelopes, methods, content types, queries and byte limits without reflecting inputs', async t => {
  const f = await fixture(t); const secret = 'synthetic-raw-input-private';
  const post = (payload: unknown, url = '/api/external/events') => f.app.inject({ method: 'POST', url, headers: headers(f.port), payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  for (const payload of [
    null, [], {}, { ...event, source: 'user' }, { ...event, senderId: 'spoofed' }, { ...event, wake: true }, { ...event, id: 1 },
    { ...event, occurredAt: '2026-02-31T00:00:00.000Z' }, { ...event, type: '' }, { ...event, payload: undefined },
    `{"id":"${secret}",`, `{"__proto__":{"${secret}":true}}`,
  ]) {
    const response = await post(payload); assert.equal(response.statusCode, 400); assert.ok(!response.body.includes(secret));
  }
  assert.equal((await post({ id: 'wake-1', reason: 'Reason', event, source: 'user' }, '/api/external/wake')).statusCode, 400);
  assert.equal((await post({ ...notification, source: 'user' }, '/api/external/notifications')).statusCode, 400);
  for (const url of ['/api/external/events?extra=secret', '/api/external/wake?id=a&id=b', '/api/external/notifications?source=user', '/api/external/%65vents']) {
    assert.equal((await post(event, url)).statusCode, 400);
  }
  for (const contentType of ['text/plain', 'application/json-patch+json', 'application/json; charset=latin1']) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/external/events', headers: { ...headers(f.port), 'content-type': contentType }, payload: JSON.stringify(event) })).statusCode, 415);
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const response = await f.app.inject({ method, url: '/api/external/events', headers: headers(f.port) });
    assert.equal(response.statusCode, 405); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const payload of [' '.repeat(65_537), JSON.stringify({ ...event, payload: '界'.repeat(22_000) })]) assert.equal((await post(payload)).statusCode, 413);
  assert.equal(f.receipts.calls(), 0);
  const exact = { ...event, payload: '' };
  exact.payload = 'a'.repeat(65_536 - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65_536);
  assert.equal((await post(exact)).statusCode, 201);
  assert.equal((await post({ ...exact, payload: exact.payload + 'a' })).statusCode, 413);
});

test('scoped JSON parser safely preserves prototype-like payload keys across the real HTTP SDK', async t => {
  const f = await fixture(t); const client = createMiraClient({ baseUrl: f.origin, credentials });
  const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"value":"ordinary data"}}');
  assert.equal((await client.emitEvent({ ...event, payload })).receipt, 'inserted');
  const saved = f.receipts.saved.values().next().value;
  assert.ok(saved); const envelope = saved.event.payload as { data: Record<string, unknown> };
  assert.equal(Object.getPrototypeOf(envelope.data), Object.prototype);
  assert.ok(Object.hasOwn(envelope.data, '__proto__')); assert.ok(Object.hasOwn(envelope.data, 'constructor'));
  assert.deepEqual(envelope.data, payload);
  assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'), undefined);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('immutable event conflicts, event-to-Wake upgrades and notification changes return 409 without extra Wake', async t => {
  const f = await fixture(t); const client = createMiraClient({ baseUrl: f.origin, credentials });
  await client.emitEvent(event);
  await assert.rejects(client.emitEvent({ ...event, payload: { count: 3 } }), clientFailure('http_error', 'rejected', 409));
  await assert.rejects(client.requestWake({ id: 'upgrade', reason: 'Cannot upgrade an existing quiet event', event }), clientFailure('http_error', 'rejected', 409));
  await client.sendNotification(notification);
  await assert.rejects(client.sendNotification({ ...notification, text: 'Changed notice' }), clientFailure('http_error', 'rejected', 409));
  assert.equal(f.receipts.saved.size, 2); assert.equal(f.receipts.kicks(), 0);
});

test('authentication and ingress errors stay redacted on HTTP and SDK boundaries', async t => {
  const secret = `synthetic-private-path authorization ${token}`;
  const unavailable = await fixture(t, { authenticate: async () => { throw Error(secret); } });
  const response = await fetch(`${unavailable.origin}/api/external/events`, { method: 'POST', headers: headers(unavailable.port), body: JSON.stringify(event) });
  assert.equal(response.status, 503); const text = await response.text(); assert.ok(!text.includes(secret)); assert.ok(!text.includes(token));
  assert.equal(unavailable.receipts.calls(), 0);
  const throwing: ExternalIngress = {
    emitEvent: async () => { throw Error(secret); }, requestWake: async () => { throw Error(secret); }, sendNotification: async () => { throw Error(secret); },
  };
  const failing = await fixture(t, { ingress: throwing });
  const client = createMiraClient({ baseUrl: failing.origin, credentials });
  for (const operation of [() => client.emitEvent(event), () => client.requestWake({ id: 'error-wake', reason: 'Synthetic', event }), () => client.sendNotification(notification)]) {
    await assert.rejects(operation(), error => {
      assert.ok(error instanceof MiraClientError); assert.equal(error.code, 'http_error'); assert.equal(error.outcome, 'unknown'); assert.equal(error.status, 500);
      assert.ok(!String(error).includes(token)); assert.ok(!JSON.stringify(error).includes(secret)); assert.equal(error.cause, undefined); return true;
    });
  }
  const raw = await failing.app.inject({ method: 'POST', url: '/api/external/events', headers: headers(failing.port), payload: event });
  assert.equal(raw.statusCode, 500); assert.ok(!raw.body.includes(secret)); assert.ok(!raw.body.includes(token)); assert.ok(!raw.body.includes('stack'));
  assert.equal(raw.headers['cache-control'], 'private, no-store'); assert.equal(raw.headers['access-control-allow-origin'], undefined);
});
