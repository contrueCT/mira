import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DurableOperationError } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { PersistenceFailureNotice } from '../../apps/server/src/persistence-errors.ts';
import { createLocalHttp, WebHttpError, WebSettingsError, type WebBackend, type WebSettings } from '@mira/server';

const port = 4317;
const origin = `http://127.0.0.1:${port}`;
const readHeaders = { host: `127.0.0.1:${port}`, 'x-mira-client': 'web' };
const writeHeaders = { ...readHeaders, origin, 'content-type': 'application/json' };
const settings = (): WebSettings => ({ revision: 'a'.repeat(64), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null });
const message = { id: 'user-1', text: 'Hello Mira', occurredAt: '2026-10-06T07:00:00.000Z' };
const connection = { id: 'custom', baseUrl: 'https://models.example.test/v1', api: 'openai-completions', hasApiKey: true, models: [] };
function backend(overrides: Partial<WebBackend> = {}): WebBackend {
  return {
    status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null }),
    timeline: async () => ({ items: [{ id: 'user-1', role: 'user', text: 'Hello Mira', occurredAt: message.occurredAt }], nextCursor: null }),
    submit: async input => ({ id: input.id, receipt: 'inserted' }),
    settings: async () => settings(), saveSettings: async value => value as WebSettings,
    discover: async () => ({ endpoint: `${connection.baseUrl}/models`, models: [{ id: 'example', name: 'Example' }] }),
    ...overrides,
  };
}

test('local API exposes allowlisted complete messages, lifecycle status, settings and catalog without credentials', async t => {
  const app = createLocalHttp({ backend: backend(), port }); t.after(() => app.close());
  const status = await app.inject({ url: '/api/status', headers: readHeaders });
  assert.equal(status.statusCode, 200); assert.deepEqual(status.json(), { state: 'idle', mode: 'synthetic', model: null, error: null });
  assert.equal(status.headers['cache-control'], 'private, no-store');
  assert.equal(status.headers['x-content-type-options'], 'nosniff'); assert.equal(status.headers['referrer-policy'], 'no-referrer');
  assert.equal(status.headers['x-frame-options'], 'DENY'); assert.match(String(status.headers['content-security-policy']), /frame-ancestors 'none'/u);
  assert.ok(!String(status.headers['content-security-policy']).includes('unsafe-inline')); assert.equal(status.headers['access-control-allow-origin'], undefined);
  const timeline = await app.inject({ url: '/api/timeline', headers: readHeaders }); assert.equal(timeline.statusCode, 200); assert.equal(timeline.json().items.length, 1);
  const current = await app.inject({ url: '/api/settings', headers: readHeaders }); assert.deepEqual(current.json(), settings());
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: settings() }); assert.equal(saved.statusCode, 200);
  const submitted = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: message }); assert.equal(submitted.statusCode, 201); assert.deepEqual(submitted.json(), { id: message.id, receipt: 'inserted' });
  const catalog = await app.inject({ url: '/api/models/catalog', headers: readHeaders }); assert.equal(catalog.statusCode, 200); assert.ok(catalog.json().providers.length > 0);
  assert.equal(catalog.json().source, '@earendil-works/pi-ai@1.0.2'); assert.ok(!catalog.body.includes('"apiKey":'));
  const discovered = await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection } }); assert.equal(discovered.statusCode, 200); assert.equal(discovered.json().models[0].id, 'example');
});

test('all routes reject foreign hosts, rebinding names and foreign/null origins before backend work', async t => {
  let calls = 0;
  const app = createLocalHttp({ backend: backend({ status: async () => { calls++; throw Error('must not run'); } }), port }); t.after(() => app.close());
  for (const host of ['localhost:4317', '127.0.0.1', '127.0.0.1:4318', 'evil.example:4317', '[::1]:4317', '127.0.0.1:4317, evil.example']) {
    for (const url of ['/', '/assets/main.js', '/api/status', '/missing']) {
      const response = await app.inject({ url, headers: { ...readHeaders, host } }); assert.equal(response.statusCode, 403, `${url} ${host}`);
    }
  }
  for (const foreign of ['null', 'https://evil.example', 'http://localhost:4317', `${origin}/`, 'http://127.0.0.1:4318']) {
    const response = await app.inject({ url: '/api/status', headers: { ...readHeaders, origin: foreign } }); assert.equal(response.statusCode, 403);
  }
  assert.equal(calls, 0);
});

