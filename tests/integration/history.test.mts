import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeRecord } from '@mira/context';
import { HistoryError } from '@mira/life';
import type { LifeEvent, ToolIntent } from '@mira/life';
import { createTestDatabase, testDatabaseUrl } from './database.mts';

const now = '2026-10-05T00:00:00.000Z';
const event = (id: string, text: string): LifeEvent => ({ id, type: 'synthetic.observed', source: 'external', occurredAt: now, payload: { text, untouched: [null, 42, true] } });
const record = (id: string, parentId: string | null, text: string): RuntimeRecord => ({ formatVersion: 1, runtime: 'opaque-test-runtime', runtimeVersion: 'not-Pi', id, parentId, kind: 'message', occurredAt: now, payload: { text, providerData: { unchanged: true } } });
testDatabaseUrl();

test('history search/read is Mira scoped across original events, context, tools, and wake links without taking ownership', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('mira-a'); const other = await db.acquire('mira-b');
    const original = event('same-id', 'historicalneedle exact event'); const wake = { id: 'wake-id', reason: 'historicalneedle wake reason' };
    await writer.receive(original, wake); await other.receive(event('same-id', 'hiddenotherneedle'));
    const context = record('same-id', null, 'historicalneedle exact original message');
    await writer.append(0, context);
    const intent: ToolIntent = { callId: 'same-id', assistantRecordId: 'same-id', toolName: 'history-example', requestedArguments: { raw: 'historicalneedle' }, arguments: { normalized: 'historicalneedle' }, occurredAt: now };
    await writer.beginTool(1, intent); const outcome = { callId: 'same-id', occurredAt: now, payload: { text: 'historicalneedle exact outcome' } };
    await writer.finishTool(outcome);
    const run = await writer.claimWakeBatch(); assert(run);
    await writer.appendWakeInput(run.id, 1, record('input', 'same-id', 'wake input'));
    await writer.appendWakeFinal(run.id, 2, record('final', 'input', 'wake final')); await writer.completeWakeRun(run.id);
    const before = await writer.load(); const epoch = writer.epoch;
    const reader = db.store.history('mira-a'); const found = await reader.search({ query: 'historicalneedle' });
    assert.deepEqual(found.hits.map(hit => [hit.kind, hit.id]).sort(), [['context', 'same-id'], ['event', 'same-id'], ['tool', 'same-id']]);
    assert.equal(found.mode, 'full_text'); assert.equal(found.fullTextPrefixChars, 65_536); assert.equal(found.hasMore, false);
    assert(found.hits.every(hit => hit.miraId === 'mira-a' && hit.snippet.length <= 512 && hit.rank !== null));
    assert.equal((await reader.search({ query: 'hiddenotherneedle' })).hits.length, 0);
    assert.deepEqual(await reader.read({ kind: 'event', id: 'same-id' }), { kind: 'event', id: 'same-id', miraId: 'mira-a', occurredAt: now, event: original, requestedWake: wake });
    assert.deepEqual(await reader.read({ kind: 'context', id: 'same-id' }), { kind: 'context', id: 'same-id', miraId: 'mira-a', occurredAt: now, version: 1, record: context });
    assert.deepEqual(await reader.read({ kind: 'tool', id: 'same-id' }), { kind: 'tool', id: 'same-id', miraId: 'mira-a', occurredAt: now, contextVersion: 1, intent, outcome });
    const savedRun = await reader.read({ kind: 'wake', id: run.id }); assert(savedRun?.kind === 'wake');
    assert.equal(savedRun.claimedVersion, 1); assert.equal(savedRun.inputRecordId, 'input'); assert.equal(savedRun.finalRecordId, 'final'); assert.equal(savedRun.status, 'completed');
    assert.deepEqual(savedRun.requests.map(({ wakeId, eventId }) => ({ wakeId, eventId })), [{ wakeId: 'wake-id', eventId: 'same-id' }]);
    assert.equal((await reader.search({ query: run.id, mode: 'substring', kinds: ['wake'] })).hits[0]!.id, run.id);
    assert.equal(await db.store.history('mira-b').read({ kind: 'context', id: 'same-id' }), null);
    assert.equal(await reader.read({ kind: 'event', id: 'missing' }), null);
    assert.deepEqual(await writer.load(), before); assert.equal(writer.epoch, epoch); await writer.verifyActive();
  } finally { await db.close(); }
});

test('simple full text has no Chinese word segmentation; literal substring recovers it without wildcard behavior', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await writer.receive(event('chinese', '用户喜欢顺德菜和粤菜'));
    await writer.receive(event('literal', 'a%_b'));
    const reader = db.store.history(writer.miraId);
    assert.equal((await reader.search({ query: '顺德菜' })).hits.length, 0, 'simple dictionary does not split a contiguous Chinese phrase');
    assert.deepEqual((await reader.search({ query: '顺德菜', mode: 'substring' })).hits.map(hit => hit.id), ['chinese']);
    assert.deepEqual((await reader.search({ query: '%_', mode: 'substring' })).hits.map(hit => hit.id), ['literal']);
    assert.equal((await reader.search({ query: "' OR true --", mode: 'substring' })).hits.length, 0);
  } finally { await db.close(); }
});

test('search counts and excerpts are bounded and deterministic, and large reads never silently truncate', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const reader = db.store.history(writer.miraId);
    for (const id of ['a', 'b', 'c']) await writer.receive(event(id, 'matchword '.repeat(1000)));
    const first = await reader.search({ query: 'matchword', limit: 2 });
    assert.equal(first.hits.length, 2); assert.equal(first.hasMore, true); assert(first.hits.every(hit => hit.snippet.length <= 512));
    assert.deepEqual(await reader.search({ query: 'matchword', limit: 2 }), first);
    assert.equal((await reader.search({ query: 'matchword', limit: 3 })).hasMore, false);
    const original = event('large', `${'padding '.repeat(12_000)} uniquetailneedle`); await writer.receive(original);
    assert.equal((await reader.search({ query: 'uniquetailneedle' })).hits.length, 0, 'full-text prefix boundary is explicit');
    const fallback = await reader.search({ query: 'uniquetailneedle', mode: 'substring' });
    assert.equal(fallback.fullTextPrefixChars, null); assert.deepEqual(fallback.hits.map(hit => hit.id), ['large']);
    await assert.rejects(reader.read({ kind: 'event', id: 'large' }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large' && error.requiredBytes! > 65_536);
    const complete = await reader.read({ kind: 'event', id: 'large', maxBytes: 200_000 }); assert(complete?.kind === 'event'); assert.deepEqual(complete.event, original);
  } finally { await db.close(); }
});

test('history works for an unregistered Mira without creating an owner or a wake', async () => {
  const db = await createTestDatabase();
  try {
    const reader = db.store.history('nonexistent');
    assert.equal((await reader.search({ query: 'nothing' })).hits.length, 0);
    assert.equal(await reader.read({ kind: 'wake', id: 'nothing' }), null);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM mira_owners')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('bounded full-text indexes preserve large originals and history readers do not interpret runtime payloads', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const text = Array.from({ length: 100_000 }, (_, i) => `uniqueword${i}`).join(' ');
    const original = record('large-runtime', null, text); await writer.append(0, original);
    assert((await writer.load()).records[0]!.payload);
    const reader = db.store.history(writer.miraId);
    assert.deepEqual((await reader.search({ query: 'uniqueword99999', mode: 'substring' })).hits.map(hit => hit.id), ['large-runtime']);
    await assert.rejects(reader.read({ kind: 'context', id: 'large-runtime', maxBytes: 1_048_576 }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large');
  } finally { await db.close(); }
});
