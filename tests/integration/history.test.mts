import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeRecord } from '@mira/context';
import { PersistenceError } from '@mira/persistence';
import { HistoryError } from '@mira/life';
import type { HistoryPageHit, LifeEvent, ToolIntent } from '@mira/life';
import { createTestDatabase, testDatabaseUrl, testHistoryId as uuid } from './database.mts';

const now = '2026-10-05T00:00:00.000Z';
const event = (id: string, text: string): LifeEvent => ({ id, type: 'synthetic.observed', source: 'external', occurredAt: now, payload: { text, untouched: [null, 42, true] } });
const record = (label: string, parentLabel: string | null, text: string): RuntimeRecord => ({ formatVersion: 1, runtime: 'opaque-test-runtime', runtimeVersion: 'not-Pi', id: uuid(label), parentId: parentLabel === null ? null : uuid(parentLabel), kind: 'message', occurredAt: now, payload: { text, providerData: { unchanged: true } } });
async function eventId(db: Awaited<ReturnType<typeof createTestDatabase>>, externalId: string, miraId = 'synthetic-mira'): Promise<string> {
  const row = (await db.admin.query<{ history_id: string }>('SELECT history_id FROM life_events WHERE mira_id = $1 AND event_id = $2', [miraId, externalId])).rows[0];
  assert(row); return row.history_id;
}
testDatabaseUrl();

test('history search/read is Mira scoped across original events, context, tools, and wake links without taking ownership', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('mira-a'); const other = await db.acquire('mira-b');
    const original = event('same-id', 'historicalneedle exact event'); const wake = { id: 'wake-id', reason: 'historicalneedle wake reason' };
    await writer.receive(original, wake); await other.receive(event('same-id', 'hiddenotherneedle'));
    const context = record('same-id', null, 'historicalneedle exact original message');
    await writer.append(0, context);
    const intent: ToolIntent = { callId: 'same-id', assistantRecordId: uuid('same-id'), toolName: 'history-example', requestedArguments: { raw: 'historicalneedle' }, arguments: { normalized: 'historicalneedle' }, occurredAt: now };
    await writer.beginTool(1, intent); const outcome = { callId: 'same-id', occurredAt: now, payload: { text: 'historicalneedle exact outcome' } };
    await writer.finishTool(outcome);
    const run = await writer.claimWakeBatch(); assert(run);
    await writer.appendWakeInput(run.id, 1, record('input', 'same-id', 'wake input'));
    await writer.appendWakeFinal(run.id, 2, record('final', 'input', 'wake final')); await writer.completeWakeRun(run.id);
    const before = await writer.load(); const epoch = writer.epoch;
    const reader = db.store.history('mira-a'); const found = await reader.search({ query: 'historicalneedle' });
    const externalHistoryId = await eventId(db, 'same-id', 'mira-a');
    const toolHistoryId = found.hits.find(hit => hit.kind === 'tool')!.id;
    assert.equal(new Set(found.hits.map(hit => hit.id)).size, 3);
    assert.deepEqual(found.hits.map(hit => [hit.kind, hit.id]).sort(), [['context', uuid('same-id')], ['event', externalHistoryId], ['tool', toolHistoryId]]);
    assert.equal(found.mode, 'full_text'); assert.equal(found.fullTextPrefixChars, 65_536); assert.equal(found.hasMore, false);
    assert(found.hits.every(hit => hit.miraId === 'mira-a' && hit.snippet.length <= 512 && hit.rank !== null));
    assert.equal((await reader.search({ query: 'hiddenotherneedle' })).hits.length, 0);
    assert.deepEqual(await reader.read({ id: externalHistoryId }), { kind: 'event', id: externalHistoryId, miraId: 'mira-a', occurredAt: now, event: original, requestedWake: wake });
    assert.deepEqual(await reader.read({ id: uuid('same-id') }), { kind: 'context', id: uuid('same-id'), miraId: 'mira-a', occurredAt: now, version: 1, record: context });
    assert.deepEqual(await reader.read({ id: toolHistoryId }), { kind: 'tool', id: toolHistoryId, miraId: 'mira-a', occurredAt: now, contextVersion: 1, intent, outcome });
    const savedRun = await reader.read({ id: run.id }); assert(savedRun?.kind === 'wake');
    assert.equal(savedRun.claimedVersion, 1); assert.equal(savedRun.inputRecordId, uuid('input')); assert.equal(savedRun.finalRecordId, uuid('final')); assert.equal(savedRun.status, 'completed');
    assert.deepEqual(savedRun.requests.map(({ wakeReceiptId, eventId, externalEventId }) => ({ wakeReceiptId, eventId, externalEventId })), [{ wakeReceiptId: 'wake-id', eventId: externalHistoryId, externalEventId: 'same-id' }]);
    assert.equal((await reader.search({ query: run.id, mode: 'substring', kinds: ['wake'] })).hits[0]!.id, run.id);
    assert.equal(await db.store.history('mira-b').read({ id: uuid('same-id') }), null);
    assert.equal(await reader.read({ id: uuid('missing') }), null);
    const timeline = await reader.page({ limit: 100 });
    assert.deepEqual(timeline.hits.map(hit => [hit.kind, hit.id]).sort(), [['context', uuid('same-id')], ['context', uuid('input')], ['context', uuid('final')], ['event', externalHistoryId], ['tool', toolHistoryId], ['wake', run.id]].sort());
    assert.equal(timeline.nextCursor, null);
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
    assert.deepEqual((await reader.search({ query: '顺德菜', mode: 'substring' })).hits.map(hit => hit.id), [await eventId(db, 'chinese')]);
    assert.deepEqual((await reader.search({ query: '%_', mode: 'substring' })).hits.map(hit => hit.id), [await eventId(db, 'literal')]);
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
    assert.equal(fallback.fullTextPrefixChars, null); assert.deepEqual(fallback.hits.map(hit => hit.id), [await eventId(db, 'large')]);
    await assert.rejects(reader.read({ id: await eventId(db, 'large') }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large' && error.requiredBytes! > 65_536);
    const complete = await reader.read({ id: await eventId(db, 'large'), maxBytes: 200_000 }); assert(complete?.kind === 'event'); assert.deepEqual(complete.event, original);
  } finally { await db.close(); }
});