test('API reads require the custom header and reject foreign fetch metadata even without Origin', async t => {
  const app = createLocalHttp({ backend: backend(), port }); t.after(() => app.close());
  for (const extra of [{}, { 'x-mira-client': 'wrong' }, { 'x-mira-client': 'web, web' }]) {
    assert.equal((await app.inject({ url: '/api/settings', headers: { host: readHeaders.host, ...extra } })).statusCode, 403);
  }
  for (const extra of [
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'null' },
    { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-dest': 'script' }, { 'sec-fetch-dest': 'document' },
  ]) assert.equal((await app.inject({ url: '/api/status', headers: { ...readHeaders, ...extra } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/status', headers: { ...readHeaders, origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).statusCode, 200);
});

test('writes require exact Origin, JSON and client header; methods and preflights are not enabled', async t => {
  let calls = 0; const app = createLocalHttp({ backend: backend({ submit: async input => { calls++; return { id: input.id, receipt: 'duplicate' }; } }), port }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: readHeaders, payload: message })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: { host: readHeaders.host, origin, 'content-type': 'application/json' }, payload: message })).statusCode, 403);
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-patch+json', 'application/json; charset=latin1']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: { ...writeHeaders, 'content-type': contentType }, payload: JSON.stringify(message) })).statusCode, 415);
  }
  for (const method of ['HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const response = await app.inject({ method, url: '/api/status', headers: writeHeaders }); assert.equal(response.statusCode, 405); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const duplicate = await app.inject({ method: 'POST', url: '/api/messages', headers: { ...writeHeaders, 'content-type': 'application/json; charset=utf-8' }, payload: message });
  assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().receipt, 'duplicate'); assert.equal(calls, 1);
});

test('schema validation rejects unknown keys, coercion, repeated and oversized queries, malformed JSON and messages', async t => {
  let calls = 0; const app = createLocalHttp({ backend: backend({ submit: async input => { calls++; return { id: input.id, receipt: 'inserted' }; } }), port }); t.after(() => app.close());
  for (const payload of [
    {}, null, [], { ...message, extra: true }, { ...message, id: 1 }, { ...message, id: 'not a valid id' }, { ...message, text: ' \n ' },
    { ...message, text: false }, { ...message, occurredAt: 'not-a-date' }, { ...message, occurredAt: '2026-02-31T00:00:00Z' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: JSON.stringify(payload) }); assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  for (const payload of ['{"text":', '{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{}}}']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload })).statusCode, 400);
  }
  for (const url of ['/api/status?extra=secret', '/api/timeline?before=', '/api/timeline?before=a&before=b', '/api/timeline?before=a.b', '/api/timeline?before=' + 'a'.repeat(2_049), '/api/models/catalog?provider=openai']) {
    assert.equal((await app.inject({ url, headers: readHeaders })).statusCode, 400, url.slice(0, 80));
  }
  for (const text of ['a'.repeat(65_537), '界'.repeat(22_000)]) assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: { ...message, text } })).statusCode, 413);
  assert.equal(calls, 0);
});

test('settings and discovery reject misplaced credentials, old env references and unknown nested fields before backend', async t => {
  let calls = 0;
  const app = createLocalHttp({ backend: backend({ saveSettings: async () => { calls++; throw Error('never'); }, discover: async () => { calls++; throw Error('never'); } }), port }); t.after(() => app.close());
  for (const payload of [{ ...settings(), apiKey: 'synthetic-secret' }, { ...settings(), configuration: { apiKey: 'synthetic-secret' } }, { ...settings(), selection: { kind: 'custom', connection: 'x', model: 'm', token: 'synthetic-secret' } }]) {
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload }); assert.equal(response.statusCode, 400); assert.ok(!response.body.includes('synthetic-secret'));
  }
  for (const payload of [{ connection: { ...connection, apiKey: 'invalid whitespace key' } }, { connection, extra: true }, { connection: { ...connection, apiKeyEnv: 'not a variable' } }, { connection: { ...connection, modelsUrl: 'https://another.example.test/models' } }]) {
    const response = await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload }); assert.equal(response.statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: ' '.repeat(2_000_001) })).statusCode, 413);
  assert.equal(calls, 0);
});

