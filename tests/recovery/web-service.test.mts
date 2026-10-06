import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { LocalWebService, WebHttpError, WebSettingsStore, listBuiltinCatalog } from '@mira/server';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

async function settled(service: LocalWebService): Promise<void> {
  const end = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > end) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('local web composition persists one timeline, hides system/thinking, deduplicates uncertain submits and restores after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-service-');
  let service: LocalWebService | undefined; let calls = 0;
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'web-mira', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => { calls++; return streamOf({ ...assistant(), content: [{ type: 'thinking' as const, thinking: 'PRIVATE_REASONING_TEST_SENTINEL' }, { type: 'text' as const, text: 'Visible persistent reply' }] }); } };
    service = await LocalWebService.open(options); await settled(service);
    const input = { id: '11111111-1111-4111-8111-111111111111', text: 'Persist this user message', occurredAt: '2026-10-06T08:00:00.000Z' };
    assert.equal((await service.submit(input)).receipt, 'inserted');
    assert.equal((await service.submit(input)).receipt, 'duplicate');
    await settled(service); assert.equal(calls, 1);
    const timeline = await service.timeline();
    assert.equal(timeline.items.filter(item => item.role === 'user').length, 1);
    assert.equal(timeline.items.filter(item => item.role === 'assistant').length, 1);
    assert.match(JSON.stringify(timeline), /Visible persistent reply/);
    assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE_REASONING_TEST_SENTINEL|Mira System Prompt|authorizationContext|requestedArguments/);
    await assert.rejects(service.submit({ ...input, text: 'Changed retry' }));
    const settings = await service.settings(); assert.equal(settings.selection, null);
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    assert.equal(calls, 1, 'completed turns never rerun on startup');
    assert.deepEqual((await service.timeline()).items, timeline.items);
    assert.equal((await service.submit(input)).receipt, 'duplicate'); await settled(service); assert.equal(calls, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE completed')).rows[0].n, 1);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('missing live model is a setup state and cannot enqueue or call a model', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-unconfigured-');
  let service: LocalWebService | undefined;
  try {
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'unconfigured', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json') });
    assert.deepEqual(await service.status(), { state: 'idle', mode: 'live', model: null, error: null });
    await assert.rejects(service.submit({ id: 'setup-message', text: 'Do not send yet', occurredAt: '2026-10-06T08:00:00.000Z' }), WebHttpError);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 0);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('shutdown cancels an active model run, retains user receipt and resumes the same wake on restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-shutdown-');
  let service: LocalWebService | undefined; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'cancelled', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true };
    service = await LocalWebService.open({ ...options, syntheticStream: (_model, _context, streamOptions) => {
      const stream = createAssistantMessageEventStream(); entered();
      const abort = () => { stream.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted', errorMessage: 'Cancelled fixture' } }); };
      streamOptions?.signal?.addEventListener('abort', abort, { once: true });
      if (streamOptions?.signal?.aborted) abort();
      return stream;
    } });
    await service.submit({ id: 'cancel-input', text: 'Keep my receipt', occurredAt: '2026-10-06T08:00:00.000Z' }); await started;
    await assert.rejects(service.saveSettings(await service.settings()), WebHttpError);
    await service.close(); service = undefined;
    service = await LocalWebService.open({ ...options, syntheticStream: () => streamOf(assistant('Resumed after restart')) }); await settled(service);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    assert.match(JSON.stringify(await service.timeline()), /Keep my receipt/);
    assert.match(JSON.stringify(await service.timeline()), /Resumed after restart/);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('extension wake arriving during settings save is drained afterward and never displayed as a user message', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-save-wake-');
  const originalSave = WebSettingsStore.prototype.save; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const saving = new Promise<void>(resolve => { started = resolve; });
  let service: LocalWebService | undefined; let calls = 0;
  try {
    const modulePath = path.join(root, 'event-fixture.mjs');
    await writeFile(modulePath, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
      export let emit;
      export default defineExtension({name:'web-event-fixture', apply(context) { emit = () => context.requestWake({id:'extension-wake',reason:'Synthetic web settings race',event:{id:'extension-input',type:'fixture.event',occurredAt:'2026-10-06T08:00:00.000Z',payload:{text:'EXTERNAL_NOT_USER'}}}); }});`);
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'wake-during-save', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      extensions: { entries: [{ id: 'event-fixture', path: modulePath }] },
      syntheticStream: () => { calls++; return streamOf(assistant('Handled extension event')); } });
    await settled(service);
    WebSettingsStore.prototype.save = async function(value) { started(); await gate; return originalSave.call(this, value); };
    const save = service.saveSettings(await service.settings()); await saving;
    const fixture = await import(pathToFileURL(modulePath).href) as { emit(): Promise<string> };
    assert.equal(await fixture.emit(), 'inserted'); assert.equal(calls, 0);
    release(); await save; await settled(service); assert.equal(calls, 1);
    assert.equal((await service.timeline()).items.filter(item => item.role === 'user').length, 0);
    assert.match(JSON.stringify(await service.timeline()), /Handled extension event/);
    assert.doesNotMatch(JSON.stringify(await service.timeline()), /EXTERNAL_NOT_USER/);
  } finally { release(); WebSettingsStore.prototype.save = originalSave; await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('settings reload sees an external revision instead of trapping the UI in a stale conflict', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-settings-reload-');
  let service: LocalWebService | undefined;
  try {
    const settingsFile = path.join(root, 'models.json');
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'external-settings', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile });
    await settled(service); const initial = await service.settings();
    const model = listBuiltinCatalog('openai').providers[0]!.models[0]!.id;
    const external = new WebSettingsStore(settingsFile, process.cwd());
    await external.save({ ...await external.get(), configuration: { builtinCredentials: { openai: { apiKey: 'sk-synthetic-external-key' } }, customConnections: [] }, selection: { kind: 'builtin', provider: 'openai', model } });
    const reloaded = await service.settings(); assert.notEqual(reloaded.revision, initial.revision);
    assert.equal(reloaded.configuration.builtinCredentials['openai']?.hasApiKey, true);
    assert.ok(!JSON.stringify(reloaded).includes('sk-synthetic-external-key'));
    await settled(service);
    assert.equal((await service.status()).model, model, 'displayed disk selection and next-Wake runtime agree');
    await service.saveSettings(reloaded);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('a stale settings read cannot replace a successfully saved model selection', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-settings-race-');
  const originalGet = WebSettingsStore.prototype.get; let service: LocalWebService | undefined;
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const models = listBuiltinCatalog('openai').providers[0]!.models;
    const settingsFile = path.join(root, 'models.json');
    const initialStore = new WebSettingsStore(settingsFile, process.cwd());
    await initialStore.save({ ...await initialStore.get(), configuration: { builtinCredentials: { openai: { apiKey: 'sk-synthetic-race-key' } }, customConnections: [] }, selection: { kind: 'builtin', provider: 'openai', model: models[0]!.id } });
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'settings-race', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile });
    await settled(service); const current = await service.settings(); let delay = true;
    WebSettingsStore.prototype.get = async function() { const result = await originalGet.call(this); if (delay) { delay = false; entered(); await gate; } return result; };
    const oldRead = service.settings(); await started;
    const saved = await service.saveSettings({ ...current, selection: { kind: 'builtin', provider: 'openai', model: models[1]!.id } });
    release(); await oldRead;
    assert.equal((await service.status()).model, models[1]!.id);
    assert.deepEqual((await service.settings()).selection, saved.selection);
  } finally { release(); WebSettingsStore.prototype.get = originalGet; await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('live WebService resolves saved dummy keys after restart and never records them in PostgreSQL or timeline', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-web-key-recovery-');
  const key = 'synthetic-server-only-recovery-key'; const originalFetch = globalThis.fetch;
  const oldAmbient = process.env['MIRA_WEB_EXPLICIT_KEY']; let requests = 0; let service: LocalWebService | undefined;
  try {
    process.env['MIRA_WEB_EXPLICIT_KEY'] = 'synthetic-ambient-key-must-not-be-used';
    globalThis.fetch = async (input, init) => {
      requests++; assert.equal(String(input), 'https://synthetic-model.example.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      assert.ok(!String(init?.body).includes(key));
      return new Response([
        { id: `synthetic-${requests}`, choices: [{ index: 0, delta: { role: 'assistant', content: `Saved-key response ${requests}` }, finish_reason: null }] },
        { id: `synthetic-${requests}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, '[DONE]',
      ].map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'web-private-key', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json') };
    service = await LocalWebService.open(options); await settled(service);
    const saved = await service.saveSettings({ ...await service.settings(), configuration: { builtinCredentials: {}, customConnections: [{ id: 'fixture', baseUrl: 'https://synthetic-model.example.test/v1', api: 'openai-completions', apiKey: key,
      models: [{ id: 'offline-model', contextWindow: 65536, maxTokens: 1024, reasoning: false, input: ['text'] }] }] }, selection: { kind: 'custom', connection: 'fixture', model: 'offline-model' } });
    await settled(service); assert.equal(requests, 0); assert.ok(!JSON.stringify(saved).includes(key));
    await service.submit({ id: 'key-first', text: 'Persist a safe response', occurredAt: '2026-10-06T08:00:00.000Z' }); await settled(service);
    assert.equal((await service.status()).state, 'idle'); assert.equal(requests, 1);
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    const reloaded = await service.settings(); assert.equal(reloaded.configuration.customConnections[0]?.hasApiKey, true); assert.equal(reloaded.revision, saved.revision);
    await service.submit({ id: 'key-second', text: 'Continue after restart', occurredAt: '2026-10-06T08:01:00.000Z' }); await settled(service);
    assert.equal((await service.status()).state, 'idle'); assert.equal(requests, 2);
    const timeline = await service.timeline(); assert.match(JSON.stringify(timeline), /Saved-key response 1/); assert.match(JSON.stringify(timeline), /Saved-key response 2/); assert.ok(!JSON.stringify(timeline).includes(key));
    for (const table of ['context_records', 'life_events', 'wake_requests', 'wake_runs', 'wake_run_requests', 'tool_executions', 'wake_memory_checkpoints', 'wake_memory_receipts']) {
      const rows = await db.admin.query(`SELECT row_to_json(t) AS record FROM ${table} t`); assert.ok(!JSON.stringify(rows.rows).includes(key), table);
    }
    assert.ok((await readFile(options.settingsFile, 'utf8')).includes(key));
    const removed = await service.saveSettings({ ...reloaded, configuration: { builtinCredentials: {}, customConnections: [{ ...reloaded.configuration.customConnections[0]!, apiKey: null }] } });
    assert.equal(removed.configuration.customConnections[0]?.hasApiKey, false); await settled(service);
    await assert.rejects(service.submit({ id: 'no-key', text: 'Must not enqueue', occurredAt: '2026-10-06T08:02:00.000Z' }), WebHttpError);
    assert.equal(requests, 2); assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 2);
    assert.ok(!(await readFile(options.settingsFile, 'utf8')).includes(key));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAmbient === undefined) delete process.env['MIRA_WEB_EXPLICIT_KEY']; else process.env['MIRA_WEB_EXPLICIT_KEY'] = oldAmbient;
    await service?.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});