test('history works for an unregistered Mira without creating an owner or a wake', async () => {
  const db = await createTestDatabase();
  try {
    const reader = db.store.history('nonexistent');
    assert.equal((await reader.search({ query: 'nothing' })).hits.length, 0);
    assert.equal(await reader.read({ id: uuid('nothing') }), null);
    assert.deepEqual(await reader.page(), { hits: [], nextCursor: null });
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
    assert.deepEqual((await reader.search({ query: 'uniqueword99999', mode: 'substring' })).hits.map(hit => hit.id), [uuid('large-runtime')]);
    assert.deepEqual(await reader.page({ kinds: ['context'] }), { hits: [{ kind: 'context', id: uuid('large-runtime'), miraId: writer.miraId, occurredAt: now }], nextCursor: null });
    await assert.rejects(reader.read({ id: uuid('large-runtime'), maxBytes: 1_048_576 }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large');
  } finally { await db.close(); }
});


test('chronological pages traverse timestamp/kind/ID ties without gaps, remain scoped, and survive new records and checkpoints', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('mira-a'); const other = await db.acquire('mira-b');
    await writer.receive({ ...event('old', 'old'), occurredAt: '2026-10-04T00:00:00.000Z' });
    for (const id of ['z', 'same-id', 'a']) await writer.receive(event(id, 'same timestamp'));
    await writer.receive({ ...event('offset-latest', 'offset timestamps sort by instant'), occurredAt: '2026-10-04T23:30:00-02:00' });
    await writer.receive({ ...event('micros-older', 'precision'), occurredAt: '2026-10-05T00:00:00.000001Z' });
    await writer.receive({ ...event('micros-newer', 'precision'), occurredAt: '2026-10-05T00:00:00.000002Z' });
    await writer.append(0, record('same-id', null, 'original before checkpoint'));
    await writer.beginTool(1, { callId: 'same-id', assistantRecordId: uuid('same-id'), toolName: 'synthetic', requestedArguments: {}, arguments: {}, occurredAt: now });
    await writer.finishTool({ callId: 'same-id', occurredAt: now, payload: null });
    await other.receive(event('foreign', 'never in mira-a'));
    const reader = db.store.history('mira-a');
    const kinds = ['event', 'context', 'tool'] as const;
    const originalTimeline = await reader.page({ kinds: [...kinds], limit: 100 });
    const first = await reader.page({ kinds: [...kinds], limit: 2 });
    assert.deepEqual(first.hits.map(hit => hit.id), [await eventId(db, 'micros-newer', 'mira-a'), await eventId(db, 'offset-latest', 'mira-a')]);
    assert(first.nextCursor);
    assert.deepEqual(await reader.page({ kinds: [...kinds], limit: 2 }), first, 'refresh is deterministic');
    await assert.rejects(db.store.history('mira-b').page({ kinds: [...kinds], before: first.nextCursor }), HistoryError);
    await assert.rejects(reader.page({ kinds: ['event'], before: first.nextCursor }), HistoryError);
    // A compaction checkpoint is an appended runtime envelope, not replacement
    // history. Readers do not interpret or expand its runtime-specific payload.
    await writer.append(1, { ...record('checkpoint', 'same-id', 'opaque checkpoint'), kind: 'checkpoint', occurredAt: '2026-10-06T00:00:00.000Z' });
    await writer.receive({ ...event('new-latest', 'arrived between page requests'), occurredAt: '2026-10-06T01:00:00.000Z' });
    const before = await writer.load(); const epoch = writer.epoch;
    let beforeCursor: string | null = first.nextCursor;
    const older: HistoryPageHit[] = [];
    while (beforeCursor) {
      const page = await db.store.history('mira-a').page({ kinds: [...kinds].reverse(), limit: 1, before: beforeCursor });
      assert.equal(page.hits.length, 1); older.unshift(...page.hits); beforeCursor = page.nextCursor;
    }
    assert.deepEqual([...older, ...first.hits], originalTimeline.hits);
    assert.equal(new Set(originalTimeline.hits.map(hit => hit.id)).size, originalTimeline.hits.length);
    const refreshed = await reader.page({ kinds: [...kinds], limit: 2 });
    assert.deepEqual(refreshed.hits.map(hit => hit.id), [uuid('checkpoint'), await eventId(db, 'new-latest', 'mira-a')]);
    assert.deepEqual((await reader.page({ kinds: ['context'], limit: 100 })).hits.map(hit => hit.id), [uuid('same-id'), uuid('checkpoint')]);
    assert.deepEqual(await writer.load(), before); assert.equal(writer.epoch, epoch); await writer.verifyActive();
  } finally { await db.close(); }
});


