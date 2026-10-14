import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebAccessAuth, createLocalHttp, type WebBackend } from '@mira/server';
import { webListenHost, webPublicOrigin } from '../../apps/server/src/web-config.ts';
const port = 4327; const origin = `http://127.0.0.1:${port}`;
const headers = { host: `127.0.0.1:${port}`, origin, 'x-mira-client': 'web', 'content-type': 'application/json' };
const password = 'synthetic-only-password';
const backend: WebBackend = {
  status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null }),
  timeline: async () => ({ items: [], nextCursor: null }), submit: async input => ({ id: input.id, receipt: 'inserted' }),
  settings: async () => ({ revision: 'a'.repeat(64), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null }),
  saveSettings: async () => { throw Error('not used'); }, discover: async () => { throw Error('not used'); },
};
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, publicOrigin?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-web-auth-'));
  const options = { miraHome: root, sourceDirectory: process.cwd() };
  const auth = await WebAccessAuth.open(options);
  const app = createLocalHttp({ backend, port, auth, ...(publicOrigin ? { publicOrigin } : {}) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, auth, app, options };
}
function cookie(value: string | string[] | undefined): string { assert.equal(typeof value, 'string'); return (value as string).split(';', 1)[0]!; }

test('optional auth persists only salted password hash and protects every private API including attachments', async t => {
  const { auth, app, root } = await fixture(t);
  assert.deepEqual((await app.inject({ url: '/api/auth/status', headers })).json(), { enabled: false, authenticated: true });
  assert.equal((await app.inject({ url: '/api/status', headers })).statusCode, 200);
  const enabled = await app.inject({ method: 'PUT', url: '/api/auth/settings', headers, payload: { ...auth.settings(), enabled: true, password } });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const session = cookie(enabled.headers['set-cookie']);
  const stored = await readFile(path.join(root, 'web-access.json'), 'utf8');
  assert.ok(!stored.includes(password)); assert.ok(!stored.includes(session.split('=')[1]!));
  assert.equal((await stat(path.join(root, 'web-access.json'))).mode & 0o777, 0o600);
  for (const url of ['/api/status', '/api/timeline', '/api/settings', '/api/models/catalog', '/api/auth/settings', '/api/memory', '/api/extensions', '/api/runs', '/api/attachments/8bfffd63-8659-4d1f-8516-3ee9c591a8fd', '/api/unknown']) {
    assert.equal((await app.inject({ url, headers })).statusCode, 401, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers, payload: { id: 'x', text: 'secret', occurredAt: new Date().toISOString() } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/status', headers: { ...headers, cookie: session } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { ...headers, cookie: `${session}; ${session}` } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/%73tatus', headers })).statusCode, 400);
});

test('login, wrong password, logout and restart invalidate access without leaking secrets', async t => {
  const { auth, app, options } = await fixture(t);
  await auth.save({ ...auth.settings(), enabled: true, password }, undefined, '127.0.0.1', false);
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password: 'wrong-test-password' } });
  assert.equal(wrong.statusCode, 401); assert.ok(!wrong.body.includes('wrong-test-password'));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password } });
  assert.equal(login.statusCode, 200); assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
  const session = cookie(login.headers['set-cookie']);
  assert.deepEqual(auth.status(session), { enabled: true, authenticated: true });
  const reopened = await WebAccessAuth.open(options);
  assert.deepEqual(reopened.status(session), { enabled: true, authenticated: false });
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie: session }, payload: {} });
  assert.equal(logout.statusCode, 200); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
  assert.equal(auth.status(session).authenticated, false);
});