test('responses omit internal fields and sanitize backend errors, status diagnostics and settings conflicts', async t => {
  const secret = 'synthetic-provider-secret-stack-path';
  const app = createLocalHttp({ backend: backend({
    status: async () => ({ state: 'error', mode: 'live', model: 'example-model', error: secret, apiKey: secret }),
    timeline: async before => { assert.equal(before, 'cursor_1'); return { items: [{ id: '1', role: 'assistant', text: 'Visible answer', occurredAt: message.occurredAt, raw: secret }], nextCursor: null, tools: [{ id: 'tool-1', name: 'read', status: 'unknown', arguments: secret }], raw: secret }; },
    submit: async () => { throw Error(secret); },
    saveSettings: async () => { throw new WebSettingsError('settings_conflict'); },
    discover: async () => ({ endpoint: `${connection.baseUrl}/models`, models: [{ id: 'safe-model', raw: secret }], headers: { authorization: secret } }),
  }), port }); t.after(() => app.close());
  for (const url of ['/api/status', '/api/timeline?before=cursor_1']) { const response = await app.inject({ url, headers: readHeaders }); assert.equal(response.statusCode, 200); assert.ok(!response.body.includes(secret)); assert.ok(!response.body.includes('"raw"')); }
  for (const request of [
    { url: '/api/timeline?before=cursor_1', headers: readHeaders },
    { method: 'POST' as const, url: '/api/timeline', headers: writeHeaders, payload: { before: 'cursor_1' } },
  ]) {
    const response = await app.inject(request); assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { items: [{ id: '1', role: 'assistant', text: 'Visible answer', occurredAt: message.occurredAt }], nextCursor: null });
  }
  const failed = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: message }); assert.equal(failed.statusCode, 500); assert.ok(!failed.body.includes(secret)); assert.ok(!failed.body.includes('stack'));
  const conflict = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: settings() }); assert.equal(conflict.statusCode, 409); assert.match(conflict.json().error, /reload/u);
  const discovered = await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection } }); assert.equal(discovered.statusCode, 200); assert.ok(!discovered.body.includes(secret));
});

test('busy and unavailable service errors have fixed status and text, never raw messages', async t => {
  const app = createLocalHttp({ backend: backend({ submit: async () => { throw new WebHttpError('unavailable'); }, saveSettings: async () => { throw new WebHttpError('busy'); } }), port }); t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: message })).statusCode, 503);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: settings() })).statusCode, 409);
});

test('persistence status and HTTP failures use a fixed volatile notice without claiming a saved diagnostic', async t => {
  const secret = 'synthetic-persistence-secret-do-not-expose';
  const failure = new DurableOperationError('persistence-write-failure', `Authorization: Bearer ${secret}`, { cause: { headers: { cookie: secret }, payload: secret } });
  const notice = PersistenceFailureNotice.from(failure)!;
  const app = createLocalHttp({ backend: backend({
    status: async () => ({ state: 'stopped', mode: 'synthetic', model: null, error: notice }),
    submit: async () => { throw failure; },
  }), port }); t.after(() => app.close());
  const status = await app.inject({ url: '/api/status', headers: readHeaders });
  assert.equal(status.statusCode, 200); assert.equal(status.json().state, 'stopped');
  assert.match(status.json().error, /Persistence write failed/);
  assert.match(status.json().error, /temporary server notice; no durable tool diagnostic is confirmed/);
  assert.ok(!status.body.includes(secret)); assert.ok(!status.body.includes('headers'));
  const response = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: message });
  assert.equal(response.statusCode, 503); assert.equal(response.json().error, status.json().error);
  assert.ok(!response.body.includes(secret));
  const timeline = await app.inject({ url: '/api/timeline', headers: readHeaders });
  assert.deepEqual(timeline.json(), { items: [{ id: 'user-1', role: 'user', text: 'Hello Mira', occurredAt: message.occurredAt }], nextCursor: null });
});

test('lookalike persistence notices and ordinary validation errors retain protected generic HTTP text', async t => {
  const secret = 'synthetic-lookalike-secret';
  const fake = Object.assign(Object.create(PersistenceFailureNotice.prototype), { message: secret, category: 'persistence-write-failure' }) as PersistenceFailureNotice;
  const app = createLocalHttp({ backend: backend({
    status: async () => ({ state: 'error', mode: 'synthetic', model: null, error: fake }),
    submit: async () => { throw new PersistenceError('invalid', secret); },
  }), port }); t.after(() => app.close());
  const status = await app.inject({ url: '/api/status', headers: readHeaders });
  assert.equal(status.statusCode, 200); assert.ok(!status.body.includes(secret));
  assert.ok(!status.body.includes('Persistence write failed'));
  const response = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: message });
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes(secret));
  assert.ok(!response.body.includes('Persistence write failed'));
});