test('writer-accepted non-PostgreSQL dates never block paging or disappear from history', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const reader = db.store.history(writer.miraId);
    const originals = [
      { ...event('abbreviated-date', 'Date.parse accepts this'), occurredAt: '1' },
      { ...event('overflow-date', 'Date.parse normalizes the calendar overflow'), occurredAt: '2026-02-30T00:00:00Z' },
    ];
    for (const original of originals) {
      assert(Number.isFinite(Date.parse(original.occurredAt)));
      await writer.receive(original);
    }
    await writer.receive(event('normal-date', 'canonical timestamp'));
    const latest = await reader.page({ kinds: ['event'], limit: 1 });
    assert.deepEqual(latest.hits.map(hit => hit.id), [await eventId(db, 'normal-date')]); assert(latest.nextCursor);
    const fallback = await reader.page({ kinds: ['event'], limit: 1, before: latest.nextCursor });
    assert.deepEqual(fallback.hits, [{ kind: 'event', id: await eventId(db, 'overflow-date'), miraId: writer.miraId, occurredAt: originals[1]!.occurredAt, timestampWarning: 'timestamp_not_normalized' }]);
    assert(fallback.nextCursor);
    const oldest = await reader.page({ kinds: ['event'], limit: 1, before: fallback.nextCursor });
    assert.deepEqual(oldest.hits, [{ kind: 'event', id: await eventId(db, 'abbreviated-date'), miraId: writer.miraId, occurredAt: '1', timestampWarning: 'timestamp_not_normalized' }]);
    assert.equal(oldest.nextCursor, null);
    for (const original of originals) {
      const saved = await reader.read({ id: await eventId(db, original.id) }); assert(saved?.kind === 'event'); assert.deepEqual(saved.event, original);
    }
  } finally { await db.close(); }
});


