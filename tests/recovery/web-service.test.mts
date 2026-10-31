import { boundedFixtureWait, providerEntered } from './service-wait-fixture.mts';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile, realpath, type FileHandle } from 'node:fs/promises';
import { constants, watch, type FSWatcher } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createLocalHttp, LocalWebService, WebHttpError, WebSettingsStore, listBuiltinCatalog, type WebSettings } from '@mira/server';
import { createAssistantMessageEventStream, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { PostgresPersistence } from '@mira/persistence';
import { readWebExtensionConfiguration } from '../../apps/server/src/web-extensions.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from './fixtures.mts';

async function settled(service: LocalWebService): Promise<void> {
  const end = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > end) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type BatchReader = ReturnType<PostgresPersistence['history']>;
type BatchRequest = Parameters<BatchReader['readBatch']>[0];
/** Observe real original batches, including those read inside a timeline snapshot. */
function instrumentBatches(t: TestContext, miraId: string, hook: (request: BatchRequest, read: BatchReader['readBatch']) => ReturnType<BatchReader['readBatch']>): void {
  const realHistory = PostgresPersistence.prototype.history;
  const instrument = (reader: BatchReader): BatchReader => {
    const readBatch = reader.readBatch.bind(reader);
    t.mock.method(reader, 'readBatch', (request: BatchRequest) => hook(request, readBatch));
    const snapshot = reader.snapshot.bind(reader);
    t.mock.method(reader, 'snapshot', <T,>(work: (inner: BatchReader) => Promise<T>) => snapshot(inner => work(inner === reader ? inner : instrument(inner))));
    return reader;
  };
  t.mock.method(PostgresPersistence.prototype, 'history', function (this: PostgresPersistence, id: string) {
    const history = realHistory.call(this, id);
    return id === miraId ? instrument(history) : history;
  });
}

type TimelinePage = Awaited<ReturnType<LocalWebService['timeline']>>;
async function seedTimelineEvents(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string, count: number,
  isVisible: (index: number) => boolean): Promise<TimelinePage['items']> {
  const writer = await db.acquire(miraId);
  const expected: Omit<TimelinePage['items'][number], 'id'>[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const visible = isVisible(index); const id = `timeline-${index}`;
      const occurredAt = new Date(Date.UTC(2026, 9, 1) + index).toISOString();
      const text = visible ? `Visible message ${index}` : `PRIVATE_PAGINATION_EVENT_${index}`;
      // Real durable event-only receipts avoid thousands of synthetic model
      // turns. No raw SQL inserts or fabricated History pages are involved.
      await writer.receive({ id, source: visible ? 'user' : 'system', type: visible ? 'web.message' : 'internal.observation', occurredAt, payload: { text } });
      if (visible) expected.push({ externalEventId: id, role: 'user', text, occurredAt });
    }
  } finally { await writer.close(); }
  const ids = new Map((await db.admin.query<{ event_id: string; history_id: string }>(
    'SELECT event_id, history_id FROM life_events WHERE mira_id = $1', [miraId])).rows.map(row => [row.event_id, row.history_id]));
  assert.equal(ids.size, count);
  return expected.map(item => ({ ...item, id: ids.get(item.externalEventId!)! }));
}