test('password replacement and disabling require current password, CAS and revoke all existing sessions', async t => {
  const { auth, app } = await fixture(t);
  let session = cookie(await auth.save({ ...auth.settings(), enabled: true, password }, undefined, 'first', false));
  const other = cookie(await auth.login(password, 'second', false));
  const oldRevision = auth.settings().revision;
  const save = (body: unknown) => app.inject({ method: 'PUT', url: '/api/auth/settings', headers: { ...headers, cookie: session }, payload: JSON.stringify(body) });
  assert.equal((await save({ ...auth.settings(), enabled: false })).statusCode, 403);
  assert.equal((await save({ ...auth.settings(), enabled: false, currentPassword: 'wrong-test-password' })).statusCode, 403);
  assert.equal(auth.status(session).authenticated, true);
  const changed = await save({ ...auth.settings(), enabled: true, currentPassword: password, password: 'replacement-test-password' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(auth.status(session).authenticated, false); assert.equal(auth.status(other).authenticated, false);
  session = cookie(changed.headers['set-cookie']);
  assert.equal((await save({ revision: oldRevision, enabled: false, currentPassword: 'replacement-test-password' })).statusCode, 409);
  const disabled = await save({ ...auth.settings(), enabled: false, currentPassword: 'replacement-test-password' });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.deepEqual(auth.status(), { enabled: false, authenticated: true });
  assert.equal((await app.inject({ url: '/api/status', headers })).statusCode, 200);
});

test('bounded password attempts enforce a per-address and global limiter before hashing', async t => {
  const { auth, app } = await fixture(t);
  await auth.save({ ...auth.settings(), enabled: true, password }, undefined, 'setup', false);
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password: 'incorrect-password' } })).statusCode, 401);
  const limited = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { password } });
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '60');
});

test('explicit remote HTTP and HTTPS origins preserve host/origin guards and secure cookie selection', async t => {
  const { app, auth } = await fixture(t, 'https://mira.example.test');
  const remote = { ...headers, host: 'mira.example.test', origin: 'https://mira.example.test' };
  const enabled = await app.inject({ method: 'PUT', url: '/api/auth/settings', headers: remote, remoteAddress: '192.0.2.20', payload: { ...auth.settings(), enabled: true, password } });
  assert.equal(enabled.statusCode, 200, enabled.body); assert.match(String(enabled.headers['set-cookie']), /; Secure$/);
  assert.equal((await app.inject({ url: '/api/status', headers: { ...remote, cookie: cookie(enabled.headers['set-cookie']) }, remoteAddress: '192.0.2.20' })).statusCode, 200);
  for (const extra of [{ host: 'evil.test' }, { origin: 'http://mira.example.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await app.inject({ url: '/api/auth/status', headers: { ...remote, ...extra } })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/external/wake', headers: { host: headers.host, 'x-mira-client': 'external', 'content-type': 'application/json' }, remoteAddress: '192.0.2.20', payload: {} })).statusCode, 403);
  const lan = await fixture(t, 'http://192.0.2.10:4327');
  assert.equal((await lan.app.inject({ url: '/api/status', headers: { ...headers, host: '192.0.2.10:4327', origin: 'http://192.0.2.10:4327' }, remoteAddress: '192.0.2.20' })).statusCode, 200);
});

test('corrupt existing auth file fails closed and bind/origin configuration rejects ambiguous values', async t => {
  const { root, options } = await fixture(t);
  await writeFile(path.join(root, 'web-access.json'), '{broken', { mode: 0o600 });
  await assert.rejects(WebAccessAuth.open(options), /unavailable/);
  assert.equal(webListenHost(undefined), '127.0.0.1'); assert.equal(webListenHost('0.0.0.0'), '0.0.0.0');
  assert.equal(webPublicOrigin('http://192.0.2.10:3210'), 'http://192.0.2.10:3210');
  for (const value of ['http://0.0.0.0:3210', 'http://host/', 'http://user:password@host', 'http://host/path', 'http://host?x=1', 'ftp://host']) assert.throws(() => webPublicOrigin(value));
});


test('session expiry is absolute and queued stale settings never overwrite a password change', async t => {
  const { auth } = await fixture(t);
  const session = cookie(await auth.save({ ...auth.settings(), enabled: true, password }, undefined, 'first', false));
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 12 * 60 * 60 * 1000 + 1;
    assert.equal(auth.status(session).authenticated, false);
  } finally { Date.now = realNow; }
  const active = cookie(await auth.login(password, 'second', false));
  const input = { ...auth.settings(), enabled: true, password: 'replacement-test-password', currentPassword: password };
  const results = await Promise.allSettled([auth.save(input, active, 'first', false), auth.save(input, active, 'first', false)]);
  assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected');
  assert.equal(auth.status(active).authenticated, false);
});