test('one global UUID namespace rejects cross-kind and cross-Mira reuse while original IDs remain distinct', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('a'); const other = await db.acquire('b');
    const externalId = uuid('external-id-that-is-also-a-context-id');
    const original = event(externalId, 'global identity evidence');
    await writer.receive(original, { id: 'external-receipt', reason: 'identity test' });
    const id = await eventId(db, externalId, 'a');
    assert.notEqual(id, externalId);
    await writer.append(0, { ...record('global-context', null, 'context'), id: externalId });
    assert.equal((await db.store.history('a').read({ id: externalId }))?.kind, 'context');
    assert.equal((await db.store.history('a').read({ id }))?.kind, 'event');
    assert.equal(await db.store.history('b').read({ id }), null);
    const collision = (error: unknown) => error instanceof PersistenceError && error.code === 'duplicate';
    await assert.rejects(writer.append(1, { ...record('collision', null, 'wrong kind'), id, parentId: externalId }), collision);
    await assert.rejects(other.append(0, { ...record('collision', null, 'wrong Mira'), id }), collision);
    assert.equal((await writer.load()).version, 1); assert.equal((await other.load()).version, 0);
    assert.equal(writer.signal.aborted, false); assert.equal(other.signal.aborted, false);
    const count = Number((await db.admin.query('SELECT count(*) AS n FROM history_records')).rows[0].n);
    assert.equal(await writer.receive(original, { id: 'external-receipt', reason: 'identity test' }), 'duplicate');
    await assert.rejects(writer.receive(event('another-event', 'must roll back'), { id: 'external-receipt', reason: 'identity test' }), collision);
    assert.equal(Number((await db.admin.query('SELECT count(*) AS n FROM history_records')).rows[0].n), count);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS n FROM life_events WHERE event_id = 'another-event'")).rows[0].n, 0);
    await assert.rejects(db.admin.query("INSERT INTO history_records(id,mira_id,kind) VALUES ($1,'b','tool')", [id]), /unique/);
    await assert.rejects(db.admin.query("INSERT INTO tool_executions(mira_id, history_id, call_id, assistant_record_id, context_version, intent) VALUES ('a',$1,'external-call',$2,1,'{}')", [id, externalId]), /foreign key/);
    await assert.rejects(db.admin.query("INSERT INTO context_records(mira_id,record_id,version,envelope) VALUES ('b',$1,1,'{}')", [id]), /foreign key/);
    await assert.rejects(db.admin.query('UPDATE history_records SET kind = kind'), /append-only/);
    await assert.rejects(db.admin.query('DELETE FROM history_records'), /append-only/);
    assert.equal(Number((await db.admin.query('SELECT count(*) AS n FROM history_records')).rows[0].n), count);
  } finally { await db.close(); }
});

test('identity reservation rolls back with context CAS failure and generated event receipt failure', async () => {
  for (const stage of ['context', 'event'] as const) {
    const db = await createTestDatabase();
    try {
      const writer = await db.acquire();
      const table = stage === 'context' ? 'mira_owners' : 'wake_requests';
      const operation = stage === 'context' ? 'UPDATE' : 'INSERT';
      await db.admin.query(`CREATE FUNCTION reject_history_detail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic history transaction failure'; END $$;
        CREATE TRIGGER reject_history_detail BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_history_detail()`);
      if (stage === 'context') await assert.rejects(writer.append(0, record('rolled-back', null, 'no orphan identity')), /synthetic history transaction failure/);
      else await assert.rejects(writer.receive(event('rolled-back', 'no orphan identity'), { id: 'receipt', reason: 'failure' }), /synthetic history transaction failure/);
      assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM history_records')).rows[0].n, 0);
      assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM context_records')).rows[0].n, 0);
      assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM life_events')).rows[0].n, 0);
      assert.equal((await db.admin.query('SELECT context_version FROM mira_owners')).rows[0].context_version, '0');
    } finally { await db.close(); }
  }
});