test('HTTP timeline fills visible pages across hidden history without truncating or losing the raw continuation', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-visible-pages-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  try {
    const expected = await seedTimelineEvents(db, 'visible-pages', 400, index => index < 100 || (index >= 140 && index < 200));
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'visible-pages', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => { throw Error('Timeline reads must not create a model request'); } };
    service = await LocalWebService.open(options); await settled(service);
    const history = db.store.history(options.miraId);
    const rawFirst = await history.page({ kinds: ['event', 'context', 'tool'], limit: 100 }); assert.ok(rawFirst.nextCursor);
    const rawSecond = await history.page({ kinds: ['event', 'context', 'tool'], limit: 100, before: rawFirst.nextCursor }); assert.ok(rawSecond.nextCursor);
    const rawThird = await history.page({ kinds: ['event', 'context', 'tool'], limit: 100, before: rawSecond.nextCursor }); assert.ok(rawThird.nextCursor);
    app = createLocalHttp({ backend: service, port: httpPort });
    const response = await app.inject({ url: '/api/timeline', headers: readHeaders }); assert.equal(response.statusCode, 200, response.body);
    const latest = response.json<TimelinePage>();
    assert.deepEqual(latest.items, expected.slice(100));
    assert.equal(latest.items.length, 60, 'keep the whole raw page instead of cutting off visible messages beyond the target');
    assert.equal(latest.nextCursor, rawThird.nextCursor, 'continue after all scanned raw records, including hidden ones');
    const olderResponse = await app.inject({ method: 'POST', url: '/api/timeline', headers: writeHeaders, payload: { before: latest.nextCursor } });
    assert.equal(olderResponse.statusCode, 200, olderResponse.body);
    const older = olderResponse.json<TimelinePage>(); assert.equal(older.nextCursor, null);
    const combined = [...older.items, ...latest.items];
    assert.deepEqual(combined, expected); assert.equal(new Set(combined.map(item => item.id)).size, expected.length);
    assert.doesNotMatch(response.body + olderResponse.body, /PRIVATE_PAGINATION_EVENT/);
    await app.close(); app = undefined; await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    const { Client } = await import('pg'); const connect = Client.prototype.connect; let connections = 0;
    Client.prototype.connect = function (this: InstanceType<typeof Client>, ...args: Parameters<typeof connect>) { connections++; return Reflect.apply(connect, this, args); } as typeof connect;
    try {
      // Three raw metadata pages and every uncached original share one snapshot.
      assert.deepEqual(await service.timeline(), latest); assert.equal(connections, 1, 'one connection for a whole latest response');
      assert.deepEqual(await service.timeline(latest.nextCursor!), older); assert.equal(connections, 2, 'one connection for a whole older response');
    } finally { Client.prototype.connect = connect; }
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 0);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('latest and older scan caps return empty resumable pages without rereading hidden originals', { timeout: 120_000 }, async t => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-scan-cap-'));
  let service: LocalWebService | undefined; let originalReads = 0;
  try {
    const expected = await seedTimelineEvents(db, 'scan-cap', 2305, index => index < 5);
    instrumentBatches(t, 'scan-cap', async (request, readBatch) => { originalReads += request.ids.length; return readBatch(request); });
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'scan-cap', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => { throw Error('History scanning must not create a model request'); } }); await settled(service);
    const history = db.store.history('scan-cap'); const rawCursors: string[] = []; let rawCursor: string | undefined;
    for (let scanned = 0; scanned < 2300; scanned += 100) {
      const raw = await history.page({ kinds: ['event', 'context', 'tool'], limit: 100, ...(rawCursor ? { before: rawCursor } : {}) });
      assert.equal(raw.hits.length, 100); assert.ok(raw.nextCursor); rawCursor = raw.nextCursor; rawCursors.push(rawCursor);
    }
    // The polled latest window is bounded to 300 raw records.
    const latest = await service.timeline();
    assert.deepEqual(latest.items, []); assert.equal(latest.nextCursor, rawCursors[2], 'the latest cap must stop at exactly 300 raw records');
    assert.equal(originalReads, 300);
    assert.deepEqual(await service.timeline(), latest, 'refresh retains the exact empty page and continuation');
    assert.equal(originalReads, 300, 'refresh must reuse the latest window without fetching hidden originals again');
    // An explicit older request scans up to 2000 raw records from that cursor.
    const capped = await service.timeline(latest.nextCursor!);
    assert.deepEqual(capped.items, []); assert.equal(capped.nextCursor, rawCursors[22], 'the older cap must stop at exactly 2000 raw records');
    assert.equal(originalReads, 2300);
    assert.deepEqual(await service.timeline(latest.nextCursor!), capped, 'an older retry retains the exact empty page and continuation');
    assert.deepEqual(await service.timeline(), latest);
    assert.equal(originalReads, 2300, 'retries and polls reuse both cached windows');
    const older = await service.timeline(capped.nextCursor!);
    assert.deepEqual(older.items, expected); assert.equal(older.nextCursor, null);
    assert.deepEqual(await service.timeline(capped.nextCursor!), older, 'a retry must retain every visible item exactly once');
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent latest and older PostgreSQL reads retain complete pages during cache eviction', { timeout: 180_000 }, async t => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-cache-pages-'));
  let service: LocalWebService | undefined; let pendingLatest: Promise<TimelinePage> | undefined; let pauseNextCachedBatch = false;
  const entered = deferred(); const release = deferred(); const batchSizes: number[] = [];
  try {
    const expected = await seedTimelineEvents(db, 'cache-pages', 4100, () => true);
    instrumentBatches(t, 'cache-pages', async (request, readBatch) => {
      batchSizes.push(request.ids.length);
      assert.ok(request.ids.length <= 10); assert.equal(request.maxBytes, 1_048_576);
      // Only schedule the real reader; metadata and missing originals still
      // come from PostgreSQL. The empty batch yields after the cache snapshot.
      if (pauseNextCachedBatch && request.ids.length === 0) {
        pauseNextCachedBatch = false; entered.resolve();
        await boundedFixtureWait(release.promise, 'concurrent older page evicts cached latest records', t.signal, 30_000);
      }
      return readBatch(request);
    });
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'cache-pages', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => { throw Error('Cache reads must not create a model request'); } }); await settled(service);
    const latest = await service.timeline(); assert.deepEqual(latest.items, expected.slice(4000));
    let page = latest;
    for (let index = 38; index >= 0; index--) {
      assert.ok(page.nextCursor); page = await service.timeline(page.nextCursor);
      assert.deepEqual(page.items, expected.slice((index + 1) * 100, (index + 2) * 100));
    }
    assert.ok(page.nextCursor, '100 older records remain outside the full 4000-entry cache');
    pauseNextCachedBatch = true; pendingLatest = service.timeline();
    await boundedFixtureWait(entered.promise, 'latest page captures its cached metadata', t.signal);
    const oldest = await service.timeline(page.nextCursor);
    assert.deepEqual(oldest.items, expected.slice(0, 100)); assert.equal(oldest.nextCursor, null);
    release.resolve(); assert.deepEqual(await pendingLatest, latest); pendingLatest = undefined;
    assert.deepEqual(await service.timeline(), latest, 'a fresh latest request also survives the older-page eviction');
    assert.ok(batchSizes.includes(10)); assert.ok(batchSizes.includes(0));
  } finally {
    release.resolve(); await pendingLatest?.catch(() => {});
    await service?.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});

