import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService, WebSettingsStore, createLocalHttp } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { retryConfiguration, retrySelection, retryResponse, syntheticRetryKey } from './model-retry-fixtures.mts';

const occurredAt = '2026-10-14T00:00:00.000Z';
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function settings(file: string): Promise<void> {
  const store = new WebSettingsStore(file, process.cwd()); const current = await store.get();
  await store.save({ revision: current.revision, selection: retrySelection, configuration: { builtinCredentials: {}, customConnections: retryConfiguration.customConnections.map(({ apiKeyEnv: _env, ...connection }) => ({ ...connection, apiKey: syntheticRetryKey })) } });
}
/** DeepSeek's real 402 body shape: the code field does not say "balance". */
const deepseek402 = (requestId = 'balance-request-1') => new Response(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } }), { status: 402, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
const openai429Quota = () => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }), { status: 429, headers: { 'content-type': 'application/json', 'x-request-id': 'quota-request' } });
const quiet = () => new Promise(resolve => setTimeout(resolve, 300));
type Service = LocalWebService;
const notices = async (service: Service) => (await service.timeline()).items.filter(item => item.role === 'notice' && item.notice === 'balance');

function setup(prefix: string) {
  return (async () => {
    const db = await createTestDatabase(); const root = await realpath(await mkdtemp(`/tmp/${prefix}-`));
    const options = (miraId: string, fetch: typeof globalThis.fetch) => ({ connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), autoCompaction: { enabled: false as const }, dreaming: { enabled: false },
      modelFetch: fetch });
    await settings(path.join(root, 'models.json'));
    return { db, root, options };
  })();
}