test('two Mira writer sessions racing one global UUID commit exactly one context and preserve the loser', { timeout: 15_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writers = [await db.acquire('race-a'), await db.acquire('race-b')];
    const candidate = record('global-race', null, 'one global identity');
    const outcomes = await Promise.allSettled(writers.map(writer => writer.append(0, candidate)));
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['fulfilled', 'rejected']);
    const winner = outcomes.findIndex(outcome => outcome.status === 'fulfilled');
    const loser = winner === 0 ? 1 : 0;
    const rejected = outcomes[loser]; assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof PersistenceError && rejected.reason.code === 'duplicate');
    assert.equal((await writers[winner]!.load()).version, 1);
    assert.deepEqual((await writers[loser]!.load()).records, []);
    assert.equal((await writers[loser]!.load()).version, 0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM history_records')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM context_records')).rows[0].n, 1);
    assert.equal((await db.store.history(writers[winner]!.miraId).read({ id: candidate.id }))?.kind, 'context');
    assert.equal(await db.store.history(writers[loser]!.miraId).read({ id: candidate.id }), null);
    await Promise.all(writers.map(writer => writer.verifyActive()));
    await writers[loser]!.append(0, record('global-race-loser-retry', null, 'a fresh identity after conflict'));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM history_records')).rows[0].n, 2);
    assert.equal((await writers[loser]!.load()).version, 1);
  } finally { await db.close(); }
});

test('lossless History text paging reads over 1 MiB, preserves Unicode and scope, and detects a changing original', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('paged-reader');
    const original = { ...event('large-paged-original', '单行😀\\"'.repeat(130_000) + 'END_OF_COMPLETE_ORIGINAL'), occurredAt: ' '.repeat(400_000) + '2026-10-14' };
    assert.ok(Number.isFinite(Date.parse(original.occurredAt)), 'writer-valid timestamps need not have bounded text length');
    await writer.receive(original);
    const id = await eventId(db, original.id, writer.miraId), reader = db.store.history(writer.miraId);
    await assert.rejects(reader.read({ id, maxBytes: 1_048_576 }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large');
    for (const maxBytes of [4, 4096, 65_536]) {
      const page = await reader.readText({ id, offset: 0, maxBytes }); assert.ok(page);
      assert.ok(!Object.hasOwn(page, 'miraId') && !Object.hasOwn(page, 'occurredAt'));
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 6 * maxBytes + 2048);
    }
    let offset = 0, revision: string | undefined, text = '', pageCount = 0;
    while (true) {
      const page = await reader.readText({ id, offset, maxBytes: 65_536, ...(revision ? { revision } : {}) }); assert.ok(page);
      assert.ok(Buffer.byteLength(page.text) <= 65_536); assert.ok(page.text.isWellFormed());
      assert.equal(page.offset, offset); revision ??= page.revision; assert.equal(page.revision, revision);
      text += page.text; pageCount++;
      if (page.nextOffset === null) { assert.equal([...text].length, page.totalChars); assert.equal(Buffer.byteLength(text), page.totalBytes); break; }
      assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert.ok(pageCount > 1);
    assert.deepEqual(JSON.parse(text), { kind: 'event', id, miraId: writer.miraId, occurredAt: original.occurredAt, event: original, requestedWake: null });
    assert.equal(await db.store.history('foreign-mira').readText({ id, offset: 0 }), null);
    await assert.rejects(reader.readText({ id, offset: 10, revision: '0'.repeat(64) }), /changed.*restart/);
    await assert.rejects(reader.readText({ id, offset: [...text].length + 1, revision }), /beyond the end/);
    assert.equal((await writer.load()).records.length, 0, 'paging never creates a runtime or another log');
    await writer.close();
    assert.equal((await db.store.history('paged-reader').readText({ id, offset: 0 }))?.revision, revision, 'restart retains the exact source identity');

    const active = await db.acquire('mutable-reader');
    await active.receive(event('changing-wake', 'wake'), { id: 'wake', reason: 'test current state' });
    const run = await active.claimWakeBatch(); assert.ok(run);
    const mutable = db.store.history(active.miraId), first = await mutable.readText({ id: run.id, offset: 0 }); assert.ok(first);
    await active.appendWakeInput(run.id, 0, record('paged-input', null, 'input'));
    await assert.rejects(mutable.readText({ id: run.id, offset: 4, revision: first.revision }), /changed.*restart/);
  } finally { await db.close(); }
});


