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
const eventEntry = {
  kind: 'event', id: 'same-id', miraId: 'mira-a', occurredAt: now,
  event: { id: 'same-id', type: 'synthetic', source: 'external', occurredAt: now, payload: { Chinese: '顺德菜', opaque: [null, 1, true] } }, requestedWake: null,
};

test('history rejects invalid scope and bounded requests before opening a connection', async (t) => {
  const mock = mockDatabase(t, null); const history = store().history('mira-a');
  assert.throws(() => store().history(''), HistoryError);
  for (const request of [null, {}, { query: '' }, { query: '\0' }, { query: '  ' }, { query: '中'.repeat(342) }, { query: 'x', mode: 'semantic' }, { query: 'x', limit: 0 }, { query: 'x', limit: 101 }, { query: 'x', limit: 1.5 }, { query: 'x', kinds: [] }, { query: 'x', kinds: ['event', 'event'] }, { query: 'x', kinds: ['event; DROP TABLE life_events'] }]) {
    await assert.rejects(history.search(request as unknown as HistorySearchRequest), (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
  }
  for (const request of [null, {}, { kind: 'event', id: '' }, { kind: 'event', id: 'x', maxBytes: 0 }, { kind: 'event', id: 'x', maxBytes: 1_048_577 }, { kind: 'unknown', id: 'x' }]) {
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
  assert.deepEqual(await store().history('mira-a').read({ kind: 'event', id: 'same-id' }), eventEntry);
  const query = mock.queries.find(item => item.parameters)!;
  assert(query.sql.includes('WHERE mira_id = $1 AND event_id = $2'));
  assert.deepEqual(query.parameters, ['mira-a', 'same-id', 65_536]);
  assert.equal(mock.closed(), 1);
});

test('read preserves unknown runtime payload fields and rejects mismatched metadata', async (t) => {
  const entry = { kind: 'context', id: 'r1', miraId: 'mira-a', occurredAt: now, version: 1,
    record: { formatVersion: 1, runtime: 'completely-unrecognized', runtimeVersion: '999', kind: 'checkpoint', id: 'r1', parentId: null, occurredAt: now, payload: { secretFormat: { nested: [null, 'exact'] } } } };
  mockDatabase(t, entry);
  assert.deepEqual(await store().history('mira-a').read({ kind: 'context', id: 'r1' }), entry);
  await assert.rejects(store().history('mira-b').read({ kind: 'context', id: 'r1' }), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
});

test('an absent exact ID is null, while oversized records fail explicitly before payload transfer', async (t) => {
  const mock = mockDatabase(t, null, { bytes: 70_000 });
  await assert.rejects(store().history('mira-a').read({ kind: 'event', id: 'large' }), (error: unknown) => error instanceof HistoryError && error.code === 'too_large' && error.requiredBytes === 70_000);
  assert(mock.queries.find(item => item.parameters)!.sql.includes('CASE WHEN bytes <= $3 THEN body ELSE NULL END'));
});

test('missing rows return null and source corruption is never returned as evidence', async (t) => {
  await t.test('absent', async (child) => {
    mockDatabase(child, null, { absent: true });
    assert.equal(await store().history('mira-a').read({ kind: 'event', id: 'missing' }), null);
  });
  await t.test('corrupt', async (child) => {
    mockDatabase(child, eventEntry, { valid: false });
    await assert.rejects(store().history('mira-a').read({ kind: 'event', id: 'same-id' }), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
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
