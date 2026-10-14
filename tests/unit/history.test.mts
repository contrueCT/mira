import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Client } from 'pg';
import { HistoryError } from '@mira/life';
import type { HistoryReadRequest, HistorySearchRequest } from '@mira/life';
import { PostgresPersistence } from '@mira/persistence';

const store = () => new PostgresPersistence({ connectionString: 'postgres://synthetic.invalid/never-connect', schema: 'synthetic_history' });
function mockDatabase(t: TestContext, body: unknown, options: { bytes?: number; valid?: boolean; queryError?: Error; connectError?: Error; absent?: boolean } = {}) {
  const queries: { sql: string; parameters?: unknown[] }[] = [];
  let connected = 0; let closed = 0;
  t.mock.method(Client.prototype, 'connect', async () => { connected++; if (options.connectError) throw options.connectError; });
  t.mock.method(Client.prototype, 'end', async () => { closed++; });
  t.mock.method(Client.prototype, 'query', async (sql: string, parameters?: unknown[]) => {
    queries.push({ sql, ...(parameters === undefined ? {} : { parameters }) });
    if (sql.startsWith('WITH response')) {
      if (options.queryError) throw options.queryError;
      return { rows: options.absent ? [] : [{ body, bytes: options.bytes ?? Buffer.byteLength(JSON.stringify(body)), valid: options.valid ?? true }] };
    }
    return { rows: [] };
  });
  return { queries, connected: () => connected, closed: () => closed };
}
const now = '2026-10-05T00:00:00.000Z';
const id = '11111111-1111-4111-8111-111111111111';
const contextId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const eventEntry = {
  kind: 'event', id, miraId: 'mira-a', occurredAt: now,
  event: { id: 'same-id', type: 'synthetic', source: 'external', occurredAt: now, payload: { Chinese: '顺德菜', opaque: [null, 1, true] } }, requestedWake: null,
};