test('a pending real publication is reread after its durable outcome instead of being cached as hidden', { timeout: 60_000 }, async t => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-pending-publication-'));
  let service: LocalWebService | undefined; let calls = 0;
  const entered = deferred(); const release = deferred();
  try {
    const file = path.join(root, 'published.txt'); await writeFile(file, 'Immutable pending publication bytes');
    const realAcquire = PostgresPersistence.prototype.acquire;
    t.mock.method(PostgresPersistence.prototype, 'acquire', async function (this: PostgresPersistence, miraId: string) {
      const writer = await realAcquire.call(this, miraId);
      if (miraId === 'pending-publication') {
        const finishTool = writer.finishTool.bind(writer);
        t.mock.method(writer, 'finishTool', async (outcome: Parameters<typeof finishTool>[0]) => {
          if (outcome.callId === 'pending-publication-tool') {
            entered.resolve();
            await boundedFixtureWait(release.promise, 'allow real publication outcome to commit', t.signal, 30_000);
          }
          return finishTool(outcome);
        });
      }
      return writer;
    });
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'pending-publication', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => { calls++; return streamOf(calls === 1 ? { ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'pending-publication-tool', name: 'send_attachment', arguments: { paths: [file], text: 'Published after pending reads' } },
      ] } : assistant('')); } };
    service = await LocalWebService.open(options); await settled(service);
    await service.submit({ id: 'publish-request', text: 'Publish the local fixture file.', occurredAt: '2026-10-01T00:00:00.000Z' });
    await boundedFixtureWait(entered.promise, 'real attachment tool reaches outcome persistence', t.signal);
    const execution = (await db.admin.query<{ history_id: string; outcome: unknown }>(
      'SELECT history_id, outcome FROM tool_executions WHERE mira_id = $1', [options.miraId])).rows[0];
    assert.ok(execution); assert.equal(execution.outcome, null);
    for (let read = 0; read < 2; read++) {
      const pending = await service.timeline();
      assert.ok(!pending.items.some(item => item.id === execution.history_id || item.attachments?.length));
    }
    release.resolve(); await settled(service); assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 2);
    const published = await service.timeline();
    const item = published.items.find(item => item.id === execution.history_id); assert.ok(item);
    assert.equal(item.text, 'Published after pending reads'); assert.equal(item.attachments?.length, 1);
    assert.equal((await service.readAttachment(item.attachments![0]!.id)).bytes.toString(), 'Immutable pending publication bytes');
    assert.equal(published.items.filter(candidate => candidate.id === item.id).length, 1);
    assert.doesNotMatch(JSON.stringify(published), /pending-publication-tool|requestedArguments/);
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    assert.equal(calls, 2, 'completed publication must not replay on restart');
    assert.deepEqual(await service.timeline(), published);
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP timeline reads committed commentary while its real Bash tool is still in flight', { timeout: 30_000 }, async t => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-commentary-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  let fifo: FileHandle | undefined; let watcher: FSWatcher | undefined; let released = false; let requests = 0;
  const release = async () => { if (fifo && !released) { released = true; await fifo.write('continue\n'); } };
  try {
    const fifoPath = path.join(root, 'release.fifo'); const started = deferred();
    await promisify(execFile)('mkfifo', [fifoPath]);
    // Keeping both FIFO ends open makes release safe even if an earlier assertion
    // fails before Bash reaches its read; cleanup never waits for a new reader.
    fifo = await open(fifoPath, constants.O_RDWR | constants.O_NONBLOCK);
    watcher = watch(root, (_event, filename) => { if (filename?.toString() === 'tool-started') started.resolve(); });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [`exec 3< ${quote(fifoPath)}`, `mkdir ${quote(path.join(root, 'tool-started'))}`, 'IFS= read -r release <&3', "printf 'PRIVATE_COMMENTARY_TOOL_RESULT'"].join('\n');
    const commentary = 'I will inspect the local evidence before reporting the result.';
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'live-commentary', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: () => {
        requests++;
        return streamOf(requests === 1 ? { ...assistant(), stopReason: 'toolUse', content: [
          { type: 'thinking', thinking: 'PRIVATE_COMMENTARY_THINKING' }, { type: 'text', text: commentary },
          { type: 'toolCall', id: 'PRIVATE_COMMENTARY_CALL', name: 'bash', arguments: { command } },
        ] } : assistant('The local evidence has been checked.'));
      } };
    service = await LocalWebService.open(options); await settled(service);
    const http = createLocalHttp({ backend: service, port: httpPort }); app = http;
    const submitted = await http.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders,
      payload: { id: 'live-commentary-input', text: 'Check the local evidence.', occurredAt: '2026-10-17T08:00:00.000Z' } });
    assert.equal(submitted.statusCode, 201, submitted.body);
    await boundedFixtureWait(started.promise, 'real Bash reached its FIFO read', t.signal);
    assert.equal(requests, 1, 'the next model request cannot have started during the blocked tool');
    const executions = (await db.admin.query('SELECT t.intent, t.outcome, c.envelope FROM tool_executions t JOIN context_records c ON c.mira_id = t.mira_id AND c.record_id = t.assistant_record_id')).rows;
    assert.equal(executions.length, 1); assert.equal(executions[0].outcome, null, 'real tool intent exists while its outcome is still pending');
    assert.equal(executions[0].envelope.id, executions[0].intent.assistantRecordId);
    assert.match(JSON.stringify(executions[0].envelope), /I will inspect the local evidence/);
    assert.match(JSON.stringify(executions[0].envelope), /PRIVATE_COMMENTARY_CALL/);
    const cursor = (await db.store.history('live-commentary').page({ kinds: ['event', 'context', 'tool'], limit: 1 })).nextCursor;
    assert.ok(cursor);
    for (const request of [{ url: '/api/timeline', headers: readHeaders },
      { method: 'POST' as const, url: '/api/timeline', headers: writeHeaders, payload: { before: cursor } }]) {
      const response = await http.inject(request); assert.equal(response.statusCode, 200, response.body);
      const item = response.json().items.find((item: { text: string }) => item.text === commentary);
      assert.ok(item, 'commentary is readable before the real Bash tool is released');
      assert.equal(item.id, executions[0].intent.assistantRecordId);
      assert.doesNotMatch(response.body, /PRIVATE_COMMENTARY_|release\.fifo|requestedArguments|Mira System Prompt/);
      assert.equal(requests, 1); assert.equal((await service.status()).state, 'working');
    }
    await release(); await settled(service);
    assert.equal(requests, 2); assert.equal((await service.status()).state, 'idle');
    const final = await http.inject({ url: '/api/timeline', headers: readHeaders });
    assert.equal(final.statusCode, 200); assert.match(final.body, /The local evidence has been checked/);
    assert.equal(final.json().items.filter((item: { text: string }) => item.text === commentary).length, 1);
    assert.ok((await db.admin.query('SELECT outcome FROM tool_executions')).rows[0].outcome);
  } finally {
    await release(); watcher?.close();
    await app?.close(); await service?.close(); await fifo?.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});