test('history batch validates IDs, fields, count and per-original budgets before reading', async () => {
  const db = await createTestDatabase();
  try {
    const reader = db.store.history('batch-validation');
    const invalidRequests: unknown[] = [null, [], {}, { ids: null }, { ids: 'not-an-array' }, { ids: [null] },
      { ids: ['not-a-uuid'] }, { ids: [uuid('uppercase').toUpperCase()] }, { ids: [uuid('valid'), 'bad'] },
      { ids: Array.from({ length: 11 }, (_, i) => uuid(`over-limit-${i}`)) },
      { ids: [], kind: 'event' }, { ids: [], maxBytes: 0 }, { ids: [], maxBytes: -1 },
      { ids: [], maxBytes: 1.5 }, { ids: [], maxBytes: NaN }, { ids: [], maxBytes: Infinity },
      { ids: [], maxBytes: '1024' }, { ids: [], maxBytes: 1_048_577 }];
    for (const request of invalidRequests) {
      await assert.rejects(reader.readBatch(request as Parameters<typeof reader.readBatch>[0]),
        (error: unknown) => error instanceof HistoryError && error.code === 'invalid', JSON.stringify(request));
    }
    assert.deepEqual(await reader.readBatch({ ids: [] }), []);
    assert.deepEqual(await reader.readBatch({ ids: [], maxBytes: 1 }), []);
    assert.deepEqual(await reader.readBatch({ ids: [], maxBytes: 1_048_576 }), []);
    const ids = Array.from({ length: 10 }, (_, i) => uuid(`at-limit-${i}`));
    assert.deepEqual(await reader.readBatch({ ids, maxBytes: 1 }), ids.map(id => ({ id, entry: null, tooLarge: false })));
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM mira_owners')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('history batch preserves requested order and duplicates with read-equivalent originals across all four kinds', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('batch-a'), other = await db.acquire('batch-b');
    await writer.receive(event('batch-event', 'original event'), { id: 'batch-wake', reason: 'original wake' });
    await other.receive(event('batch-foreign', 'private foreign event'));
    await writer.append(0, record('batch-context', null, 'original opaque context'));
    await writer.beginTool(1, { callId: 'batch-tool', assistantRecordId: uuid('batch-context'), toolName: 'synthetic', requestedArguments: { raw: true }, arguments: {}, occurredAt: now });
    await writer.finishTool({ callId: 'batch-tool', occurredAt: now, payload: { text: 'original outcome' } });
    const run = await writer.claimWakeBatch(); assert.ok(run);
    const reader = db.store.history(writer.miraId);
    const toolId = (await reader.page({ kinds: ['tool'] })).hits[0]!.id;
    const externalId = await eventId(db, 'batch-event', writer.miraId);
    const foreignId = await eventId(db, 'batch-foreign', other.miraId);
    const ids = [toolId, foreignId, run.id, externalId, uuid('batch-missing'), uuid('batch-context'), toolId];
    const before = await writer.load(), epoch = writer.epoch;
    const expected = await Promise.all(ids.map(async id => ({ id, entry: await reader.read({ id }), tooLarge: false })));
    assert.deepEqual(await reader.readBatch({ ids }), expected);
    assert.equal(expected[1]!.entry, null); assert.equal(expected[4]!.entry, null);
    assert.deepEqual(await writer.load(), before); assert.equal(writer.epoch, epoch); await writer.verifyActive();
  } finally { await db.close(); }
});