test('real PG/service: 402 pauses once without retries; restart, external Wakes and repeated kicks never resume; only a user message does, and a second 402 pauses again', { timeout: 60_000 }, async () => {
  const { db, root, options } = await setup('mira-balance-pause'); let service: Service | undefined;
  const effect = path.join(root, 'effect'); let calls = 0; const plan: Array<() => Response> = [
    () => retryResponse('', 'balance-effect', 'bash', { command: `printf once >> ${JSON.stringify(effect)}` }),
    () => deepseek402(),
  ];
  const fetch = (async () => { calls++; const next = plan.shift(); if (!next) throw Error('unexpected model request'); return next(); }) as typeof globalThis.fetch;
  const configuration = options('balance-service', fetch);
  try {
    service = await LocalWebService.open(configuration);
    await service.submit({ id: 'balance-input', text: 'Do one effect then answer', occurredAt });
    await until(async () => (await service!.status()).state === 'paused', 'Balance pause did not appear');
    // Exactly one 402 request: no transport retry loop.
    assert.equal(calls, 2); assert.equal(await readFile(effect, 'utf8'), 'once');
    const status = await service.status();
    assert.equal(status.error, null); assert.equal(status.modelRetry, null);
    assert.deepEqual({ ...status.pause, since: undefined }, { reason: 'balance', since: undefined, status: 402, requestId: 'balance-request-1', provider: 'retry-test', model: 'retry-model' });
    const [notice] = await notices(service);
    assert.ok(notice); assert.deepEqual((notice as { balance?: unknown }).balance, { status: 402, requestId: 'balance-request-1', provider: 'retry-test' });
    assert.match(notice.text, /余额不足/); assert.match(notice.text, /所有动作都已停下/); assert.match(notice.text, /充值后发一条消息/); assert.doesNotMatch(notice.text, /结果未知|工具/);
    const app = createLocalHttp({ backend: service, port: 4318 });
    try {
      const response = await app.inject({ url: '/api/status', headers: { host: '127.0.0.1:4318', 'x-mira-client': 'web' } });
      assert.equal(response.statusCode, 200); assert.equal(response.json().state, 'paused'); assert.equal(response.json().pause.status, 402); assert.equal(response.json().error, null);
      const timeline = await app.inject({ url: '/api/timeline', headers: { host: '127.0.0.1:4318', 'x-mira-client': 'web' } });
      const projected = timeline.json().items.filter((item: { notice?: string }) => item.notice === 'balance');
      assert.equal(projected.length, 1); assert.deepEqual(projected[0].balance, { status: 402, requestId: 'balance-request-1', provider: 'retry-test' });
    } finally { await app.close(); }
    // An external Wake is stored durably but does not start cognition.
    const event = { id: 'paused-external', type: 'fixture.status', occurredAt, payload: { text: 'EXTERNAL_WHILE_PAUSED' } };
    assert.equal((await service.external.requestWake('synthetic-sender', { id: 'paused-wake', reason: 'Synthetic rule', event })).receipt, 'inserted');
    await service.settings(); await quiet();
    assert.equal(calls, 2); assert.equal((await service.status()).state, 'paused');
    // Restart: the durable pause is restored, the paused run is not resumed.
    await service.close(); service = undefined; service = await LocalWebService.open(configuration); await quiet();
    assert.equal(calls, 2); assert.equal((await service.status()).state, 'paused'); assert.equal((await service.status()).pause?.requestId, 'balance-request-1');
    assert.equal((await notices(service)).length, 1);
    // A user message resumes the same run directly (no balance pre-check). A second 402 pauses again.
    plan.push(() => deepseek402('balance-request-2'));
    await service.submit({ id: 'balance-retry-1', text: '充好了，继续', occurredAt });
    await until(async () => (await service!.status()).pause?.requestId === 'balance-request-2', 'Second pause did not appear');
    assert.equal(calls, 3); assert.equal((await notices(service)).length, 2); assert.equal((await service.status()).state, 'paused');
    // 已读 (ADR 0050): a message stuck behind the balance refusal is not shown as read.
    assert.equal((await service.timeline()).items.filter(item => item.role === 'user').at(-1)?.read, undefined);
    // Restart once more, then the second user message succeeds and the queued external Wake runs after it.
    await service.close(); service = undefined; service = await LocalWebService.open(configuration); await quiet();
    assert.equal(calls, 3); assert.equal((await service.status()).pause?.requestId, 'balance-request-2');
    plan.push(() => retryResponse('Finished after top-up'), () => retryResponse('Handled the queued external event'));
    await service.submit({ id: 'balance-retry-2', text: '这次真的充好了', occurredAt });
    await until(async () => (await service!.status()).state === 'idle' && calls === 5, 'Resume did not finish');
    const final = await service.status(); assert.equal(final.pause, undefined); assert.equal(final.error, null);
    assert.equal(await readFile(effect, 'utf8'), 'once');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 1);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type' = 'model.balance-resumed'")).rows[0].n, 2);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM wake_requests w JOIN life_events e USING (mira_id, event_id) WHERE e.event->>'type' LIKE 'model.balance-%'")).rows[0].n, 0, 'pause events never wake');
    const texts = (await service.timeline()).items.map(item => item.text);
    assert.ok(texts.includes('Finished after top-up')); assert.ok(texts.includes('Handled the queued external event'));
    // All user messages here share occurredAt, so which one is latest is a tie; after the resume it is read.
    assert.equal((await service.timeline()).items.filter(item => item.role === 'user').at(-1)?.read, true);
    // Restart after completion stays idle.
    await service.close(); service = undefined; service = await LocalWebService.open(configuration); await quiet();
    assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 5);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PG/service: OpenAI 429 insufficient_quota is not retried and pauses like 402', { timeout: 30_000 }, async () => {
  const { db, root, options } = await setup('mira-quota-pause'); let service: Service | undefined; let calls = 0;
  try {
    service = await LocalWebService.open(options('quota-service', (async () => { calls++; return openai429Quota(); }) as typeof globalThis.fetch));
    await service.submit({ id: 'quota-input', text: 'hello', occurredAt });
    await until(async () => (await service!.status()).state === 'paused', 'Quota pause did not appear');
    await quiet(); assert.equal(calls, 1); assert.equal((await service.status()).pause?.status, 429);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PG/service: an interrupted tool stays unknown across a balance pause and its resume', { timeout: 60_000 }, async () => {
  const { db, root, options } = await setup('mira-balance-unknown'); let service: Service | undefined;
  const effect = path.join(root, 'effect'); let calls = 0; const plan: Array<() => Response> = [
    () => retryResponse('', 'unknown-effect', 'bash', { command: `printf started >> ${JSON.stringify(effect)}; sleep 30` }),
  ];
  const fetch = (async () => { calls++; const next = plan.shift(); if (!next) throw Error('unexpected model request'); return next(); }) as typeof globalThis.fetch;
  const configuration = options('unknown-service', fetch);
  try {
    service = await LocalWebService.open(configuration);
    await service.submit({ id: 'unknown-input', text: 'Run the long effect', occurredAt });
    await until(async () => { try { return (await readFile(effect, 'utf8')) === 'started'; } catch { return false; } }, 'Effect did not start');
    await service.close(); service = undefined;
    const before = (await db.admin.query('SELECT outcome FROM tool_executions')).rows;
    assert.equal(before.length, 1);
    plan.push(() => deepseek402('unknown-402'));
    service = await LocalWebService.open(configuration);
    await until(async () => (await service!.status()).state === 'paused', 'Recovery did not pause');
    const paused = (await db.admin.query('SELECT outcome FROM tool_executions')).rows;
    plan.push(() => retryResponse('The earlier command result is unknown'));
    await service.submit({ id: 'unknown-resume', text: '继续', occurredAt });
    await until(async () => (await service!.status()).state === 'idle', 'Resume did not finish');
    // The unknown result is never rewritten as success or failure and the effect never repeats.
    assert.deepEqual((await db.admin.query('SELECT outcome FROM tool_executions')).rows, paused);
    assert.equal(await readFile(effect, 'utf8'), 'started');
    const context = JSON.stringify((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows);
    assert.match(context, /unknown|未知|interrupted/i);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
