import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { resolveWebMiraHome } from '../../apps/server/src/web-config.ts';
import { renderWakeBatch } from '@mira/life';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, model, runtime, seed, streamOf } from './fixtures.mts';

function systemText(context: TranscriptContext): string {
  const system = getCurrentSystemMessage(context.messages);
  return system ? getSystemMessageText(system) : '';
}
function isSummary(context: TranscriptContext): boolean {
  return systemText(context).startsWith('你负责压缩 Mira 的 Working Context');
}
const largeModel = { ...model, contextWindow: 65536 };
const automatic = { enabled: true, threshold: 0.3, reserveTokens: 512, keepRecentTokens: 1 };
const disabled = { enabled: false };
async function rawHistory(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string) {
  return (await db.admin.query('SELECT version, record_id, parent_id, envelope::text AS raw FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId])).rows;
}

test('real PostgreSQL: automatic compaction refreshes initially empty Memory and restart uses its durable snapshot', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-pg-auto-memory-'));
  try {
    const file = path.join(directory, 'MEMORY.md'); await writeFile(file, '');
    let loads = 0, summaries = 0, requests = 0;
    const miraPrompt = {
      memoryRoot: directory, extensionsRoot: '/synthetic-extensions',
      environmentContext: 'Synthetic isolated PostgreSQL acceptance', authorizationContext: 'No external actions',
      now: () => new Date('2026-10-08T09:00:00Z'),
      loadMemory: async () => { loads++; return readFile(file, 'utf8'); },
    };
    const writer = await db.acquire('auto-memory-restart');
    await runtime(writer, () => streamOf(assistant('Earlier answer '.repeat(4000))), { model: largeModel, autoCompaction: disabled, miraPrompt }).run(input('Older question '.repeat(4000)));
    await runtime(writer, () => streamOf(assistant('Recent answer')), { model: largeModel, autoCompaction: disabled, miraPrompt }).run(input('Recent question'));
    assert.equal(loads, 1);
    const prefix = await rawHistory(db, writer.miraId);
    await writeFile(file, 'FRESH_MEMORY_FROM_FILE');
    const compacted = await runtime(writer, (_model, context) => {
      if (isSummary(context)) { summaries++; return streamOf(assistant('Synthetic durable automatic checkpoint')); }
      requests++; assert.match(systemText(context), /FRESH_MEMORY_FROM_FILE/);
      return streamOf(assistant('Natural reply after automatic compaction'));
    }, { model: largeModel, autoCompaction: automatic, miraPrompt }).run(input('New natural question'));
    assert.ok(summaries >= 1); assert.equal(requests, 1); assert.equal(loads, 2);
    assert.equal(compacted.entries.filter(entry => entry.type === 'compaction').length, 1);
    assert.deepEqual((await rawHistory(db, writer.miraId)).slice(0, prefix.length), prefix);
    const saved = await writer.load();
    await writer.close(); await writeFile(file, 'DISK_CHANGED_AFTER_COMPACTION');
    const restarted = await db.acquire('auto-memory-restart');
    const recovered = await runtime(restarted, () => { throw Error('Recovery may not call a model'); }, { model: largeModel, autoCompaction: disabled, miraPrompt }).recover();
    assert.deepEqual(recovered.snapshot, saved); assert.equal(loads, 2);
    await runtime(restarted, (_model, context) => {
      assert.match(systemText(context), /FRESH_MEMORY_FROM_FILE/);
      assert.doesNotMatch(systemText(context), /DISK_CHANGED_AFTER_COMPACTION/);
      return streamOf(assistant('Continued from durable Memory'));
    }, { model: largeModel, autoCompaction: disabled, miraPrompt }).run(input('Ordinary restart continuation'));
    assert.equal(loads, 2);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real PostgreSQL: continueTurn compacts automatically and final Wake remains linked and non-replayed after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('auto-wake');
    await seed(writer, [input('Older question '.repeat(4000)), assistant('Earlier answer '.repeat(4000)), input('Recent question'), assistant('Recent answer')]);
    const prefix = await rawHistory(db, writer.miraId);
    await writer.receive({ id: 'auto-event', type: 'user.message', source: 'user', occurredAt: '2026-10-08T09:00:00Z', payload: { text: 'Continue the durable automatic compaction test' } }, { id: 'auto-wake-event', reason: 'Synthetic request' });
    const run = await writer.claimWakeBatch(); assert.ok(run);
    const turn = { id: run.id, input: renderWakeBatch(run), occurredAt: run.claimedAt, inputRecordId: null, finalRecordId: null };
    let summaries = 0, requests = 0;
    await runtime(writer, (_model, context) => {
      if (isSummary(context)) { summaries++; return streamOf(assistant('Durable Wake checkpoint')); }
      requests++; assert.match(JSON.stringify(context.messages), /Durable Wake checkpoint/);
      assert.match(JSON.stringify(context.messages), /Continue the durable automatic compaction test/);
      return streamOf(assistant('Wake terminal reply'));
    }, { model: largeModel, autoCompaction: automatic }).continueTurn(turn);
    assert.ok(summaries >= 1); assert.equal(requests, 1);
    const savedRun = await writer.loadWakeRun(run.id); assert.ok(savedRun.inputRecordId); assert.ok(savedRun.finalRecordId);
    const saved = await writer.load();
    assert.equal(saved.records.at(-1)?.id, savedRun.finalRecordId);
    assert.deepEqual((await rawHistory(db, writer.miraId)).slice(0, prefix.length), prefix);
    await writer.close();
    const restarted = await db.acquire('auto-wake');
    await runtime(restarted, () => { throw Error('A terminal Wake cannot call the summarizer or provider again'); }, { model: largeModel, autoCompaction: automatic }).continueTurn(turn);
    assert.deepEqual(await restarted.load(), saved);
    await restarted.completeWakeRun(run.id); assert.equal(await restarted.claimWakeBatch(), null);
  } finally { await db.close(); }
});

async function settled(service: LocalWebService, providerFailure: () => unknown = () => undefined): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > deadline) throw Error('Synthetic Web service failed to settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Surface the fixture's original callback assertion instead of the service's
  // intentionally redacted public failure, so CI reports the actionable cause.
  if (providerFailure() !== undefined) throw providerFailure();
  assert.equal((await service.status()).error, null);
  assert.equal((await service.status()).state, 'idle');
}