test('history batch bounds each original independently without truncation or blocking its smaller neighbors', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(), reader = db.store.history(writer.miraId);
    await writer.receive(event('batch-small', 'complete 😀 original'));
    await writer.receive(event('batch-large', '单😀'.repeat(20_000)));
    await writer.receive(event('batch-huge', 'x'.repeat(1_100_000)));
    const small = await eventId(db, 'batch-small'), large = await eventId(db, 'batch-large'), huge = await eventId(db, 'batch-huge');
    const completeSmall = await reader.read({ id: small });
    assert.deepEqual(await reader.readBatch({ ids: [large, small, huge, small] }), [
      { id: large, entry: null, tooLarge: true }, { id: small, entry: completeSmall, tooLarge: false },
      { id: huge, entry: null, tooLarge: true }, { id: small, entry: completeSmall, tooLarge: false },
    ]);
    for (const id of [large, huge]) await assert.rejects(reader.read({ id }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large');
    const size = await reader.readText({ id: small, offset: 0 }); assert.ok(size);
    await assert.rejects(reader.read({ id: small, maxBytes: size.totalBytes - 1 }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large');
    assert.deepEqual(await reader.readBatch({ ids: [small], maxBytes: size.totalBytes - 1 }), [{ id: small, entry: null, tooLarge: true }]);
    assert.deepEqual(await reader.readBatch({ ids: [small], maxBytes: size.totalBytes }), [{ id: small, entry: completeSmall, tooLarge: false }]);
    const completeLarge = await reader.read({ id: large, maxBytes: 1_048_576 }); assert.ok(completeLarge);
    assert.deepEqual(await reader.readBatch({ ids: [huge, large, large, small], maxBytes: 1_048_576 }), [
      { id: huge, entry: null, tooLarge: true }, { id: large, entry: completeLarge, tooLarge: false },
      { id: large, entry: completeLarge, tooLarge: false }, { id: small, entry: completeSmall, tooLarge: false },
    ]);
    assert.deepEqual(await reader.readBatch({ ids: [small, uuid('tiny-budget-missing')], maxBytes: 1 }), [
      { id: small, entry: null, tooLarge: true }, { id: uuid('tiny-budget-missing'), entry: null, tooLarge: false },
    ]);
  } finally { await db.close(); }
});

test('history batch rejects corrupt source identity and missing detail just as read does, even below the byte budget', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(), reader = db.store.history(writer.miraId);
    await writer.receive(event('batch-valid', 'valid neighbor'));
    const valid = await eventId(db, 'batch-valid');
    const corruptId = uuid('batch-corrupt'), orphanId = uuid('batch-orphan');
    // Deliberately malformed fixture rows in this test's disposable schema;
    // no production trigger or integrity constraint is disabled.
    for (const id of [corruptId, orphanId]) await db.admin.query("INSERT INTO history_records(id,mira_id,kind) VALUES ($1,$2,'context')", [id, writer.miraId]);
    await db.admin.query('INSERT INTO context_records(mira_id,record_id,version,envelope) VALUES ($1,$2,1,$3)',
      [writer.miraId, corruptId, JSON.stringify(record('mismatched-envelope-id', null, 'x'.repeat(100_000)))]);
    const corrupt = (error: unknown) => error instanceof HistoryError && error.code === 'corrupt';
    for (const id of [corruptId, orphanId]) {
      await assert.rejects(reader.read({ id }), corrupt);
      await assert.rejects(reader.readBatch({ ids: [valid, id, valid] }), corrupt);
      await assert.rejects(reader.readBatch({ ids: [id], maxBytes: 1 }), corrupt);
      assert.deepEqual(await db.store.history('foreign-reader').readBatch({ ids: [id] }), [{ id, entry: null, tooLarge: false }]);
    }
  } finally { await db.close(); }
});

