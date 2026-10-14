import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api, clientFetch } from '../src/api.ts';
import { attachmentBlob, uploadAttachment } from '../src/attachments.ts';
import { acceptAuthStatus, beginAuthOperation, finishAuthOperation, getAccessSnapshot, parseAuthSettings, parseAuthStatus, requireAuthentication, subscribeAccess, validateNewPassword } from '../src/auth.ts';

const ready = { enabled: true, authenticated: true };
const locked = { enabled: true, authenticated: false };

test('authentication and settings DTOs fail closed for malformed values', () => {
  assert.deepEqual(parseAuthStatus(ready), ready);
  assert.deepEqual(parseAuthStatus({ enabled: false, authenticated: false }), { enabled: false, authenticated: false });
  for (const value of [null, {}, { enabled: false }, { enabled: 'false', authenticated: false }, { enabled: true, authenticated: 1 }]) assert.throws(() => parseAuthStatus(value));
  assert.deepEqual(parseAuthSettings({ enabled: false, revision: 'uuid' }), { enabled: false, revision: 'uuid' });
  for (const value of [null, { enabled: false }, { enabled: false, revision: '' }, { enabled: 1, revision: 'uuid' }]) assert.throws(() => parseAuthSettings(value));
});
test('new password limits count Unicode code points without normalization or diagnostics containing the input', () => {
  for (const password of ['a'.repeat(12), 'a'.repeat(256), '密'.repeat(12), '🔐'.repeat(256), '  ten-letters  ']) assert.doesNotThrow(() => validateNewPassword(password));
  for (const password of ['tiny-secret', 'a'.repeat(257), '🔐'.repeat(257), ' '.repeat(12), '\t\n '.repeat(8)]) {
    assert.throws(() => validateNewPassword(password), cause => cause instanceof Error && !cause.message.includes(password));
  }
});
test('access invalidation notifies once and a prior request cannot invalidate a new login', () => {
  acceptAuthStatus(ready);
  const epoch = getAccessSnapshot().epoch;
  let notifications = 0;
  const unsubscribe = subscribeAccess(() => notifications++);
  requireAuthentication(epoch);
  assert.deepEqual(getAccessSnapshot().status, locked);
  assert.equal(notifications, 1);
  requireAuthentication(epoch);
  assert.equal(notifications, 1);
  acceptAuthStatus(ready);
  requireAuthentication(epoch);
  assert.deepEqual(getAccessSnapshot().status, ready);
  assert.equal(acceptAuthStatus(locked, epoch), false);
  unsubscribe();
});
test('all API 401 responses invalidate access before parsing even malformed JSON', async t => {
  acceptAuthStatus(ready);
  const call = t.mock.method(globalThis, 'fetch', async () => new Response('Not JSON', { status: 401 }));
  await assert.rejects(api('/api/timeline'), cause => cause instanceof ApiError && cause.status === 401);
  assert.deepEqual(getAccessSnapshot().status, locked);
  const options = call.mock.calls[0]!.arguments[1] as RequestInit;
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(new Headers(options.headers).get('X-Mira-Client'), 'web');
});
test('login errors stay local while current-password 403 does not revoke access', async t => {
  acceptAuthStatus(ready);
  const epoch = getAccessSnapshot().epoch;
  const response = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Invalid password' }, { status: 401 }));
  await assert.rejects(api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'synthetic-test-only' }) }, false), ApiError);
  assert.equal(getAccessSnapshot().epoch, epoch);
  response.mock.mockImplementation(async () => Response.json({ error: 'Invalid current password' }, { status: 403 }));
  await assert.rejects(api('/api/auth/settings', { method: 'PUT', body: '{}' }), ApiError);
  assert.deepEqual(getAccessSnapshot().status, ready);
});
test('an in-flight protected request from a prior login cannot lock a newer session', async t => {
  acceptAuthStatus(ready);
  let resolve!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(done => { resolve = done; }));
  const request = clientFetch('/api/timeline');
  acceptAuthStatus(ready);
  resolve(new Response('Expired old session', { status: 401 }));
  await request;
  assert.deepEqual(getAccessSnapshot().status, ready);
});
test('both attachment upload and byte download clear the private interface on 401', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Expired', { status: 401 }));
  const signal = new AbortController().signal;
  acceptAuthStatus(ready);
  await assert.rejects(uploadAttachment(new File(['dummy'], 'test.txt'), signal), ApiError);
  assert.deepEqual(getAccessSnapshot().status, locked);
  acceptAuthStatus(ready);
  await assert.rejects(attachmentBlob({ id: 'id', name: 'test.txt', mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64) }, signal), ApiError);
  assert.deepEqual(getAccessSnapshot().status, locked);
});

test('a rotation survives intervening 401 invalidation and safely restores the current session', () => {
  acceptAuthStatus(ready);
  const operation = beginAuthOperation('settings');
  const epoch = getAccessSnapshot().epoch;
  requireAuthentication(epoch);
  assert.deepEqual(getAccessSnapshot().status, locked);
  assert.deepEqual(getAccessSnapshot().operation, { id: operation, kind: 'settings' });
  assert.equal(finishAuthOperation(operation, ready), true);
  assert.deepEqual(getAccessSnapshot().status, ready);
  assert.equal(getAccessSnapshot().operation, null);
  requireAuthentication(epoch);
  assert.deepEqual(getAccessSnapshot().status, ready);
});
test('newer login/logout supersedes an earlier rotation, including late success and failure', () => {
  acceptAuthStatus(ready);
  const oldOperation = beginAuthOperation('settings');
  requireAuthentication(getAccessSnapshot().epoch);
  const login = beginAuthOperation('login');
  assert.equal(finishAuthOperation(oldOperation, ready), false);
  assert.equal(finishAuthOperation(oldOperation), false);
  assert.equal(getAccessSnapshot().operation?.id, login);
  assert.equal(finishAuthOperation(login, ready), true);
  const logout = beginAuthOperation('logout');
  assert.equal(finishAuthOperation(oldOperation, ready), false);
  assert.equal(finishAuthOperation(logout, locked), true);
  assert.equal(finishAuthOperation(oldOperation, ready), false);
  assert.deepEqual(getAccessSnapshot().status, locked);
});
test('a failed interrupted rotation stays locked and releases the pending operation', () => {
  acceptAuthStatus(ready);
  const operation = beginAuthOperation('settings');
  requireAuthentication(getAccessSnapshot().epoch);
  assert.equal(finishAuthOperation(operation), true);
  assert.equal(getAccessSnapshot().operation, null);
  assert.deepEqual(getAccessSnapshot().status, locked);
});