test('real PostgreSQL: default CLI home compacts HTTP inputs, restores its reply index and Memory, and reads sources after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  const isolatedHome = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-web-auto-home-')));
  const previousEnvironment = { HOME: process.env['HOME'], MIRA_HOME: process.env['MIRA_HOME'] };
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  try {
    process.env['HOME'] = isolatedHome; delete process.env['MIRA_HOME'];
    assert.equal(os.homedir(), isolatedHome);
    const root = resolveWebMiraHome(process.env['MIRA_HOME']);
    assert.equal(root, path.join(isolatedHome, '.mira'), 'Use the actual CLI default, with no MIRA_HOME or spool override');
    await mkdir(root, { mode: 0o700 });
    let naturalRequests = 0, summaries = 0;
    let providerFailure: unknown;
    let replyIndexPath = '';
    const sourceIds: string[] = [];
    const memoryRoot = path.join(root, 'memory');
    const options = {
      connectionString: db.connectionString, schema: db.schema, miraId: 'web-auto-compaction',
      sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'wake-input'), settingsFile: path.join(root, 'models.json'),
      miraHome: root, memoryRoot, synthetic: true,
      autoCompaction: { threshold: 0.008, reserveTokens: 512, keepRecentTokens: 1 },
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        try {
          if (isSummary(context)) { summaries++; return streamOf(assistant('Synthetic Web checkpoint')); }
          naturalRequests++;
          if (naturalRequests >= 2) {
            assert.match(systemText(context), /WEB_MEMORY_REFRESHED/);
            assert.doesNotMatch(systemText(context), /WEB_DISK_CHANGED_LATER/);
          }
          if (naturalRequests === 3) {
            assert.ok(replyIndexPath); assert.ok(JSON.stringify(context.messages).includes(replyIndexPath), 'Restart request retains the durable reply index pointer');
            return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-default-home-reply-index', name: 'read', arguments: { path: replyIndexPath } }] });
          }
          if (naturalRequests === 4) {
            const result = context.messages.findLast(message => message.role === 'toolResult' && message.toolCallId === 'read-default-home-reply-index');
            assert.ok(result?.role === 'toolResult'); assert.equal(result.isError, false);
            const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            assert.match(text, /reply-source-index/);
            for (const id of sourceIds) assert.ok(text.includes(id), 'The actual ordinary read delivers canonical source IDs to the model');
          }
          return streamOf(assistant(naturalRequests === 1 ? 'Earlier Web answer '.repeat(2000) : `Natural Web answer ${naturalRequests}`));
        } catch (error) { providerFailure = error; throw error; }
      },
    };
    service = await LocalWebService.open(options); await settled(service, () => providerFailure);
    const headers = { host: '127.0.0.1:4781', origin: 'http://127.0.0.1:4781', 'x-mira-client': 'web' };
    const submit = async (id: string, text: string, occurredAt: string) => {
      assert.ok(app);
      const response = await app.inject({ method: 'POST', url: '/api/messages', headers, payload: { id, text, occurredAt } });
      assert.equal(response.statusCode, 201, response.body); assert.equal(response.json().receipt, 'inserted');
    };
    app = createLocalHttp({ backend: service, port: 4781 });
    assert.equal(naturalRequests, 0); assert.equal(summaries, 0);
    await submit('web-auto-first', 'First Web question', '2026-10-08T09:00:00Z');
    await settled(service, () => providerFailure); assert.equal(naturalRequests, 1); assert.equal(summaries, 0);
    const prefix = await rawHistory(db, options.miraId);
    await writeFile(path.join(memoryRoot, 'MEMORY.md'), 'WEB_MEMORY_REFRESHED');
    await submit('web-auto-second', 'Second Web question triggers compaction', '2026-10-08T09:01:00Z');
    await settled(service, () => providerFailure); assert.equal(naturalRequests, 2); assert.ok(summaries >= 1);
    assert.deepEqual((await rawHistory(db, options.miraId)).slice(0, prefix.length), prefix);
    const checkpoints = (await db.admin.query<{ pointer: { path: string; bytes: number } }>(
      "SELECT envelope->'payload'->'miraReplyIndex' AS pointer FROM context_records WHERE envelope->'payload'->>'type' = 'compaction'")).rows;
    assert.equal(checkpoints.length, 1);
    const pointer = checkpoints[0]!.pointer; assert.ok(pointer?.path, 'Actual compaction must publish its ordinary-file reply index');
    replyIndexPath = pointer.path;
    assert.equal(path.dirname(path.dirname(pointer.path)), options.spoolDirectory, 'The index is stored in the default ~/.mira/wake-input spool');
    const indexText = await readFile(pointer.path, 'utf8'); assert.equal(Buffer.byteLength(indexText), pointer.bytes);
    assert.equal((await stat(pointer.path)).mode & 0o777, 0o400);
    const index = JSON.parse(indexText) as { type: string; sources: Array<{ messages: Array<{ messageId: string }> }> };
    assert.equal(index.type, 'reply-source-index');
    const response = await app.inject({ url: '/api/timeline', headers }); assert.equal(response.statusCode, 200, response.body);
    const timeline = response.json<Awaited<ReturnType<LocalWebService['timeline']>>>();
    assert.equal(timeline.items.filter(item => item.role === 'user').length, 2);
    assert.equal(timeline.items.filter(item => item.role === 'assistant').length, 2);
    const indexedIds = new Set(index.sources.flatMap(source => source.messages.map(message => message.messageId)));
    for (const item of timeline.items.filter(item => item.role === 'user')) {
      assert.ok(indexedIds.has(item.id), 'Reply index preserves canonical user History IDs');
      assert.notEqual(item.id, item.externalEventId); sourceIds.push(item.id);
    }
    assert.doesNotMatch(JSON.stringify(timeline), /Synthetic Web checkpoint|WEB_MEMORY_REFRESHED/);
    await app.close(); app = undefined; await service.close(); service = undefined;
    // Derived files may disappear; the persisted checkpoint and original records
    // must reconstruct the same file in the same default managed data root.
    await rm(path.dirname(pointer.path), { recursive: true });
    await assert.rejects(stat(pointer.path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await writeFile(path.join(memoryRoot, 'MEMORY.md'), 'WEB_DISK_CHANGED_LATER');
    const callsBeforeRestart = naturalRequests + summaries;
    service = await LocalWebService.open({ ...options, autoCompaction: disabled }); await settled(service, () => providerFailure);
    app = createLocalHttp({ backend: service, port: 4781 });
    assert.equal(naturalRequests + summaries, callsBeforeRestart, 'startup does not rerun a finalized Wake or summary');
    assert.deepEqual((await service.timeline()).items, timeline.items);
    await submit('web-auto-third', 'Read the retained sources after restarting', '2026-10-08T09:02:00Z');
    await settled(service, () => providerFailure); assert.equal(naturalRequests, 4);
    assert.equal(await readFile(pointer.path, 'utf8'), indexText, 'Restart recreates the byte-identical reply index from persisted records');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE completed')).rows[0].n, 3);
  } finally {
    try { await app?.close(); await service?.close(); await db.close(); }
    finally {
      for (const key of ['HOME', 'MIRA_HOME'] as const) {
        if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
      }
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
});