test('history batch observes a pending tool and its later durable outcome without replay or stale caching', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(), reader = db.store.history(writer.miraId);
    await writer.append(0, record('batch-pending-assistant', null, 'tool invocation'));
    const intent: ToolIntent = { callId: 'batch-pending', assistantRecordId: uuid('batch-pending-assistant'), toolName: 'synthetic', requestedArguments: {}, arguments: {}, occurredAt: now };
    await writer.beginTool(1, intent);
    const id = (await reader.page({ kinds: ['tool'] })).hits[0]!.id;
    const pending = await reader.read({ id }); assert.ok(pending?.kind === 'tool'); assert.equal(pending.outcome, null);
    assert.deepEqual(await reader.readBatch({ ids: [id] }), [{ id, entry: pending, tooLarge: false }]);
    const outcome = { callId: intent.callId, occurredAt: now, payload: { text: 'completed once' } };
    await writer.finishTool(outcome);
    const complete = await reader.read({ id }); assert.ok(complete?.kind === 'tool'); assert.deepEqual(complete.outcome, outcome);
    assert.deepEqual(await reader.readBatch({ ids: [id, id] }), [{ id, entry: complete, tooLarge: false }, { id, entry: complete, tooLarge: false }]);
    assert.equal((await db.admin.query('SELECT count(*)::integer AS n FROM tool_executions')).rows[0].n, 1);
    await writer.verifyActive();
  } finally { await db.close(); }
});

test('history snapshot shares one repeatable-read connection, nests, rolls back failures and expires its reader', async () => {
  const db = await createTestDatabase();
  const { Client } = await import('pg');
  const connect = Client.prototype.connect; let connections = 0;
  try {
    const writer = await db.acquire(), reader = db.store.history(writer.miraId);
    for (let index = 0; index < 25; index++) await writer.receive(event(`snapshot-${index}`, `snapshot ${index}`));
    Client.prototype.connect = function (this: InstanceType<typeof Client>, ...args: Parameters<typeof connect>) {
      if ((this as unknown as { connectionParameters?: { application_name?: string } }).connectionParameters?.application_name === 'mira-history-reader') connections++;
      return Reflect.apply(connect, this, args);
    } as typeof connect;
    let escaped: typeof reader | undefined;
    const result = await reader.snapshot(async snapshot => {
      escaped = snapshot;
      const first = await snapshot.page({ kinds: ['event'], limit: 10 }); assert.ok(first.nextCursor);
      // A commit after the snapshot began is invisible to every later read in it.
      await writer.receive(event('snapshot-late', 'committed during snapshot'));
      const second = await snapshot.page({ kinds: ['event'], limit: 10, before: first.nextCursor });
      const originals = await snapshot.readBatch({ ids: [...first.hits, ...second.hits].slice(0, 10).map(hit => hit.id) });
      const nested = await snapshot.snapshot(async inner => (await inner.page({ kinds: ['event'], limit: 100 })).hits.length);
      return { first, second, originals, nested };
    });
    assert.equal(result.first.hits.length, 10); assert.equal(result.second.hits.length, 10);
    assert.equal(result.originals.length, 10); assert.ok(result.originals.every(item => item.entry && !item.tooLarge));
    assert.equal(result.nested, 25, 'the nested snapshot reuses the outer snapshot and does not see the later commit');
    assert.equal(connections, 1, 'every read in the snapshot shares one reader connection');
    assert.equal((await reader.page({ kinds: ['event'], limit: 100 })).hits.length, 26, 'a fresh read sees the later commit');
    await assert.rejects(escaped!.page({ kinds: ['event'] }), (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
    await assert.rejects(reader.snapshot(async snapshot => {
      await snapshot.page({ kinds: ['event'], limit: 1 });
      throw Error('synthetic snapshot failure');
    }), /synthetic snapshot failure/);
    await assert.rejects(reader.snapshot(async snapshot => snapshot.readBatch({ ids: ['not-a-uuid'] })),
      (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
    await assert.rejects(reader.snapshot(null as unknown as Parameters<typeof reader.snapshot>[0]),
      (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
    const idle = (await db.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'mira-history-reader' AND state LIKE 'idle in transaction%'")).rows[0].n;
    assert.equal(idle, 0, 'every snapshot connection was committed or rolled back and closed');
    await writer.verifyActive();
  } finally { Client.prototype.connect = connect; await db.close(); }
});
