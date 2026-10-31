import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import type { RuntimeRecord } from '@mira/context';
import type { HistoryEntry, HistorySearchResult, LifeEvent, ToolIntent, ToolOutcome } from '@mira/life';
import { decodeRecords, MIRA_SYSTEM_TEMPLATE } from '@mira/runtime-pi';
import { runDemo } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, toolCalls } from './fixtures.mts';
import { fullOutput } from './tool-output-fixtures.mts';
import { TOOL_OUTPUT_TEXT_BYTES } from '../../packages/runtime-pi/src/tool-output.ts';

const occurredAt = '2026-10-05T08:00:00.000Z';
const event = (id: string, text: string): LifeEvent => ({ id, type: 'synthetic.history', source: 'user', occurredAt, payload: { text, untouched: [null, 42, true] } });
const call = (id: string, name: string, args: ToolCall['arguments']): ToolCall => ({ type: 'toolCall', id, name, arguments: args });
const calls = (...content: ToolCall[]) => ({ ...toolCalls(...content.map(item => item.id)), content });
type Database = Awaited<ReturnType<typeof createTestDatabase>>;
async function eventHistoryId(db: Database, miraId: string, externalId: string): Promise<string> {
  return (await db.admin.query<{ history_id: string }>('SELECT history_id FROM life_events WHERE mira_id = $1 AND event_id = $2', [miraId, externalId])).rows[0]!.history_id;
}
const missingId = '11111111-1111-4111-8111-111111111111';
const anotherMissingId = '22222222-2222-4222-8222-222222222222';

function value<T>(context: TranscriptContext, callId: string): T {
  const results = context.messages.filter(message => message.role === 'toolResult' && message.toolCallId === callId);
  assert.equal(results.length, 1, `${callId} reaches the provider exactly once`);
  const message = results[0]; assert.ok(message?.role === 'toolResult');
  assert.equal(message.isError, false, 'history returns structured errors as data, never an unknown external effect');
  assert.equal(message.content.length, 1);
  const content = message.content[0]; assert.ok(content?.type === 'text');
  return JSON.parse(content.text) as T;
}