test('default web extension configuration exposes real management dispatch and restores it with PostgreSQL', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-default-extensions-'));
  let service: LocalWebService | undefined; let requests = 0;
  try {
    const extensions = await readWebExtensionConfiguration(root);
    const original = await readFile(extensions.configurationFile, 'utf8');
    assert.deepEqual(extensions.entries, []);
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'default-extensions', sourceDirectory: process.cwd(),
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), miraHome: root, synthetic: true,
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        requests++;
        const names = getCurrentTools(context.messages).map(tool => tool.name);
        for (const name of ['extension_stage', 'extension_inspect', 'extension_manage']) assert.ok(names.includes(name), `Missing ${name} in the actual request`);
        if (requests === 1 || requests === 3) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: `default-inspect-${requests}`, name: 'extension_inspect', arguments: {} },
        ] });
        const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === `default-inspect-${requests - 1}`);
        assert.ok(result?.role === 'toolResult' && !result.isError && result.content[0]?.type === 'text');
        const inspected = JSON.parse(result.content[0].text);
        assert.deepEqual(inspected.extensions, []); assert.deepEqual(inspected.releases, []); assert.deepEqual(inspected.changes, []);
        return streamOf(assistant('Default extension management is available'));
      } };
    service = await LocalWebService.open({ ...options, extensions }); await settled(service);
    assert.equal(requests, 0, 'default startup must not create a Wake or provider request');
    await service.submit({ id: 'default-inspect-before-restart', text: 'Inspect the configured extensions', occurredAt: '2026-10-07T08:00:00.000Z' });
    await settled(service); assert.equal((await service.status()).state, 'idle'); assert.equal(requests, 2);
    await service.close(); service = undefined;
    service = await LocalWebService.open({ ...options, extensions: await readWebExtensionConfiguration(root) }); await settled(service);
    assert.equal(requests, 2, 'restart must not replay completed management tools');
    await service.submit({ id: 'default-inspect-after-restart', text: 'Inspect them again after restart', occurredAt: '2026-10-07T08:01:00.000Z' });
    await settled(service); assert.equal((await service.status()).state, 'idle'); assert.equal(requests, 4);
    const executions = (await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows;
    assert.equal(executions.length, 2);
    for (const execution of executions) { assert.equal(execution.intent.toolName, 'extension_inspect'); assert.ok(execution.outcome); }
    assert.equal(await readFile(extensions.configurationFile, 'utf8'), original);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('local web composition persists one timeline, hides system/thinking, deduplicates uncertain submits and restores after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-service-'));
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
    const userItem = timeline.items.find(item => item.role === 'user')!;
    assert.equal(userItem.externalEventId, input.id);
    assert.notEqual(userItem.id, input.id);
    assert.match(userItem.id, /^[0-9a-f-]{36}$/);
    const source = await db.store.history('web-mira').read({ id: userItem.id });
    assert.equal(source?.kind, 'event');
    assert(timeline.items.every(item => /^[0-9a-f-]{36}$/.test(item.id)));
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

test('tool activity stays out of both timeline routes while durable execution and protocol pairs survive restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-hidden-tools-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  let calls = 0; const contexts: TranscriptContext[] = [];
  try {
    const file = path.join(root, 'PRIVATE_TOOL_PATH_SENTINEL.txt');
    await writeFile(file, 'PRIVATE_TOOL_RESULT_SENTINEL');
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'hidden-tools', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        contexts.push(structuredClone(context)); calls++;
        return streamOf(calls === 1 ? { ...assistant(), stopReason: 'toolUse', content: [
          { type: 'thinking', thinking: 'PRIVATE_THINKING_SENTINEL' },
          { type: 'toolCall', id: 'PRIVATE_TOOL_CALL_SENTINEL', name: 'read', arguments: { path: file } },
        ] } : assistant(`Visible reply ${calls}`));
      } };
    service = await LocalWebService.open(options); await settled(service);
    await service.submit({ id: 'tool-request', text: 'Read the synthetic fixture', occurredAt: '2026-10-06T08:00:00.000Z' });
    await settled(service); assert.equal(calls, 2); assert.equal((await service.status()).state, 'idle');
    const executed = await db.admin.query('SELECT intent, outcome FROM tool_executions');
    assert.equal(executed.rowCount, 1);
    assert.match(JSON.stringify(executed.rows), /PRIVATE_TOOL_PATH_SENTINEL/);
    assert.match(JSON.stringify(executed.rows), /PRIVATE_TOOL_RESULT_SENTINEL/);
    const originalRecords = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.match(JSON.stringify(originalRecords), /PRIVATE_TOOL_CALL_SENTINEL/);
    assert.match(JSON.stringify(originalRecords), /PRIVATE_TOOL_RESULT_SENTINEL/);
    const timeline = await service.timeline();
    assert.deepEqual(Object.keys(timeline).sort(), ['items', 'nextCursor']);
    assert.doesNotMatch(JSON.stringify(timeline), /PRIVATE_TOOL_|PRIVATE_THINKING/);
    assert.match(JSON.stringify(timeline), /Visible reply 2/);
    // The ordinary opaque cursor can request an empty older page; both HTTP
    // response paths must omit all tool-display fields.
    const cursor = (await db.store.history('hidden-tools').page({ kinds: ['event', 'context', 'tool'], limit: 1 })).nextCursor;
    assert.ok(cursor);
    const http = createLocalHttp({ backend: service, port: httpPort }); app = http;
    for (const request of [
      { url: '/api/timeline', headers: readHeaders },
      { method: 'POST' as const, url: '/api/timeline', headers: writeHeaders, payload: { before: cursor } },
    ]) {
      const response = await http.inject(request); assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(Object.keys(response.json()).sort(), ['items', 'nextCursor']);
      assert.doesNotMatch(response.body, /PRIVATE_TOOL_|PRIVATE_THINKING/);
    }
    await app.close(); app = undefined; await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service); assert.equal(calls, 2);
    assert.deepEqual(await service.timeline(), timeline);
    assert.deepEqual((await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows, executed.rows);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows, originalRecords);
    await service.submit({ id: 'after-hidden-tool', text: 'Continue after the read', occurredAt: '2026-10-06T08:01:00.000Z' });
    await settled(service); assert.equal(calls, 3);
    for (const context of contexts.slice(1)) {
      const call = context.messages.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === 'PRIVATE_TOOL_CALL_SENTINEL'));
      const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'PRIVATE_TOOL_CALL_SENTINEL');
      assert.ok(call); assert.ok(result); assert.match(JSON.stringify(result), /PRIVATE_TOOL_RESULT_SENTINEL/);
    }
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 1);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});