test('model discovery has one active request and a bounded per-minute rate', async t => {
  let release: (() => void) | undefined; let started: (() => void) | undefined;
  const begin = new Promise<void>(resolve => { started = resolve; });
  const block = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const app = createLocalHttp({ backend: backend({ discover: async (_connection, signal) => { assert.ok(signal instanceof AbortSignal); calls++; started?.(); await block; return { endpoint: `${connection.baseUrl}/models`, models: [] }; } }), port }); t.after(() => app.close());
  const first = app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection } }).then(value => value);
  await begin;
  assert.equal((await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection } })).statusCode, 409);
  release?.(); assert.equal((await first).statusCode, 200);
  for (let index = 0; index < 4; index++) assert.equal((await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection } })).statusCode, 200);
  const capped = await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection } }); assert.equal(capped.statusCode, 429); assert.equal(capped.headers['retry-after'], '60'); assert.equal(calls, 5);
});

test('local API has a global bound on outstanding backend reads', async t => {
  let release: (() => void) | undefined; let started: (() => void) | undefined; let calls = 0;
  const block = new Promise<void>(resolve => { release = resolve; }); const begin = new Promise<void>(resolve => { started = resolve; });
  const app = createLocalHttp({ backend: backend({ status: async () => { calls++; if (calls === 32) started?.(); await block; return { state: 'idle', mode: 'synthetic', model: null, error: null }; } }), port }); t.after(() => app.close());
  const requests = Array.from({ length: 32 }, () => app.inject({ url: '/api/status', headers: readHeaders }).then(value => value));
  await begin; assert.equal((await app.inject({ url: '/api/status', headers: readHeaders })).statusCode, 429);
  release?.(); assert.ok((await Promise.all(requests)).every(response => response.statusCode === 200));
  assert.equal((await app.inject({ url: '/api/status', headers: readHeaders })).statusCode, 200);
});

test('production static files use the same origin, CSP and explicit build routes with no traversal, source or symlink leaks', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-web-assets-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'assets')); await writeFile(path.join(directory, 'index.html'), '<!doctype html><script type="module" src="/assets/main.js"></script>');
  await writeFile(path.join(directory, 'assets/main.js'), 'console.log("synthetic")'); await writeFile(path.join(directory, 'secret.json'), 'synthetic-private-source');
  await symlink(path.join(directory, 'secret.json'), path.join(directory, 'assets/leak.js'));
  const app = createLocalHttp({ backend: backend(), port, assetsDirectory: directory }); t.after(() => app.close());
  for (const url of ['/', '/assets/main.js']) {
    const response = await app.inject({ url, headers: { host: readHeaders.host, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }); assert.equal(response.statusCode, 200); assert.ok(response.headers['content-security-policy']);
  }
  for (const url of ['/secret.json', '/src/main.tsx', '/missing', '/assets/leak.js', '/assets/../secret.json', '/assets/%2e%2e/secret.json', '/assets/.hidden', '/assets/%5c..%5csecret.json', '/api/unknown']) {
    const response = await app.inject({ url, headers: readHeaders }); assert.ok(response.statusCode >= 400, url); assert.ok(!response.body.includes('synthetic-private-source'));
  }
  assert.equal((await app.inject({ url: '/assets/main.js', headers: { host: 'evil.example' } })).statusCode, 403);
});

test('server requires a concrete localhost port', () => {
  for (const invalid of [0, -1, 65_536, 4.5, NaN]) assert.throws(() => createLocalHttp({ backend: backend(), port: invalid }));
});

