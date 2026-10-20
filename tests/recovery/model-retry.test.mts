import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService, WebSettingsStore, createLocalHttp } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { retryConfiguration, retrySelection, retryResponse, retryFailure, syntheticRetryKey } from './model-retry-fixtures.mts';

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function settings(file: string): Promise<void> {
  const store = new WebSettingsStore(file, process.cwd()); const current = await store.get();
  await store.save({ revision: current.revision, selection: retrySelection, configuration: { builtinCredentials: {}, customConnections: retryConfiguration.customConnections.map(({ apiKeyEnv: _env, ...connection }) => ({ ...connection, apiKey: syntheticRetryKey })) } });
}

test('real PG/service/SDK retries after one committed effect, exposes actual status, and does not repeat after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-model-retry-pg-')); let service: LocalWebService | undefined;
  let calls = 0; const bodies: string[] = []; const effect = path.join(root, 'effect');
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'retry-service', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), autoCompaction: { enabled: false }, dreaming: { enabled: false },
    modelFetch: (async (_url, init) => {
      calls++; bodies.push(String(init?.body));
      if (calls === 1) return retryResponse('', 'once-call', 'bash', { command: `printf once >> ${JSON.stringify(effect)}` });
      if (calls === 2) return retryFailure(503, 'capacity temporarily unavailable');
      return retryResponse('Reply after one effect');
    }) as typeof globalThis.fetch };
  try {
    await settings(options.settingsFile); service = await LocalWebService.open(options);
    await service.submit({ id: 'retry-input', text: 'Perform one synthetic effect', occurredAt: '2026-10-14T00:00:00.000Z' });
    await until(async () => !!(await service!.status()).modelRetry, 'Retry status did not appear');
    const app = createLocalHttp({ backend: service, port: 4318 });
    try {
      const response = await app.inject({ url: '/api/status', headers: { host: '127.0.0.1:4318', 'x-mira-client': 'web' } });
      assert.equal(response.statusCode, 200); assert.equal(response.json().state, 'working');
      assert.deepEqual(response.json().modelRetry, { phase: 'waiting', attempt: 2, maxAttempts: 3, delayMs: 250, reason: 'server' });
      assert.equal(response.json().error, null); assert.doesNotMatch(response.body, /synthetic-retry-key|capacity temporarily/);
    } finally { await app.close(); }
    await until(async () => (await service!.status()).state !== 'working', 'Retry did not finish');
    assert.equal((await service.status()).state, 'idle'); assert.equal((await service.status()).modelRetry, null);
    assert.equal(calls, 3); assert.equal(bodies[1], bodies[2]); assert.equal(await readFile(effect, 'utf8'), 'once');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 1);
    const original = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.doesNotMatch(JSON.stringify(original), /capacity temporarily unavailable/);
    const timeline = await service.timeline();
    await service.close(); service = undefined; service = await LocalWebService.open(options);
    await until(async () => (await service!.status()).state !== 'working', 'Restart did not settle');
    assert.equal(calls, 3); assert.equal(await readFile(effect, 'utf8'), 'once'); assert.deepEqual(await service.timeline(), timeline);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows, original);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PG shutdown during backoff cancels its timer and recovery preserves the settled tool outcome', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-model-retry-close-')); let service: LocalWebService | undefined;
  let calls = 0; const effect = path.join(root, 'effect'); let recovering = false;
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'retry-close', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), autoCompaction: { enabled: false }, dreaming: { enabled: false },
    modelFetch: (async () => {
      calls++;
      if (calls === 1) return retryResponse('', 'close-once-call', 'bash', { command: `printf once >> ${JSON.stringify(effect)}` });
      if (!recovering) { const response = retryFailure(429); response.headers.set('retry-after', '10'); return response; }
      return retryResponse('Recovered without repeating the tool');
    }) as typeof globalThis.fetch };
  try {
    await settings(options.settingsFile); service = await LocalWebService.open(options);
    await service.submit({ id: 'close-input', text: 'One synthetic effect before shutdown', occurredAt: '2026-10-14T00:00:00.000Z' });
    await until(async () => (await service!.status()).modelRetry?.phase === 'waiting', 'Retry backoff did not start');
    await service.close(); service = undefined;
    assert.equal(calls, 2); assert.equal(await readFile(effect, 'utf8'), 'once');
    recovering = true; service = await LocalWebService.open(options);
    await until(async () => (await service!.status()).state !== 'working', 'Recovery did not settle');
    assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 3);
    assert.equal(await readFile(effect, 'utf8'), 'once'); assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 1);
    assert.equal((await service.status()).modelRetry, null);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PG service keeps first-last HTTP diagnostics separate from its persisted terminal error', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-retry-terminal-pg-')); let service: LocalWebService | undefined;
  let calls = 0;
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'retry-terminal', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), autoCompaction: { enabled: false }, dreaming: { enabled: false },
    modelFetch: (async () => retryFailure(503, `PUBLIC_FAILURE_${++calls}`, `attempt-${calls}`)) as typeof globalThis.fetch };
  try {
    await settings(options.settingsFile); service = await LocalWebService.open(options);
    await service.submit({ id: 'terminal-input', text: 'Synthetic failing request', occurredAt: '2026-10-14T00:00:00.000Z' });
    await until(async () => (await service!.status()).state !== 'working', 'Request did not settle');
    assert.equal((await service.status()).state, 'error'); assert.equal(calls, 3);
    const app = createLocalHttp({ backend: service, port: 4318 });
    try {
      const response = await app.inject({ url: '/api/status', headers: { host: '127.0.0.1:4318', 'x-mira-client': 'web' } });
      assert.match(response.json().error, /after 3 attempts.*PUBLIC_FAILURE_1.*PUBLIC_FAILURE_3/);
      assert.equal(response.json().modelRetry, undefined);
    } finally { await app.close(); }
    const records = JSON.stringify((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows);
    assert.match(records, /PUBLIC_FAILURE_3/); assert.doesNotMatch(records, /PUBLIC_FAILURE_1|PUBLIC_FAILURE_2/);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('runtime failure identities remain stable across polls and settings saves and change for a new failure', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-error-id-')); let service: LocalWebService | undefined;
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'error-occurrence', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), autoCompaction: { enabled: false }, dreaming: { enabled: false },
    modelFetch: (async () => retryFailure(400, 'Unsupported parameter: reasoning_effort')) as typeof globalThis.fetch };
  try {
    await settings(options.settingsFile); service = await LocalWebService.open(options);
    await service.submit({ id: 'first-error', text: 'Synthetic failing request', occurredAt: '2026-10-17T00:00:00.000Z' });
    await until(async () => (await service!.status()).state === 'error', 'First error missing');
    const first = await service.status(); assert.match(first.errorId!, /^[a-f0-9-]{36}$/);
    assert.equal((await service.status()).errorId, first.errorId);
    await service.saveSettings(await service.settings()); assert.equal((await service.status()).errorId, first.errorId);
    await service.submit({ id: 'second-error', text: 'Another synthetic failing request', occurredAt: '2026-10-17T00:00:01.000Z' });
    await until(async () => (await service!.status()).state === 'error', 'Second error missing');
    const second = await service.status(); assert.notEqual(second.errorId, first.errorId); assert.deepEqual(second.error, first.error);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('configuration probe uses the service transport hook without writing settings or conversation and cancels on close', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-service-probe-')); let service: LocalWebService | undefined;
  let calls = 0; let hold = false; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'service-probe', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), autoCompaction: { enabled: false }, dreaming: { enabled: false },
    modelFetch: (async (_url, init) => {
      calls++;
      if (hold) {
        entered();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return calls === 1 ? retryFailure(400, 'Unsupported parameter: reasoning_effort') : retryResponse('OK');
    }) as typeof globalThis.fetch };
  try {
    await settings(options.settingsFile);
    const store = new WebSettingsStore(options.settingsFile, process.cwd()); const draft = await store.get();
    draft.configuration.customConnections[0]!.models[0]!.reasoning = true;
    await store.save(draft);
    service = await LocalWebService.open(options);
    await until(async () => (await service!.status()).state === 'idle', 'Startup not idle');
    const saved = await service.settings();
    const before = (await db.admin.query('SELECT count(*)::int AS n FROM context_records')).rows[0].n;
    const result = await service.probe(saved);
    assert.equal(result.status, 'supported'); assert.equal(calls, 2);
    assert.deepEqual(await service.settings(), saved);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM context_records')).rows[0].n, before);
    hold = true;
    const pending = assert.rejects(service.probe(saved)); await started;
    await service.close(); await pending; assert.equal(calls, 3);
    assert.deepEqual(await store.get(), saved);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