async function assertProviderEvidence(db: Database, miraId: string, context: TranscriptContext): Promise<void> {
  const system = getCurrentSystemMessage(context.messages); assert.ok(system);
  const text = getSystemMessageText(system);
  assert.equal(JSON.stringify(context.messages).split('# Mira System Prompt v0.4').length - 1, 1);
  let position = 0;
  for (const literal of MIRA_SYSTEM_TEMPLATE.split(/\{\{[A-Z_]+\}\}/)) {
    const next = text.indexOf(literal, position);
    assert.ok(next >= position, 'the actual complete runtime prompt reaches the provider');
    position = next + literal.length;
  }
  const rows = (await db.admin.query<{ version: string; record_id: string; envelope: RuntimeRecord }>(
    'SELECT version, record_id, envelope FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId])).rows;
  const entries = decodeRecords(rows.map(row => row.envelope));
  const messages = entries.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  assert.deepEqual(getCurrentTools(messages), getCurrentTools(context.messages), 'tool declarations are durable before every model request');
  assert.deepEqual(getCurrentTools(context.messages).filter(tool => tool.name.startsWith('history_')).map(tool => tool.name), ['history_search', 'history_read']);
  const executions = (await db.admin.query<{ context_version: string; intent: ToolIntent; outcome: ToolOutcome | null }>(
    'SELECT context_version, intent, outcome FROM tool_executions WHERE mira_id = $1 ORDER BY context_version', [miraId])).rows;
  for (const execution of executions) {
    const intent = execution.intent;
    const source = entries.find(entry => entry.id === intent.assistantRecordId);
    assert.ok(source?.type === 'message' && source.message.role === 'assistant');
    const request = source.message.content.find(block => block.type === 'toolCall' && block.id === intent.callId);
    assert.ok(request?.type === 'toolCall');
    assert.equal(intent.toolName, request.name);
    assert.deepEqual(intent.requestedArguments, request.arguments);
    assert.deepEqual(intent.arguments, request.arguments, 'these canonical history arguments must be executed unchanged');
    assert.ok(execution.outcome, 'the next request sees a committed outcome for every completed history call');
    const resultIndex = entries.findIndex(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === intent.callId);
    const result = entries[resultIndex]; assert.ok(result?.type === 'message');
    assert.deepEqual(result.message, execution.outcome.payload, 'transcript contains the exact durable outcome');
    assert.equal(Number(rows[resultIndex]!.version), Number(execution.context_version) + 1, 'the result immediately follows its intent context version');
    assert.ok(Number(rows[entries.indexOf(source)]!.version) <= Number(execution.context_version), 'assistant request precedes intent');
    const delivered = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === intent.callId);
    assert.ok(delivered?.role === 'toolResult');
    const full = execution.outcome.payload as unknown as typeof delivered;
    const large = full.content.reduce((bytes, block) => bytes + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0) > TOOL_OUTPUT_TEXT_BYTES;
    assert.deepEqual(large ? await fullOutput(delivered) : delivered, execution.outcome.payload, 'the next request gets exact evidence or a readable complete original');
  }
}

async function originals(db: Database, miraId: string) {
  const sources: Record<string, string[]> = {};
  for (const table of ['history_records', 'life_events', 'context_records', 'tool_executions', 'wake_requests', 'wake_runs', 'wake_run_requests']) {
    sources[table] = (await db.admin.query<{ raw: string }>(`SELECT row_to_json(source)::text AS raw FROM ${table} AS source WHERE mira_id = $1 ORDER BY row_to_json(source)::text`, [miraId])).rows.map(row => row.raw);
  }
  return sources;
}

function assertPreserved(before: Record<string, string[]>, after: Record<string, string[]>): void {
  for (const [table, rows] of Object.entries(before)) {
    for (const raw of rows) assert.ok(after[table]!.includes(raw), `${table} original PostgreSQL row remains byte-for-byte unchanged`);
  }
}

test('real PostgreSQL server: model searches then reads exact event, context, tool and completed Wake originals across restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp(path.join(tmpdir(), 'mira-history-runtime-'));
  const miraId = 'history-reader';
  const options = { connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), workingDirectory: root };
  const original = event("archive/%_/'原始-record", 'archiveneedle original event content');
  const requestedWake = { id: 'original-wake', reason: 'Read this original history record' };
  try {
    // Both Miras have real, decodable event/context/tool/Wake history, including
    // colliding event and tool-call IDs. Only the trusted assembly fixes scope.
    let foreignRequests = 0;
    await runDemo({ ...options, miraId: 'other-mira',
      events: [{ event: event(original.id, 'archiveneedle foreignneedle must never reach the reader'), wake: requestedWake }],
      streamFn: async (_model, context) => {
        foreignRequests++; await assertProviderEvidence(db, 'other-mira', context);
        if (foreignRequests === 1) return streamOf(calls(call('original-read', 'history_read', { id: await eventHistoryId(db, 'other-mira', original.id) })));
        assert.equal(foreignRequests, 2);
        return streamOf(assistant('archiveneedle foreignneedle original final response'));
      },
    });
    const foreignRun = (await db.admin.query<{ run_id: string; final_record_id: string }>(
      'SELECT run_id, final_record_id FROM wake_runs WHERE mira_id = $1', ['other-mira'])).rows[0]!;
    const other = await db.acquire('other-mira');
    const foreignBefore = await originals(db, other.miraId); const foreignEpoch = other.epoch;
    let seededRequests = 0; let originalHistoryId = '';
    const seeded = await runDemo({ ...options, events: [{ event: original, wake: requestedWake }], streamFn: async (_model, context) => {
      seededRequests++; await assertProviderEvidence(db, miraId, context);
      if (seededRequests === 1) { originalHistoryId = await eventHistoryId(db, miraId, original.id); return streamOf(calls(call('original-read', 'history_read', { id: originalHistoryId }))); }
      assert.equal(seededRequests, 2);
      assert.deepEqual(value(context, 'original-read'), { kind: 'event', id: originalHistoryId, miraId, occurredAt, event: original, requestedWake });
      return streamOf(assistant('archiveneedle original final response'));
    } });
    assert.equal(seeded.completedRuns, 1); assert.equal(seeded.modelCalls, 2);
    const oldRun = (await db.admin.query<{ run_id: string; final_record_id: string; completed: boolean }>(
      'SELECT run_id, final_record_id, completed FROM wake_runs WHERE mira_id = $1', [miraId])).rows[0]!;
    assert.equal(oldRun.completed, true);
    const contextOriginal = (await db.admin.query<{ envelope: RuntimeRecord; version: string }>(
      'SELECT envelope, version FROM context_records WHERE mira_id = $1 AND record_id = $2', [miraId, oldRun.final_record_id])).rows[0]!;
    const toolOriginal = (await db.admin.query<{ history_id: string; intent: ToolIntent; outcome: ToolOutcome; context_version: string }>(
      'SELECT history_id, intent, outcome, context_version FROM tool_executions WHERE mira_id = $1 AND call_id = $2', [miraId, 'original-read'])).rows[0]!;
    const before = await originals(db, miraId);
    let requests = 0;
    const completed = await runDemo({ ...options,
      events: [{ event: event('recall-request', 'Find and quote the earlier original records with their exact provenance'), wake: { id: 'recall-wake', reason: 'User requests original history' } }],
      streamFn: async (_model, context) => {
        requests++; await assertProviderEvidence(db, miraId, context);
        if (requests === 1) return streamOf(calls(
          call('search-originals', 'history_search', { query: 'archiveneedle', kinds: ['event', 'context', 'tool'], limit: 100 }),
          call('search-wake', 'history_search', { query: oldRun.run_id, mode: 'substring', kinds: ['wake'] }),
          call('search-foreign', 'history_search', { query: 'foreignneedle', kinds: ['event'] }),
        ));
        const found = value<HistorySearchResult>(context, 'search-originals');
        assert.equal(found.mode, 'full_text'); assert.equal(found.fullTextPrefixChars, 65_536); assert.equal(found.hasMore, false);
        assert.ok(found.hits.every(hit => hit.miraId === miraId && hit.rank !== null && hit.snippet.length <= 512));
        assert.equal(found.hits.filter(hit => hit.kind === 'event' && hit.id === originalHistoryId).length, 1, 'a colliding foreign event does not add a second hit');
        assert.equal(found.hits.filter(hit => hit.kind === 'tool' && hit.id === toolOriginal.history_id).length, 1, 'a colliding foreign tool execution does not add a second hit');
        assert.ok(found.hits.every(hit => hit.id !== foreignRun.final_record_id), 'search does not leak the other Mira’s original context');
        const references = [
          found.hits.find(hit => hit.kind === 'event' && hit.id === originalHistoryId),
          found.hits.find(hit => hit.kind === 'context' && hit.id === oldRun.final_record_id),
          found.hits.find(hit => hit.kind === 'tool' && hit.id === toolOriginal.history_id),
          value<HistorySearchResult>(context, 'search-wake').hits.find(hit => hit.kind === 'wake' && hit.id === oldRun.run_id),
        ];
        assert.deepEqual(value<HistorySearchResult>(context, 'search-foreign').hits, []);
        if (requests === 2) return streamOf(calls(
          ...references.map((reference, index) => {
            assert.ok(reference, 'the actual search result supplies the exact next read reference');
            return call(`read-original-${index}`, 'history_read', { id: reference.id });
          }),
          call('read-foreign-context', 'history_read', { id: foreignRun.final_record_id }),
          call('read-foreign-wake', 'history_read', { id: foreignRun.run_id }),
        ));
        assert.equal(requests, 3);
        assert.deepEqual(value(context, 'read-original-0'), { kind: 'event', id: originalHistoryId, miraId, occurredAt, event: original, requestedWake });
        assert.deepEqual(value(context, 'read-original-1'), { kind: 'context', id: oldRun.final_record_id, miraId, occurredAt: contextOriginal.envelope.occurredAt, version: Number(contextOriginal.version), record: contextOriginal.envelope });
        assert.deepEqual(value(context, 'read-original-2'), { kind: 'tool', id: toolOriginal.history_id, miraId, occurredAt: toolOriginal.intent.occurredAt, contextVersion: Number(toolOriginal.context_version), intent: toolOriginal.intent, outcome: toolOriginal.outcome });
        const wake = value<HistoryEntry>(context, 'read-original-3'); assert.ok(wake.kind === 'wake');
        assert.equal(wake.status, 'completed'); assert.equal(wake.id, oldRun.run_id); assert.equal(wake.finalRecordId, oldRun.final_record_id);
        assert.deepEqual(wake.requests.map(({ wakeReceiptId, eventId, externalEventId }) => ({ wakeReceiptId, eventId, externalEventId })), [{ wakeReceiptId: requestedWake.id, eventId: originalHistoryId, externalEventId: original.id }]);
        assert.equal(value(context, 'read-foreign-context'), null); assert.equal(value(context, 'read-foreign-wake'), null);
        return streamOf(assistant('Original event, runtime response, tool outcome and completed Wake were read with exact provenance'));
      },
    });
    assert.equal(completed.completedRuns, 1); assert.equal(completed.modelCalls, 3); assert.equal(requests, 3);
    assertPreserved(before, await originals(db, miraId));
    assert.deepEqual(await originals(db, other.miraId), foreignBefore); assert.equal(other.epoch, foreignEpoch); await other.verifyActive();
    const runs = (await db.admin.query('SELECT completed, input_record_id, final_record_id FROM wake_runs WHERE mira_id = $1', [miraId])).rows;
    assert.equal(runs.length, 2); assert.ok(runs.every(run => run.completed && run.input_record_id && run.final_record_id));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions WHERE mira_id = $1', [miraId])).rows[0].n, 10);
    const quiet = await runDemo({ ...options, events: [], streamFn: () => { throw Error('completed history calls must not cause another Wake or replay'); } });
    assert.equal(quiet.modelCalls, 0); assert.equal(quiet.completedRuns, 0); assert.equal(quiet.version, completed.version);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL server: model explicitly selects Chinese/literal substring search and receives null for missing or foreign IDs', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp(path.join(tmpdir(), 'mira-history-literal-'));
  const miraId = 'literal-reader';
  const chinese = event('中文/%_record', '用户喜欢顺德菜和粤菜'); const literal = event('literal-id', 'literal a%_b');
  try {
    const other = await db.acquire('other-mira'); await other.receive(event(chinese.id, 'foreign same-ID original'));
    await other.receive(event('foreign-only-id', '顺德菜 foreign-only evidence'));
    const foreignBefore = await originals(db, other.miraId);
    const foreignHistoryId = await eventHistoryId(db, other.miraId, 'foreign-only-id');
    let chineseHistoryId = '', literalHistoryId = '';
    let requests = 0;
    const completed = await runDemo({ connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), workingDirectory: root,
      events: [{ event: chinese }, { event: literal }, { event: event('request', 'Find the exact food preference and literal punctuation; tell me when a record is absent'), wake: { id: 'wake', reason: 'Read exact historical evidence' } }],
      streamFn: async (_model, context) => {
        requests++; await assertProviderEvidence(db, miraId, context);
        if (requests === 1) {
          chineseHistoryId = await eventHistoryId(db, miraId, chinese.id); literalHistoryId = await eventHistoryId(db, miraId, literal.id);
          return streamOf(calls(call('chinese-full-text', 'history_search', { query: '顺德菜', kinds: ['event'] })));
        }
        assert.deepEqual(value<HistorySearchResult>(context, 'chinese-full-text').hits, [], 'simple full text does not segment the contiguous Chinese phrase');
        if (requests === 2) return streamOf(calls(
          call('chinese-substring', 'history_search', { query: '顺德菜', mode: 'substring', kinds: ['event'] }),
          call('literal-substring', 'history_search', { query: '%_', mode: 'substring', kinds: ['event'] }),
        ));
        const found = value<HistorySearchResult>(context, 'chinese-substring');
        assert.equal(found.mode, 'substring'); assert.equal(found.fullTextPrefixChars, null); assert.equal(found.hasMore, false);
        assert.deepEqual(found.hits.map(hit => [hit.kind, hit.id, hit.miraId, hit.rank]), [['event', chineseHistoryId, miraId, null]]);
        assert.deepEqual(value<HistorySearchResult>(context, 'literal-substring').hits.map(hit => hit.id).sort(), [chineseHistoryId, literalHistoryId].sort(), 'percent and underscore remain literal characters, including those in an exact ID');
        if (requests === 3) return streamOf(calls(
          call('read-chinese', 'history_read', { id: found.hits[0]!.id }),
          call('read-missing', 'history_read', { id: missingId }),
          call('read-foreign', 'history_read', { id: foreignHistoryId }),
          call('read-another-missing', 'history_read', { id: anotherMissingId }),
        ));
        assert.equal(requests, 4);
        assert.deepEqual(value(context, 'read-chinese'), { kind: 'event', id: chineseHistoryId, miraId, occurredAt, event: chinese, requestedWake: null });
        for (const id of ['read-missing', 'read-foreign', 'read-another-missing']) assert.equal(value(context, id), null);
        return streamOf(assistant('The exact preference is 用户喜欢顺德菜和粤菜. The other requested records were not found in this Mira'));
      },
    });
    assert.equal(completed.modelCalls, 4); assert.equal(completed.completedRuns, 1);
    assert.deepEqual(await originals(db, other.miraId), foreignBefore); await other.verifyActive();
    const stored = (await db.admin.query<{ event: LifeEvent }>('SELECT event FROM life_events WHERE mira_id = $1 AND event_id = ANY($2)', [miraId, [chinese.id, literal.id]])).rows;
    assert.deepEqual(stored.map(row => row.event).sort((a, b) => a.id.localeCompare(b.id)), [chinese, literal].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE mira_id = $1', [miraId])).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions WHERE mira_id = $1', [miraId])).rows[0].n, 7);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL server: oversized history read reaches the model truthfully and a larger-budget new call preserves the complete original behind a bounded reference', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-history-large-'));
  const miraId = 'large-reader';
  const original = event('large-original', `${'完整原文 '.repeat(7000)}untruncated-tail-marker`);
  try {
    let requests = 0; let requiredBytes = 0; let rawBefore = ''; let originalHistoryId = '';
    const completed = await runDemo({ connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), workingDirectory: root,
      events: [{ event: original }, { event: event('request', 'Read the complete large original; increase the read budget if needed'), wake: { id: 'wake', reason: 'Read complete original' } }],
      streamFn: async (_model, context) => {
        requests++; await assertProviderEvidence(db, miraId, context);
        if (requests === 1) {
          originalHistoryId = await eventHistoryId(db, miraId, original.id);
          rawBefore = (await db.admin.query('SELECT event::text AS raw FROM life_events WHERE mira_id = $1 AND event_id = $2', [miraId, original.id])).rows[0].raw;
          return streamOf(calls(call('read-default-budget', 'history_read', { id: originalHistoryId })));
        }
        const error = value<{ error: string; message: string; requiredBytes: number }>(context, 'read-default-budget');
        assert.equal(error.error, 'too_large'); assert.ok(error.requiredBytes > 65_536 && error.requiredBytes <= 1_048_576);
        assert.match(error.message, /increase the read budget/); assert.ok(error.message.includes(String(error.requiredBytes)));
        assert.deepEqual(Object.keys(error).sort(), ['error', 'message', 'requiredBytes']);
        assert.equal(JSON.stringify(error).includes('untruncated-tail-marker'), false, 'the failure contains no misleading partial original');
        if (requests === 2) {
          requiredBytes = error.requiredBytes;
          return streamOf(calls(call('read-larger-budget', 'history_read', { id: originalHistoryId, maxBytes: requiredBytes })));
        }
        assert.equal(requests, 3);
        const delivered = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'read-larger-budget'); assert.ok(delivered?.role === 'toolResult');
        // Head+tail preview (ADR 0028 amendment): explicitly partial, complete original behind the reference.
        assert.match(JSON.stringify(delivered.content), /omitted from the middle of this preview/);
        const full = await fullOutput(delivered), text = full.content[0]; assert.ok(text?.type === 'text');
        assert.deepEqual(JSON.parse(text.text), { kind: 'event', id: originalHistoryId, miraId, occurredAt, event: original, requestedWake: null });
        return streamOf(assistant('The first read exceeded its budget; the second supplied a preview and a readable complete original.'));
      },
    });
    assert.equal(completed.modelCalls, 3); assert.equal(completed.completedRuns, 1);
    assert.equal((await db.admin.query('SELECT event::text AS raw FROM life_events WHERE mira_id = $1 AND event_id = $2', [miraId, original.id])).rows[0].raw, rawBefore);
    const executions = (await db.admin.query<{ intent: ToolIntent; outcome: ToolOutcome }>('SELECT intent, outcome FROM tool_executions WHERE mira_id = $1 ORDER BY context_version', [miraId])).rows;
    assert.deepEqual(executions.map(execution => execution.intent.callId), ['read-default-budget', 'read-larger-budget']);
    assert.deepEqual(executions.map(execution => execution.intent.arguments), [{ id: originalHistoryId }, { id: originalHistoryId, maxBytes: requiredBytes }]);
    assert.ok(executions.every(execution => execution.outcome));
    const restored = await db.acquire(miraId); const snapshot = await restored.load();
    const results = decodeRecords(snapshot.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []);
    assert.deepEqual(results, executions.map(execution => execution.outcome.payload), 'both the truthful error and the full retry survive the PostgreSQL round trip');
    assert.equal(await restored.claimWakeBatch(), null);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