test('router-level malformed URL errors also enforce Host and omit raw request data', async t => {
  const app = createLocalHttp({ backend: backend(), port }); t.after(() => app.close());
  for (const host of [readHeaders.host, 'evil.example']) {
    const response = await app.inject({ url: '/assets/%zz-synthetic-secret', headers: { ...readHeaders, host } });
    assert.equal(response.statusCode, host === readHeaders.host ? 400 : 403);
    assert.ok(!response.body.includes('synthetic-secret')); assert.ok(response.headers['content-security-policy']);
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
});

test('read-only timeline POST carries the full history cursor without request-line truncation', async t => {
  const before = 'a'.repeat(200_000); let received: string | undefined;
  const app = createLocalHttp({ backend: backend({ timeline: async cursor => { received = cursor; return { items: [], nextCursor: null }; } }), port });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/timeline', headers: writeHeaders, payload: { before } });
  assert.equal(response.statusCode, 200); assert.equal(received, before);
  const oversized = await app.inject({ method: 'POST', url: '/api/timeline', headers: writeHeaders, payload: { before: 'a'.repeat(524_289) } });
  assert.equal(oversized.statusCode, 400);
  const foreign = await app.inject({ method: 'POST', url: '/api/timeline', headers: { ...writeHeaders, origin: 'https://foreign.example' }, payload: { before } });
  assert.equal(foreign.statusCode, 403);
});

test('browser opener environment cannot inherit server credentials or code-injection flags', async () => {
  const { browserLaunchEnvironment } = await import('@mira/server');
  const original = { PATH: '/usr/bin', HOME: '/tmp/synthetic', DISPLAY: ':1', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret-sentinel', CUSTOM_TOKEN: 'custom-sentinel', MIRA_DATABASE_URL: 'postgres://secret@localhost/mira', NODE_OPTIONS: '--import=evil.mjs', LD_PRELOAD: 'evil.so' };
  assert.deepEqual(browserLaunchEnvironment(original), { PATH: '/usr/bin', HOME: '/tmp/synthetic', DISPLAY: ':1', SystemRoot: 'C:\\Windows' });
  assert.equal(original.OPENAI_API_KEY, 'secret-sentinel');
});

test('local database URL requires an explicit database and never echoes credentials', async () => {
  const { localDatabaseUrl } = await import('@mira/server');
  for (const value of [undefined, '', 'postgres://localhost', 'postgres://localhost/', 'postgres://127.0.0.1', 'postgres://[::1]/', 'postgres://remote.example/mira', 'postgres://localhost/mira?options=x', 'not-a-url-secret-sentinel']) {
    assert.throws(() => localDatabaseUrl(value), error => error instanceof Error && !error.message.includes('secret-sentinel'));
  }
  assert.equal(localDatabaseUrl('postgres://user:synthetic@127.0.0.1/mira'), 'postgres://user:synthetic@127.0.0.1/mira');
});

test('encoded API aliases cannot bypass client, origin or resource guards', async t => {
  let calls = 0;
  const app = createLocalHttp({ backend: backend({ status: async () => { calls++; return { state: 'idle', mode: 'synthetic', model: null, error: null }; }, submit: async value => { calls++; return { id: value.id, receipt: 'inserted' }; } }), port });
  t.after(() => app.close());
  for (const url of ['/%61pi/status', '/api/%73tatus', '/%61%70%69/status']) {
    assert.equal((await app.inject({ url, headers: { host: readHeaders.host } })).statusCode, 400);
    assert.equal((await app.inject({ url, headers: readHeaders })).statusCode, 400);
  }
  for (const url of ['/%61pi/messages', '/api/%6dessages']) {
    const response = await app.inject({ method: 'POST', url, headers: { host: readHeaders.host, 'content-type': 'application/json' }, payload: message });
    assert.equal(response.statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, headers: writeHeaders, payload: message })).statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('HTTP accepts write-only keys, masks every settings response, and discovery drafts remain unpersisted', async t => {
  const { WebSettingsStore } = await import('@mira/server');
  const { readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-http-key-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new WebSettingsStore(path.join(directory, 'private', 'models.json'));
  const secret = 'synthetic-http-private-key'; const draft = 'synthetic-discovery-only-key'; let observed: string | null = null;
  const app = createLocalHttp({ port, backend: backend({ settings: () => store.get(), saveSettings: value => store.save(value),
    discover: (value, signal) => store.discover(value, { ...(signal ? { signal } : {}), fetch: async (_url, init) => {
      observed = new Headers(init?.headers).get('authorization'); return Response.json({ data: [{ id: 'example-model' }] });
    } }),
  }) }); t.after(() => app.close());
  const initial = (await app.inject({ url: '/api/settings', headers: readHeaders })).json();
  const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders,
    payload: { ...initial, configuration: { builtinCredentials: {}, customConnections: [{ ...connection, apiKey: secret }] } } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().configuration.customConnections[0].hasApiKey, true);
  assert.ok(!saved.body.includes(secret)); assert.ok(!saved.body.includes('"apiKey"'));
  const read = await app.inject({ url: '/api/settings', headers: readHeaders }); assert.equal(read.statusCode, 200); assert.ok(!read.body.includes(secret));
  const before = await readFile(store.file, 'utf8');
  const discovered = await app.inject({ method: 'POST', url: '/api/models/discover', headers: writeHeaders, payload: { connection: { ...connection, apiKey: draft } } });
  assert.equal(discovered.statusCode, 200); assert.equal(observed, `Bearer ${draft}`); assert.ok(!discovered.body.includes(draft));
  assert.equal(await readFile(store.file, 'utf8'), before);
  const removed = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: { ...saved.json<WebSettings>(), configuration: { builtinCredentials: {}, customConnections: [{ ...connection, apiKey: null }] } } });
  assert.equal(removed.statusCode, 200); assert.equal(removed.json().configuration.customConnections[0].hasApiKey, false);
  assert.ok(!(await readFile(store.file, 'utf8')).includes(secret));
});

test('malformed backend response containing a write-only key never reaches GET or PUT response bodies', async t => {
  const secret = 'synthetic-backend-must-not-leak';
  const bad = { ...settings(), configuration: { builtinCredentials: { openai: { hasApiKey: true, apiKey: secret } }, customConnections: [] } };
  const app = createLocalHttp({ backend: backend({ settings: async () => bad, saveSettings: async () => bad }), port }); t.after(() => app.close());
  for (const request of [{ url: '/api/settings', headers: readHeaders }, { method: 'PUT' as const, url: '/api/settings', headers: writeHeaders, payload: settings() }]) {
    const result = await app.inject(request); assert.ok(result.statusCode >= 400); assert.ok(!result.body.includes(secret)); assert.ok(!result.body.includes('"apiKey"'));
  }
});

test('status exposes only transport-minted model diagnostics and preserves useful redacted details', async t => {
  const { ModelRequestFailure } = await import('../../apps/server/src/model-errors.ts');
  const diagnostic = ModelRequestFailure.from('403 {"error":{"message":"invalid tool name history.search synthetic-key","code":"invalid_request_error"}}', { status: 403, requestId: 'req-1' }, 'synthetic-key');
  const app = createLocalHttp({ backend: backend({ status: async () => ({ state: 'error', mode: 'live', model: 'fixture', error: diagnostic }) }), port });
  t.after(() => app.close());
  const response = await app.inject({ url: '/api/status', headers: readHeaders });
  assert.equal(response.statusCode, 200); assert.equal(response.json().error, diagnostic.message);
  assert.match(response.json().error, /HTTP 403.*req-1.*invalid tool name/); assert.doesNotMatch(response.body, /synthetic-key/);
});


test('timeline exposes separate event receipt identity only for user items on both read routes', async t => {
  const original = 'external-request-id'; const id = '10000000-0000-4000-8000-000000000001';
  const app = createLocalHttp({ backend: backend({ timeline: async () => ({ items: [
    { id, role: 'user', text: 'pending receipt', occurredAt: message.occurredAt, externalEventId: original },
    { id: '10000000-0000-4000-8000-000000000002', role: 'assistant', text: 'answer', occurredAt: message.occurredAt, externalEventId: 'do-not-project' },
  ], nextCursor: null }) }), port });
  t.after(() => app.close());
  for (const request of [
    { url: '/api/timeline', headers: readHeaders },
    { method: 'POST' as const, url: '/api/timeline', headers: writeHeaders, payload: { before: 'cursor_1' } },
  ]) {
    const response = await app.inject(request); assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].id, id); assert.equal(response.json().items[0].externalEventId, original);
    assert.equal(response.json().items[1].externalEventId, undefined);
  }
});

test('retry status exposes only bounded request observations and clears without adding a timeline record', async t => {
  let retrying = true;
  const app = createLocalHttp({ backend: backend({ status: async () => ({ state: retrying ? 'working' : 'idle', mode: 'live', model: 'fixture', error: null,
    modelRetry: retrying ? { phase: 'waiting', attempt: 2, maxAttempts: 3, delayMs: 250, reason: 'server', raw: 'PRIVATE_PROVIDER_BODY' } : null }) }), port });
  t.after(() => app.close());
  const response = await app.inject({ url: '/api/status', headers: readHeaders });
  assert.deepEqual(response.json().modelRetry, { phase: 'waiting', attempt: 2, maxAttempts: 3, delayMs: 250, reason: 'server' });
  assert.doesNotMatch(response.body, /PRIVATE_PROVIDER_BODY/);
  retrying = false;
  assert.equal((await app.inject({ url: '/api/status', headers: readHeaders })).json().modelRetry, undefined);
  assert.equal((await app.inject({ url: '/api/timeline', headers: readHeaders })).json().items.length, 1);
});