// A valid deterministic RGB PNG that stays below Pi's resize limits while its
// native image result exceeds the 1 MiB public History read budget. This is
// generated test material, not a padded fake response or injected timeline row.
function oversizedPrivateReadPng(): Buffer {
  const width = 768; const height = 512;
  const rows = Buffer.alloc((width * 3 + 1) * height); let state = 0x6d697261;
  for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    rows[y * (width * 3 + 1) + x] = state & 255;
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, checksum]);
  };
  const dimensions = Buffer.alloc(13); dimensions.writeUInt32BE(width, 0); dimensions.writeUInt32BE(height, 4); dimensions[8] = 8; dimensions[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', dimensions), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('oversized ordinary image read stays private in both HTTP timeline routes and after PostgreSQL restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-private-large-image-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined; let calls = 0;
  try {
    const file = path.join(root, 'PRIVATE_OVERSIZED_IMAGE.png'); const png = oversizedPrivateReadPng();
    assert.ok(png.length > 1_048_576); await writeFile(file, png);
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'private-large-read', sourceDirectory: process.cwd(),
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: async (_model: unknown, context: TranscriptContext) => {
        calls++;
        if (calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [
          { type: 'toolCall' as const, id: 'PRIVATE_OVERSIZED_READ_CALL', name: 'read', arguments: { path: file } },
        ] });
        const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'PRIVATE_OVERSIZED_READ_CALL');
        assert.ok(result?.role === 'toolResult' && !result.isError);
        const image = result.content.find(block => block.type === 'image');
        assert.ok(image?.type === 'image' && Buffer.byteLength(image.data) > 1_048_576, 'actual read must produce an oversized native image outcome');
        assert.deepEqual(Buffer.from(image.data, 'base64'), png);
        // Give the final context record a strictly later timestamp so the
        // real older-page cursor still includes both oversized private records.
        await new Promise(resolve => setTimeout(resolve, 10));
        return streamOf(assistant('Private image inspected.'));
      } };
    service = await LocalWebService.open(options); await settled(service);
    await service.submit({ id: 'private-large-image-request', text: 'Inspect the local image privately.', occurredAt: '2000-01-01T00:00:00.000Z' });
    await settled(service); assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 2);
    const executions = (await db.admin.query<{ history_id: string; intent: unknown; outcome: unknown; bytes: number }>(
      'SELECT history_id, intent, outcome, octet_length(outcome::text)::int AS bytes FROM tool_executions')).rows;
    assert.equal(executions.length, 1); assert.ok(executions[0]!.bytes > 1_048_576);
    assert.match(JSON.stringify(executions[0]!.intent), /PRIVATE_OVERSIZED_IMAGE|PRIVATE_OVERSIZED_READ_CALL/);
    assert.ok(executions[0]!.outcome, 'the complete real tool outcome remains durable');
    const contextRows = (await db.admin.query<{ record_id: string; envelope: unknown; bytes: number }>(
      "SELECT record_id, envelope, octet_length(envelope::text)::int AS bytes FROM context_records WHERE envelope->'payload'->'message'->>'role'='toolResult' ORDER BY version")).rows;
    assert.equal(contextRows.length, 1); assert.ok(contextRows[0]!.bytes > 1_048_576);
    const history = db.store.history('private-large-read');
    // Both identities really cross the public History size limit. A private
    // context toolResult must not leak a generic size notice either.
    for (const id of [executions[0]!.history_id, contextRows[0]!.record_id]) {
      await assert.rejects(history.read({ id, maxBytes: 1_048_576 }), { code: 'too_large' });
    }
    const cursor = (await history.page({ kinds: ['event', 'context', 'tool'], limit: 1 })).nextCursor; assert.ok(cursor);
    const olderIds = (await history.page({ kinds: ['event', 'context', 'tool'], limit: 50, before: cursor })).hits.map(hit => hit.id);
    assert.ok(olderIds.includes(executions[0]!.history_id)); assert.ok(olderIds.includes(contextRows[0]!.record_id));
    const verifyRoutes = async () => {
      const http = createLocalHttp({ backend: service!, port: httpPort }); app = http;
      for (const request of [
        { url: '/api/timeline', headers: readHeaders },
        { method: 'POST' as const, url: '/api/timeline', headers: writeHeaders, payload: { before: cursor } },
      ]) {
        const response = await http.inject(request); assert.equal(response.statusCode, 200, response.body);
        const items = response.json().items as Array<{ role: string; text: string; attachments?: unknown[] }>;
        assert.deepEqual(items.filter(item => item.role === 'user').map(item => item.text), ['Inspect the local image privately.']);
        assert.ok(items.every(item => item.role === 'user' || (item.role === 'assistant' && item.text === 'Private image inspected.')), 'ordinary private tool records must not become timeline notices');
        assert.ok(items.every(item => !item.attachments?.length));
        assert.doesNotMatch(response.body, /PRIVATE_OVERSIZED|超过界面读取上限|"role":"notice"|image\/png/);
        if (request.method === undefined) assert.equal(items.length, 2);
      }
      await app.close(); app = undefined;
    };
    await verifyRoutes(); const timeline = await service.timeline();
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service); assert.equal(calls, 2, 'restart must not replay the completed private read');
    await verifyRoutes(); assert.deepEqual(await service.timeline(), timeline);
    assert.deepEqual((await db.admin.query('SELECT history_id, intent, outcome, octet_length(outcome::text)::int AS bytes FROM tool_executions')).rows, executions);
    assert.deepEqual((await db.admin.query("SELECT record_id, envelope, octet_length(envelope::text)::int AS bytes FROM context_records WHERE envelope->'payload'->'message'->>'role'='toolResult' ORDER BY version")).rows, contextRows);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('missing live model is a setup state and cannot enqueue or call a model', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-unconfigured-'));
  let service: LocalWebService | undefined;
  try {
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'unconfigured', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json') });
    assert.deepEqual(await service.status(), { state: 'idle', mode: 'live', model: null, error: null, errorId: null, modelRetry: null, identity: { name: 'Mira', ring: 'lavender', avatar: null } });
    await assert.rejects(service.submit({ id: 'setup-message', text: 'Do not send yet', occurredAt: '2026-10-06T08:00:00.000Z' }), WebHttpError);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 0);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('shutdown cancels an active model run, retains user receipt and resumes the same wake on restart', { timeout: 30_000 }, async t => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-shutdown-'));
  let service: LocalWebService | undefined; let started = false; let providerFailure: unknown;
  let originalInput: TranscriptContext['messages'][number] | undefined;
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'cancelled', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true };
    service = await LocalWebService.open({ ...options, syntheticStream: (_model, context, streamOptions) => {
      try {
        originalInput = structuredClone(context.messages.find(message => message.role === 'user'));
        assert.ok(originalInput?.role === 'user'); assert.match(String(originalInput.content), /\[user \| "2026-10-06T08:00:00.000Z" \| History ID "[0-9a-f-]{36}"\]\nKeep my receipt$/);
        assert.doesNotMatch(String(originalInput.content), /cancel-input|web.message|Wake reason|"payload"|"event"/);
        const stream = createAssistantMessageEventStream(); started = true;
        const abort = () => { stream.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted', errorMessage: 'Cancelled fixture' } }); };
        streamOptions?.signal?.addEventListener('abort', abort, { once: true });
        if (streamOptions?.signal?.aborted) abort();
        return stream;
      } catch (error) { providerFailure = error; throw error; }
    } });
    await service.submit({ id: 'cancel-input', text: 'Keep my receipt', occurredAt: '2026-10-06T08:00:00.000Z' }); await providerEntered(service, () => started, () => providerFailure, t.signal);
    const link = await db.store.history('cancelled').findEventRun('cancel-input'); assert.ok(link);
    assert.ok(String(originalInput!.content).includes(`History ID "${link.eventId}"`), 'provider sees the exact committed user Event History UUID');
    await assert.rejects(service.saveSettings(await service.settings()), WebHttpError);
    await service.close(); service = undefined;
    service = await LocalWebService.open({ ...options, syntheticStream: (_model, context) => {
      assert.deepEqual(context.messages.filter(message => message.role === 'user'), [originalInput]);
      return streamOf(assistant('Resumed after restart'));
    } }); await settled(service);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    assert.match(JSON.stringify(await service.timeline()), /Keep my receipt/);
    assert.match(JSON.stringify(await service.timeline()), /Resumed after restart/);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('extension wake arriving during settings save is drained afterward and never displayed as a user message', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-save-wake-'));
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
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-settings-reload-'));
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
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-settings-race-'));
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
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-key-recovery-'));
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

const httpPort = 4317;
const readHeaders = { host: `127.0.0.1:${httpPort}`, 'x-mira-client': 'web' };
const writeHeaders = { ...readHeaders, origin: `http://${readHeaders.host}`, 'content-type': 'application/json' };
const diagnosticConnection = (key: string) => ({ id: 'diagnostic-fixture', baseUrl: 'https://synthetic-model.example.test/v1', api: 'openai-completions', apiKey: key,
  models: [{ id: 'offline-model', contextWindow: 65536, maxTokens: 1024, reasoning: false, input: ['text'] }] });

for (const recovery of ['restart', 'new-message'] as const) test(`live model HTTP failures persist safe diagnostics and preserve the failed Wake until ${recovery} recovery`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-model-failure-'));
  const originalFetch = globalThis.fetch; const key = 'synthetic-private-diagnostic-key';
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined; let requests = 0;
  let release!: () => void; let entered!: () => void;
  const recovering = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    globalThis.fetch = async (url, init) => {
      const call = ++requests;
      assert.equal(String(url), 'https://synthetic-model.example.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      assert.ok(!String(init?.body).includes(key));
      if (call === 1) return Response.json({ error: {
        message: `Invalid tool name history.search; apiKey=${key}; endpoint https://synthetic-model.example.test/private-error-url`,
        code: 'invalid_request_error', type: 'invalid_request_error',
        debug: { authorization: 'synthetic-unselected-header-secret', stack: 'synthetic-provider-stack-secret' },
      } }, { status: 400, headers: { 'x-request-id': 'synthetic-error-request-id' } });
      if (recovery === 'new-message') assert.match(String(init?.body), /Continue with the saved request/);
      entered(); await gate;
      return new Response([
        { id: `synthetic-${call}`, choices: [{ index: 0, delta: { role: 'assistant', content: `Recovered response ${call}` }, finish_reason: null }] },
        { id: `synthetic-${call}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, '[DONE]',
      ].map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: `model-failure-${recovery}`, sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json') };
    service = await LocalWebService.open(options); await settled(service); app = createLocalHttp({ backend: service, port: httpPort });
    const configured = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: {
      ...await service.settings(), configuration: { builtinCredentials: {}, customConnections: [diagnosticConnection(key)] },
      selection: { kind: 'custom', connection: 'diagnostic-fixture', model: 'offline-model' },
    } });
    assert.equal(configured.statusCode, 200); await settled(service); assert.equal(requests, 0);
    const input = { id: 'diagnostic-original-input', text: 'Keep this original request after the model fails', occurredAt: '2026-10-06T08:00:00.000Z' };
    const submitted = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: input });
    assert.equal(submitted.statusCode, 201); await settled(service); assert.equal(requests, 1);
    const failed = await app.inject({ url: '/api/status', headers: readHeaders }); assert.equal(failed.statusCode, 200);
    const diagnostic = failed.json<{ state: string; error: string }>().error;
    assert.equal(failed.json().state, 'error');
    assert.match(diagnostic, /Model request failed.*HTTP 400.*synthetic-error-request-id.*Invalid tool name history\.search/);
    assert.match(diagnostic, /invalid_request_error/); assert.match(diagnostic, /\[redacted\]/);
    assert.ok(diagnostic.length <= 2_100);
    const forbidden = /synthetic-private-diagnostic-key|synthetic-unselected-header-secret|synthetic-provider-stack-secret|private-error-url/;
    assert.doesNotMatch(failed.body, forbidden); assert.doesNotMatch(configured.body, forbidden);
    const failedRuns = await db.admin.query<{ run_id: string; input_record_id: string; final_record_id: string | null; completed: boolean }>('SELECT run_id, input_record_id, final_record_id, completed FROM wake_runs');
    assert.equal(failedRuns.rowCount, 1); const originalRun = failedRuns.rows[0]!;
    assert.ok(originalRun.input_record_id); assert.equal(originalRun.final_record_id, null); assert.equal(originalRun.completed, false);
    const originalInput = (await db.admin.query('SELECT envelope FROM context_records WHERE record_id = $1', [originalRun.input_record_id])).rows;
    assert.match(JSON.stringify(originalInput), /Keep this original request after the model fails/);
    const errorRecords = await db.admin.query("SELECT record_id, envelope->'payload'->'message' AS message FROM context_records WHERE envelope->'payload'->'message'->>'stopReason' = 'error'");
    assert.equal(errorRecords.rowCount, 1); assert.equal(errorRecords.rows[0].message.errorMessage, diagnostic);
    assert.deepEqual(errorRecords.rows[0].message.content, []);
    const failedTimeline = await app.inject({ url: '/api/timeline', headers: readHeaders }); assert.equal(failedTimeline.statusCode, 200);
    assert.equal(failedTimeline.json().items.filter((item: { role: string }) => item.role === 'user').length, 1);
    assert.equal(failedTimeline.json().items.filter((item: { role: string }) => item.role === 'assistant').length, 0, 'a model error is not a final assistant reply');
    assert.doesNotMatch(failedTimeline.body, forbidden);
    // Both routes must preserve the failed run without silently retrying it.
    const saved = await app.inject({ method: 'PUT', url: '/api/settings', headers: writeHeaders, payload: configured.json<WebSettings>() });
    assert.equal(saved.statusCode, 200); await settled(service); assert.equal(requests, 1);
    const duplicate = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders, payload: input });
    assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().receipt, 'duplicate'); await settled(service); assert.equal(requests, 1);
    assert.equal((await app.inject({ url: '/api/status', headers: readHeaders })).json().error, diagnostic);
    assert.deepEqual((await db.admin.query('SELECT run_id, input_record_id, final_record_id, completed FROM wake_runs')).rows, failedRuns.rows);
    if (recovery === 'restart') {
      await app.close(); app = undefined; await service.close(); service = undefined;
      service = await LocalWebService.open(options); app = createLocalHttp({ backend: service, port: httpPort });
    } else {
      const resumed = await app.inject({ method: 'POST', url: '/api/messages', headers: writeHeaders,
        payload: { id: 'diagnostic-follow-up', text: 'Continue with the saved request', occurredAt: '2026-10-06T08:01:00.000Z' } });
      assert.equal(resumed.statusCode, 201);
    }
    await recovering;
    const working = await app.inject({ url: '/api/status', headers: readHeaders });
    assert.equal(working.json().state, 'working'); assert.equal(working.json().error, null, 'new work clears the previous request diagnostic');
    release(); await settled(service);
    const recovered = await app.inject({ url: '/api/status', headers: readHeaders }); assert.equal(recovered.json().state, 'idle'); assert.equal(recovered.json().error, null);
    assert.equal(requests, 2, 'new user input resumes the same unfinished Wake before another final');
    const completed = (await db.admin.query('SELECT run_id, input_record_id, final_record_id, completed FROM wake_runs WHERE run_id = $1', [originalRun.run_id])).rows[0];
    assert.equal(completed.run_id, originalRun.run_id); assert.equal(completed.input_record_id, originalRun.input_record_id);
    assert.ok(completed.final_record_id); assert.equal(completed.completed, true);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records WHERE record_id = $1', [originalRun.input_record_id])).rows, originalInput);
    assert.deepEqual((await db.admin.query("SELECT record_id, envelope->'payload'->'message' AS message FROM context_records WHERE envelope->'payload'->'message'->>'stopReason' = 'error'")).rows, errorRecords.rows);
    const expectedEvents = recovery === 'restart' ? 1 : 2;
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE completed')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NOT NULL')).rows[0].n, expectedEvents - 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, expectedEvents);
    const timeline = await app.inject({ url: '/api/timeline', headers: readHeaders });
    assert.equal(timeline.json().items.filter((item: { role: string }) => item.role === 'user').length, expectedEvents);
    assert.equal(timeline.json().items.filter((item: { role: string }) => item.role === 'assistant').length, 1);
    assert.match(timeline.body, /Recovered response 2/); assert.doesNotMatch(timeline.body, forbidden);
    for (const table of ['context_records', 'life_events', 'wake_requests', 'wake_runs', 'wake_run_requests', 'tool_executions', 'wake_memory_checkpoints', 'wake_memory_receipts']) {
      assert.doesNotMatch(JSON.stringify((await db.admin.query(`SELECT row_to_json(t) AS record FROM ${table} t`)).rows), forbidden, table);
    }
  } finally {
    release(); await app?.close(); await service?.close(); globalThis.fetch = originalFetch; await db.close(); await rm(root, { recursive: true, force: true });
  }
});

test('a PostgreSQL failure saving a provider error shows only a fixed temporary persistence notice', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-web-model-db-failure-'));
  const originalFetch = globalThis.fetch; const key = 'synthetic-database-diagnostic-key';
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined; let requests = 0;
  try {
    // A sequence survives transaction rollback and proves the error append reached this fault.
    await db.admin.query(`CREATE SEQUENCE synthetic_error_append_attempts;
      CREATE FUNCTION synthetic_reject_model_error() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.envelope->'payload'->'message'->>'stopReason' = 'error' THEN
          PERFORM nextval('synthetic_error_append_attempts'); RAISE EXCEPTION 'synthetic-database-private-error';
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_model_error_fault BEFORE INSERT ON context_records FOR EACH ROW EXECUTE FUNCTION synthetic_reject_model_error()`);
    globalThis.fetch = async (url, init) => {
      requests++; assert.equal(String(url), 'https://synthetic-model.example.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      return Response.json({ error: { message: `synthetic-provider-before-database-failure ${key}`, code: 'invalid_request_error' } }, { status: 400 });
    };
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'model-db-failure', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json') });
    await settled(service);
    await service.saveSettings({ ...await service.settings(), configuration: { builtinCredentials: {}, customConnections: [diagnosticConnection(key)] }, selection: { kind: 'custom', connection: 'diagnostic-fixture', model: 'offline-model' } });
    await service.submit({ id: 'database-failed-input', text: 'Keep this receipt despite the storage fault', occurredAt: '2026-10-06T08:00:00.000Z' });
    // A database exception fences the writer before the drain publishes its error.
    const deadline = Date.now() + 10_000;
    while ((await service.status()).error === null) {
      if (Date.now() > deadline) throw Error('Database failure was not reported');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(requests, 1);
    assert.deepEqual((await db.admin.query('SELECT last_value::int, is_called FROM synthetic_error_append_attempts')).rows, [{ last_value: 1, is_called: true }]);
    app = createLocalHttp({ backend: service, port: httpPort });
    const status = await app.inject({ url: '/api/status', headers: readHeaders }); assert.equal(status.statusCode, 200); assert.equal(status.json().state, 'stopped');
    assert.equal(status.json().error, 'Persistence write failed and the runtime stopped. This is a temporary server notice; no durable tool diagnostic is confirmed. Check PostgreSQL and recover saved state before retrying. External tool effects may already have happened.');
    // errorId is the ephemeral per-occurrence UUID for dismissing the banner (ADR 0044), not a record ID.
    assert.deepEqual(Object.keys(status.json()).sort(), ['error', 'errorId', 'identity', 'mode', 'model', 'state'], 'status exposes no internal IDs, cause or stack');
    assert.match(status.json().errorId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.doesNotMatch(status.body, /synthetic-provider-before-database-failure|synthetic-database-private-error|synthetic-database-diagnostic-key|HTTP 400|invalid_request_error|P0001|synthetic_reject_model_error|"cause"|"stack"|"headers"|"requestId"|"request_id"/);
    const runs = (await db.admin.query('SELECT input_record_id, final_record_id, completed FROM wake_runs')).rows;
    assert.equal(runs.length, 1); assert.ok(runs[0].input_record_id); assert.equal(runs[0].final_record_id, null); assert.equal(runs[0].completed, false);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM context_records WHERE envelope->'payload'->'message'->>'role' = 'assistant'")).rows[0].n, 0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 1);
  } finally {
    await app?.close(); await service?.close(); globalThis.fetch = originalFetch; await db.close(); await rm(root, { recursive: true, force: true });
  }
});