test('history rejects invalid scope and bounded requests before opening a connection', async (t) => {
  const mock = mockDatabase(t, null); const history = store().history('mira-a');
  assert.throws(() => store().history(''), HistoryError);
  for (const request of [null, {}, { query: '' }, { query: '\0' }, { query: '  ' }, { query: '中'.repeat(342) }, { query: 'x', mode: 'semantic' }, { query: 'x', limit: 0 }, { query: 'x', limit: 101 }, { query: 'x', limit: 1.5 }, { query: 'x', kinds: [] }, { query: 'x', kinds: ['event', 'event'] }, { query: 'x', kinds: ['event; DROP TABLE life_events'] }]) {
    await assert.rejects(history.search(request as unknown as HistorySearchRequest), (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
  }
  for (const request of [null, {}, { kind: 'event', id: '' }, { id, maxBytes: 0 }, { id, maxBytes: 1_048_577 }, { id: 'not-a-uuid' }, { kind: 'event', id }, { id, extra: true }]) {
    await assert.rejects(history.read(request as unknown as HistoryReadRequest), HistoryError);
  }
  assert.equal(mock.connected(), 0);
});

test('history search parameterizes text and binds every original source to the trusted Mira', async (t) => {
  const body = { query: "needle' OR true --", mode: 'full_text', fullTextPrefixChars: 65_536, hits: [], hasMore: false };
  const mock = mockDatabase(t, body);
  assert.deepEqual(await store().history('mira-a').search({ query: body.query }), body);
  const query = mock.queries.find(item => item.parameters)!;
  assert.equal((query.sql.match(/WHERE mira_id = \$1 AND/g) ?? []).length, 4);
  assert(!query.sql.includes(body.query));
  assert(query.sql.includes("plainto_tsquery('simple'::regconfig, $2)"));
  assert(query.sql.includes('LIMIT $3 + 1'));
  assert.deepEqual(query.parameters, ['mira-a', body.query, 20, 'full_text', 65_536, 262_144]);
  assert.equal(mock.queries[0]!.sql, 'BEGIN READ ONLY');
  assert(mock.queries.some(item => item.sql === "SET LOCAL statement_timeout = '5s'"));
  assert(!mock.queries.some(item => /INSERT|UPDATE|DELETE|advisory|FOR UPDATE/.test(item.sql)));
  assert.equal(mock.queries.at(-1)!.sql, 'COMMIT'); assert.equal(mock.closed(), 1);
});

test('substring mode is explicit, literal, and scans the full selected original text', async (t) => {
  const body = { query: '%_顺德', mode: 'substring', fullTextPrefixChars: null, hits: [], hasMore: false };
  const mock = mockDatabase(t, body);
  assert.deepEqual(await store().history('mira-a').search({ query: body.query, mode: 'substring', kinds: ['event'], limit: 4 }), body);
  const query = mock.queries.find(item => item.parameters)!;
  assert(query.sql.includes('strpos(lower(event::text')); assert(!query.sql.includes('ILIKE'));
  assert(!query.sql.includes('to_tsvector')); assert(!query.sql.includes('FROM context_records'));
  assert.deepEqual(query.parameters, ['mira-a', body.query, 4, 'substring', null, 262_144]);
});

test('read returns exact opaque originals and read-only provenance without executing or decoding them', async (t) => {
  const mock = mockDatabase(t, eventEntry);
  assert.deepEqual(await store().history('mira-a').read({ id }), eventEntry);
  const query = mock.queries.find(item => item.parameters)!;
  assert(query.sql.includes('WHERE h.mira_id = $1 AND h.id = $2::uuid'));
  assert.deepEqual(query.parameters, ['mira-a', id, 65_536]);
  assert.equal(mock.closed(), 1);
});

test('read preserves unknown runtime payload fields and rejects mismatched metadata', async (t) => {
  const entry = { kind: 'context', id: contextId, miraId: 'mira-a', occurredAt: now, version: 1,
    record: { formatVersion: 1, runtime: 'completely-unrecognized', runtimeVersion: '999', kind: 'checkpoint', id: contextId, parentId: null, occurredAt: now, payload: { secretFormat: { nested: [null, 'exact'] } } } };
  mockDatabase(t, entry);
  assert.deepEqual(await store().history('mira-a').read({ id: contextId }), entry);
  await assert.rejects(store().history('mira-b').read({ id: contextId }), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
});

test('an absent exact ID is null, while oversized records fail explicitly before payload transfer', async (t) => {
  const mock = mockDatabase(t, null, { bytes: 70_000 });
  await assert.rejects(store().history('mira-a').read({ id }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large' && error.requiredBytes === 70_000);
  assert(mock.queries.find(item => item.parameters)!.sql.includes('CASE WHEN bytes <= $3 THEN body ELSE NULL END'));
});

test('missing rows return null and source corruption is never returned as evidence', async (t) => {
  await t.test('absent', async (child) => {
    mockDatabase(child, null, { absent: true });
    assert.equal(await store().history('mira-a').read({ id }), null);
  });
  await t.test('corrupt', async (child) => {
    mockDatabase(child, eventEntry, { valid: false });
    await assert.rejects(store().history('mira-a').read({ id }), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
  });
});

test('failed history queries roll back and close; connection failures do not queue a rollback', async (t) => {
  await t.test('query', async (child) => {
    const failure = Error('synthetic database timeout'); const mock = mockDatabase(child, null, { queryError: failure });
    await assert.rejects(store().history('mira-a').search({ query: 'needle' }), failure);
    assert.equal(mock.queries.at(-1)!.sql, 'ROLLBACK'); assert.equal(mock.closed(), 1);
  });
  await t.test('connect', async (child) => {
    const failure = Error('synthetic connection failure'); const mock = mockDatabase(child, null, { connectError: failure });
    await assert.rejects(store().history('mira-a').search({ query: 'needle' }), failure);
    assert.deepEqual(mock.queries, []); assert.equal(mock.closed(), 1);
  });
});

test('chronological pages reject malformed or oversized requests before connecting', async (t) => {
  const mock = mockDatabase(t, null); const history = store().history('mira-a');
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const request of [null, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { kinds: [] }, { kinds: ['event', 'event'] }, { kinds: ['event; DROP TABLE life_events'] }, { before: null }, { before: '' }, { before: 'not a cursor' }, { before: 'a' }, { before: 'a'.repeat(524_289) }, { before: encoded(null) }, { before: encoded({}) }]) {
    await assert.rejects(history.page(request as never), (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
  }
  assert.equal(mock.connected(), 0);
});

test('chronological page SQL is read-only, scoped, bounded, and projects references without original payloads', async (t) => {
  const mock = mockDatabase(t, { hits: [], hasMore: false });
  assert.deepEqual(await store().history('mira-a').page(), { hits: [], nextCursor: null });
  const query = mock.queries.find(item => item.parameters)!;
  assert.equal((query.sql.match(/WHERE mira_id = \$1/g) ?? []).length, 4);
  assert(query.sql.includes('LIMIT $2 + 1'));
  assert(query.sql.includes('ORDER BY time_group DESC, occurred_time DESC, raw_timestamp COLLATE "C" DESC, kind COLLATE "C" DESC, id COLLATE "C" DESC'));
  assert(query.sql.includes("CASE WHEN pg_input_is_valid(event->>'occurredAt', 'timestamp with time zone') THEN extract(epoch FROM"));
  assert(query.sql.includes('ORDER BY n DESC'));
  assert(query.sql.includes('extract(epoch FROM'));
  assert(!/event::text|envelope::text|intent::text|json_build_object\('record'/.test(query.sql));
  assert.deepEqual(query.parameters, ['mira-a', 20, null, null, null, null, null, 262_144]);
  assert.equal(mock.queries[0]!.sql, 'BEGIN READ ONLY');
  assert(mock.queries.some(item => item.sql === "SET LOCAL TIME ZONE 'UTC'"));
  assert(!mock.queries.some(item => /INSERT|UPDATE|DELETE|advisory|FOR UPDATE/.test(item.sql)));
  assert.equal(mock.queries.at(-1)!.sql, 'COMMIT'); assert.equal(mock.closed(), 1);
});

test('chronological cursors preserve timestamp precision, bind scope and kinds, and use the oldest displayed reference', async (t) => {
  const rows = [
    { kind: 'context', id: contextId, miraId: 'mira-a', occurredAt: '2026-10-05T00:00:00.000001Z', cursorGroup: 1, cursorTimestamp: '1791158400.000001', cursorRawTimestamp: '' },
    { kind: 'event', id: secondId, miraId: 'mira-a', occurredAt: '2026-10-05T08:00:00.000001+08:00', cursorGroup: 1, cursorTimestamp: '1791158400.000001', cursorRawTimestamp: '' },
  ];
  const mock = mockDatabase(t, { hits: rows, hasMore: true }); const reader = store().history('mira-a');
  const first = await reader.page({ kinds: ['context', 'event'], limit: 2 });
  assert.deepEqual(first.hits, rows.map(({ cursorGroup: _group, cursorTimestamp: _time, cursorRawTimestamp: _raw, ...hit }) => hit));
  assert(first.nextCursor); assert(!JSON.stringify(first.hits).includes('cursorTimestamp'));
  const fields = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as unknown[];
  assert.deepEqual(fields.slice(2), [1, '1791158400.000001', '', 'context', contextId]);
  const second = await reader.page({ kinds: ['event', 'context'], limit: 2, before: first.nextCursor });
  assert.deepEqual(second, first, 'reordered kinds have the same cursor scope');
  const queries = mock.queries.filter(item => item.parameters); const query = queries[1]!;
  assert.deepEqual(query.parameters, ['mira-a', 2, 1, '1791158400.000001', '', 'context', contextId, 262_144]);
  assert(!query.sql.includes("a' OR true --"));
  assert(query.sql.includes('(time_group, occurred_time, raw_timestamp COLLATE "C", kind COLLATE "C", id COLLATE "C") <'));
  assert(query.sql.includes('($3::integer, $4::numeric, $5::text COLLATE "C", $6::text COLLATE "C", $7::text COLLATE "C")'));
  assert(!query.sql.includes('FROM tool_executions')); assert(!query.sql.includes('FROM wake_runs'));
  await assert.rejects(store().history('mira-b').page({ kinds: ['event', 'context'], before: first.nextCursor }), HistoryError);
  await assert.rejects(reader.page({ kinds: ['event'], before: first.nextCursor }), HistoryError);
  const malformed = [
    [2, ...fields.slice(1)], [...fields, 'extra'], [1, fields[1], 1, 'Infinity', '', 'context', 'id'],
    [1, fields[1], 1, '1791158400.0000001', '', 'context', 'id'], [1, fields[1], 1, fields[3], '', 'tool', 'id'],
    [1, fields[1], 1, fields[3], '', 'context', ''], [1, fields[1], 1, fields[3], '', 'context', '\ud800'],
    [1, fields[1], 1, fields[3], '', 'context', 'x'.repeat(65_537)], [1, fields[1], 2, fields[3], '', 'context', 'id'],
    [1, fields[1], 0, '1', '1', 'context', 'id'], [1, fields[1], 0, '0', '', 'context', 'id'],
    [1, fields[1], 1, fields[3], 'unnecessary', 'context', 'id'],
  ];
  for (const cursor of malformed) await assert.rejects(reader.page({ kinds: ['event', 'context'], before: Buffer.from(JSON.stringify(cursor)).toString('base64url') }), HistoryError);
  const invalidUtf8 = Buffer.concat([Buffer.from(JSON.stringify([1, fields[1], 1, fields[3], '', 'context']).slice(0, -1) + ',"'), Buffer.from([0xff]), Buffer.from('"]')]).toString('base64url');
  await assert.rejects(reader.page({ kinds: ['event', 'context'], before: invalidUtf8 }), HistoryError);
  assert.equal(mock.connected(), 2);
});

test('chronological pages report oversized or corrupt metadata and clean up failed read-only requests', async (t) => {
  await t.test('oversized', async (child) => {
    const mock = mockDatabase(child, null, { bytes: 300_000 });
    await assert.rejects(store().history('mira-a').page(), (error: unknown) => error instanceof HistoryError && error.code === 'too_large' && error.requiredBytes === 300_000);
    assert(mock.queries.find(item => item.parameters)!.sql.includes('CASE WHEN bytes <= $8 THEN body ELSE NULL END'));
  });
  await t.test('corrupt source', async (child) => {
    mockDatabase(child, { hits: [], hasMore: false }, { valid: false });
    await assert.rejects(store().history('mira-a').page(), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
  });
  await t.test('corrupt scope', async (child) => {
    mockDatabase(child, { hits: [{ ...eventEntry, miraId: 'other', cursorTimestamp: '1791158400.000000' }], hasMore: false });
    await assert.rejects(store().history('mira-a').page(), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
  });
  await t.test('query failure', async (child) => {
    const failure = Error('synthetic page timeout'); const mock = mockDatabase(child, null, { queryError: failure });
    await assert.rejects(store().history('mira-a').page(), failure);
    assert.equal(mock.queries.at(-1)!.sql, 'ROLLBACK'); assert.equal(mock.closed(), 1);
  });
});


test('writer-accepted timestamps PostgreSQL cannot normalize remain pageable with the complete fallback cursor', async (t) => {
  const occurredAt = '2026-02-30T00:00:00Z';
  assert(Number.isFinite(Date.parse(occurredAt)));
  const hit = { kind: 'event', id: secondId, miraId: 'mira-a', occurredAt };
  const mock = mockDatabase(t, { hits: [{ ...hit, cursorGroup: 0, cursorTimestamp: '0', cursorRawTimestamp: occurredAt }], hasMore: true });
  const reader = store().history('mira-a');
  const page = await reader.page({ kinds: ['event'], limit: 1 });
  assert.deepEqual(page.hits, [{ ...hit, timestampWarning: 'timestamp_not_normalized' }]); assert(page.nextCursor);
  await reader.page({ kinds: ['event'], limit: 1, before: page.nextCursor });
  assert.deepEqual(mock.queries.filter(query => query.parameters)[1]!.parameters, ['mira-a', 1, 0, '0', occurredAt, 'event', secondId, 262_144]);
});

test('management run headers omit unbounded membership while preserving exact total and checkpoint metadata', async t => {
  const run = { kind: 'wake', id, miraId: 'mira-a', occurredAt: now, claimedVersion: 0, inputRecordId: null, finalRecordId: null, status: 'running', requestCount: 6501 };
  const mock = mockDatabase(t, { run, memory: null, records: [], hasMore: false });
  const result = await store().history('mira-a').readRun({ id, limit: 1 });
  assert.equal(result?.run.requestCount, 6501); assert.equal(Object.hasOwn(result!.run, 'requests'), false);
  const query = mock.queries.find(item => item.parameters)!;
  assert.match(query.sql, /SELECT count\(\*\) FROM wake_run_requests members/);
  assert.doesNotMatch(query.sql, /externalEventId|wakeReceiptId|receiptOrder|json_agg\(json_build_object\('wakeReceiptId'/);
  assert.deepEqual(query.parameters, ['mira-a', id, 1, null, null, null, 262_144, false]);
  assert.equal(mock.queries[0]!.sql, 'BEGIN READ ONLY');
});

test('management run list reads only fixed headers instead of original large Wake records', async t => {
  const run = { kind: 'wake', id, miraId: 'mira-a', occurredAt: now, claimedVersion: 0, inputRecordId: null, finalRecordId: null, status: 'running', requestCount: 6501 };
  const mock = mockDatabase(t, { items: [run] }); const history = store().history('mira-a');
  t.mock.method(history, 'page', async () => ({ hits: [{ kind: 'wake', id, miraId: 'mira-a', occurredAt: now }], nextCursor: 'older' }));
  assert.deepEqual(await history.pageRuns(), { items: [run], nextCursor: 'older' });
  const query = mock.queries.find(item => item.parameters)!;
  assert.match(query.sql, /unnest\(\$2::uuid\[\]\) WITH ORDINALITY/);
  assert.doesNotMatch(query.sql, /externalEventId|wakeReceiptId|requested_wake|event::text/);
  assert.deepEqual(query.parameters, ['mira-a', [id], 262_144]);
});

test('trigger-member pages have independent scoped cursors and bounded descriptions without event payloads', async t => {
  const member = { eventId: secondId, source: 'user', type: 'web.message', reason: 'Synthetic reason', receiptOrder: '6501' };
  const mock = mockDatabase(t, { items: [member], hasMore: true }); const history = store().history('mira-a');
  const first = await history.readRunRequests({ id, limit: 1 }); assert(first?.nextCursor);
  assert.deepEqual(first.items, [{ eventId: secondId, source: 'user', type: 'web.message', reason: 'Synthetic reason' }]);
  const query = mock.queries.find(item => item.parameters)!;
  assert.match(query.sql, /ORDER BY w.receipt_order DESC LIMIT \$3 \+ 1/);
  assert.match(query.sql, /octet_length\(description::text\) <= 2048/);
  assert.doesNotMatch(query.sql, /->'payload'|event::text|requestedArguments/);
  assert.deepEqual(query.parameters, ['mira-a', id, 1, null, 262_144]);
  await history.readRunRequests({ id, limit: 1, before: first.nextCursor });
  assert.equal(mock.queries.filter(item => item.parameters).at(-1)!.parameters![3], '6501');
  await assert.rejects(history.readRunRequests({ id: contextId, before: first.nextCursor }), HistoryError);
  await assert.rejects(store().history('mira-b').readRunRequests({ id, before: first.nextCursor }), HistoryError);
  await assert.rejects(history.readRun({ id, before: first.nextCursor }), HistoryError);
});


test('run refresh cursors retain an exact inclusive tuple while ordinary pagination remains strict', async t => {
  const run = { kind: 'wake', id, miraId: 'mira-a', occurredAt: now, claimedVersion: 0, inputRecordId: null, finalRecordId: null, status: 'running', requestCount: 1 };
  const mock = mockDatabase(t, { run, memory: null, records: [{ id: secondId, kind: 'tool', occurredAt: now, version: 28 }], hasMore: true });
  const history = store().history('mira-a');
  const first = await history.readRun({ id }); assert(first?.refreshCursor); assert(first.nextCursor);
  const inclusive = JSON.parse(Buffer.from(first.refreshCursor, 'base64url').toString('utf8')) as unknown[];
  const strict = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')) as unknown[];
  assert.deepEqual(inclusive.slice(1), [28, 'tool', secondId, true]);
  assert.deepEqual(strict, inclusive.slice(0, 4));
  await history.readRun({ id, before: first.refreshCursor });
  await history.readRun({ id, before: first.nextCursor });
  const queries = mock.queries.filter(query => query.parameters);
  assert.deepEqual(queries[1]!.parameters, ['mira-a', id, 50, 28, 'tool', secondId, 262_144, true]);
  assert.deepEqual(queries[2]!.parameters, ['mira-a', id, 50, 28, 'tool', secondId, 262_144, false]);
});

const revision = 'a'.repeat(64);
const pageEntry = { kind: 'event' as const, id, miraId: 'mira-a', occurredAt: now, format: 'json-text' as const,
  text: '😀中\\"', offset: 0, nextOffset: 4, totalChars: 2_000_000, totalBytes: 3_000_000, revision };

test('History text pages keep database transfer bounded and preserve Unicode with explicit continuation identity', async t => {
  const mock = mockDatabase(t, pageEntry);
  assert.deepEqual(await store().history('mira-a').readText({ id, offset: 0, maxBytes: 32 }), pageEntry);
  const query = mock.queries.find(item => item.parameters)!;
  assert.match(query.sql, /substring\(text FROM \$3::integer \+ 1 FOR \$4::integer\)/);
  assert.match(query.sql, /sha256\(convert_to\(text, 'UTF8'\)\)/);
  assert.deepEqual(query.parameters, ['mira-a', id, 0, 8, 6 * 32 + 2048]);
  assert.equal((query.sql.match(/WHERE h.mira_id = \$1 AND h.id = \$2::uuid/g) ?? []).length, 4);
  assert.equal(mock.queries[0]?.sql, 'BEGIN READ ONLY');
  assert.equal(mock.queries.at(-1)?.sql, 'COMMIT');
});

test('History text requests reject unbounded reads and unbound continuations before any connection', async t => {
  const mock = mockDatabase(t, null); const reader = store().history('mira-a');
  for (const request of [{ id, offset: -1 }, { id, offset: 1 }, { id, offset: 1, revision: 'bad' }, { id, offset: 0, maxBytes: 3 }, { id, offset: 0, maxBytes: 65_537 }, { id, offset: 0, extra: true }, { id, offset: 2_147_483_647 }]) {
    await assert.rejects(reader.readText(request as Parameters<typeof reader.readText>[0]), HistoryError);
  }
  assert.equal(mock.connected(), 0);
});

for (const field of [{ miraId: 'foreign' }, { nextOffset: 3 }, { totalChars: 2 }, { text: 'too long'.repeat(1000) }]) test(`corrupt History text page rejects ${Object.keys(field)[0]}`, async t => {
  mockDatabase(t, { ...pageEntry, ...field });
  await assert.rejects(store().history('mira-a').readText({ id, offset: 0 }), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
});

test('a different History revision fails explicitly instead of joining two versions', async t => {
  mockDatabase(t, { ...pageEntry, offset: 4, nextOffset: 8 });
  await assert.rejects(store().history('mira-a').readText({ id, offset: 4, revision: 'b'.repeat(64) }), /changed.*restart/);
});
