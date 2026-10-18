import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { assertJson, assertRecord } from '@mira/context';
import { HistoryError } from '@mira/life';
import type { HistoryEntry, HistoryKind, HistoryPageHit, HistoryPageRequest, HistoryPageResult, RunHistoryReader, HistoryEventRun, HistoryRunPage, HistoryRunPageRequest, HistoryRunHeader, HistoryRunRequestsPage, HistoryReadRequest, HistoryTextRequest, HistoryTextPage, HistorySearchRequest, HistorySearchResult } from '@mira/life';
import type { PostgresOptions } from './index.ts';

const FULL_TEXT_PREFIX_CHARS = 65_536;
const MAX_SEARCH_BYTES = 262_144;
const MAX_PAGE_BYTES = 262_144;
const MAX_CURSOR_BYTES = 524_288;
const kinds: HistoryKind[] = ['event', 'context', 'tool', 'wake'];
interface Source { table: string; id: string; timestamp: string; document: string; body: string; integrity: string }
/** Runtime payloads are opaque JSON. The same bounded expression appears in
 * migration 0003; it must not make large original records impossible to write. */
const sources: Record<HistoryKind, Source> = {
  event: {
    table: 'life_events', id: 'history_id', timestamp: "event->>'occurredAt'",
    document: "event::text || E'\\n' || coalesce(requested_wake::text, '')",
    body: "'event', event, 'requestedWake', requested_wake",
    integrity: "event->>'id' = event_id",
  },
  context: {
    table: 'context_records', id: 'record_id', timestamp: "envelope->>'occurredAt'", document: 'envelope::text',
    body: "'version', version, 'record', envelope",
    integrity: "envelope->>'id' = record_id::text AND (envelope->>'parentId') IS NOT DISTINCT FROM parent_id::text",
  },
  tool: {
    table: 'tool_executions', id: 'history_id', timestamp: "intent->>'occurredAt'",
    document: "intent::text || E'\\n' || coalesce(outcome::text, '')",
    body: "'contextVersion', context_version, 'intent', intent, 'outcome', outcome",
    integrity: "intent->>'callId' = call_id AND intent->>'assistantRecordId' = assistant_record_id::text AND (outcome IS NULL OR outcome->>'callId' = call_id)",
  },
  wake: {
    table: 'wake_runs', id: 'run_id', timestamp: 'claimed_at',
    document: "run_id::text || E'\\n' || claimed_at || E'\\n' || coalesce(input_record_id::text, '') || E'\\n' || coalesce(final_record_id::text, '') || E'\\n' || CASE WHEN completed THEN 'completed' ELSE 'running' END",
    body: `'claimedVersion', claimed_version, 'inputRecordId', input_record_id, 'finalRecordId', final_record_id,
      'status', CASE WHEN completed THEN 'completed' ELSE 'running' END,
      'requests', (SELECT coalesce(json_agg(json_build_object('wakeReceiptId', w.wake_id, 'eventId', e.history_id, 'externalEventId', w.event_id,
        'receiptOrder', w.receipt_order::text) ORDER BY w.receipt_order), '[]'::json)
        FROM wake_run_requests AS r JOIN wake_requests AS w ON w.mira_id = r.mira_id AND w.wake_id = r.wake_id
        JOIN life_events AS e ON e.mira_id = w.mira_id AND e.event_id = w.event_id
        WHERE r.mira_id = s.mira_id AND r.run_id = s.run_id)`,
    integrity: 'true',
  },
};
function originalSql(idParameter = '$2::uuid'): string {
  return kinds.map(sourceKind => {
    const source = sources[sourceKind];
    return `SELECT json_build_object('kind', h.kind, 'id', h.id, 'miraId', h.mira_id,
      'occurredAt', ${source.timestamp}, ${source.body}) AS body,
      (s.${source.id} IS NOT NULL AND (${source.integrity})) AS valid
      FROM history_records AS h LEFT JOIN ${source.table} AS s ON
        s.${source.id} = h.id AND s.mira_id = h.mira_id
      WHERE h.mira_id = $1 AND h.id = ${idParameter} AND h.kind = '${sourceKind}'`;
  }).join('\nUNION ALL\n');
}
/** Fixed management metadata, independent of coalesced membership size. */
const runHeaderBody = `'kind', 'wake', 'id', s.run_id, 'miraId', s.mira_id, 'occurredAt', s.claimed_at,
  'claimedVersion', s.claimed_version, 'inputRecordId', s.input_record_id, 'finalRecordId', s.final_record_id,
  'status', CASE WHEN s.completed THEN 'completed' ELSE 'running' END,
  'requestCount', (SELECT count(*) FROM wake_run_requests members WHERE members.mira_id = s.mira_id AND members.run_id = s.run_id)`;
function validateRunHeader(run: HistoryRunHeader, miraId: string): void {
  try {
    historyId(run.id);
    if (run.kind !== 'wake' || run.miraId !== miraId || !['running', 'completed'].includes(run.status)
      || !Number.isFinite(Date.parse(run.occurredAt))) throw Error();
    integer(run.claimedVersion, 0, Number.MAX_SAFE_INTEGER, 'claimed version');
    integer(run.requestCount, 1, Number.MAX_SAFE_INTEGER, 'request count');
    if (run.inputRecordId !== null) historyId(run.inputRecordId);
    if (run.finalRecordId !== null) historyId(run.finalRecordId);
  } catch { throw new HistoryError('corrupt', 'Invalid run history metadata'); }
}
function invalid(message: string): never { throw new HistoryError('invalid', message); }
function string(value: unknown, name: string, maxBytes?: number): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes)) invalid(`Invalid history ${name}`);
}
function historyId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid('History ID must be a canonical UUID');
}
function integer(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`Invalid history ${name}`);
}
function kind(value: unknown): asserts value is HistoryKind {
  if (!kinds.includes(value as HistoryKind)) invalid('Invalid history kind');
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid history request');
}
function selectedKinds(value: unknown): HistoryKind[] {
  const selected = value ?? kinds;
  if (!Array.isArray(selected) || !selected.length || selected.length > kinds.length || new Set(selected).size !== selected.length) invalid('Invalid history kinds');
  selected.forEach(kind);
  // Filter order has no effect on pagination or cursor scope.
  return kinds.filter(sourceKind => selected.includes(sourceKind));
}
interface PageBoundary { group: number; timestamp: string; rawTimestamp: string; kind: HistoryKind; id: string }
interface PageRow extends HistoryPageHit { cursorGroup: number; cursorTimestamp: string; cursorRawTimestamp: string }
interface PageBody { hits: PageRow[]; hasMore: boolean }
function cursorScope(miraId: string, selected: HistoryKind[]): string {
  return createHash('sha256').update(JSON.stringify([miraId, selected])).digest('hex');
}
function timestampKey(value: unknown): asserts value is string {
  // PostgreSQL epoch seconds retain microsecond precision without depending on
  // timezone formatting or JavaScript's millisecond Date precision.
  if (typeof value !== 'string' || !/^-?\d{1,18}(?:\.\d{1,6})?$/.test(value)) invalid('Invalid history cursor timestamp');
}
function decodeCursor(value: unknown, scope: string, selected: HistoryKind[]): PageBoundary {
  string(value, 'cursor', MAX_CURSOR_BYTES);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalid('Invalid history cursor');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) invalid('Invalid history cursor');
  const json = decoded.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(decoded)) invalid('Invalid history cursor');
  let fields: unknown;
  try { fields = JSON.parse(json); } catch { invalid('Invalid history cursor'); }
  if (!Array.isArray(fields) || fields.length !== 7 || fields[0] !== 1 || fields[1] !== scope) invalid('History cursor does not match this Mira and kinds');
  const [, , group, timestamp, rawTimestamp, sourceKind, id] = fields;
  timestampKey(timestamp); kind(sourceKind); historyId(id);
  if (!id.isWellFormed()) invalid('Invalid history cursor ID');
  if (group !== 0 && group !== 1) invalid('Invalid history cursor timestamp group');
  if (group === 0) {
    string(rawTimestamp, 'cursor original timestamp', 65_536);
    if (timestamp !== '0' || !rawTimestamp.isWellFormed()) invalid('Invalid history cursor original timestamp');
  } else if (rawTimestamp !== '') invalid('Invalid history cursor original timestamp');
  if (!selected.includes(sourceKind)) invalid('History cursor kind is outside the selected kinds');
  return { group, timestamp, rawTimestamp: rawTimestamp as string, kind: sourceKind, id };
}
function encodeCursor(scope: string, boundary: PageBoundary): string {
  const cursor = Buffer.from(JSON.stringify([1, scope, boundary.group, boundary.timestamp, boundary.rawTimestamp, boundary.kind, boundary.id]), 'utf8').toString('base64url');
  if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) throw new HistoryError('too_large', 'History cursor exceeds its bounded size');
  return cursor;
}
interface BoundedRow { bytes: number; body: unknown; valid: boolean }
function bound(sql: string, maxParameter: string): string {
  // Do not transfer an oversized JSON record to the process just to reject it.
  return `WITH response AS MATERIALIZED (${sql}), sized AS MATERIALIZED
    (SELECT body, valid, octet_length(body::text) AS bytes FROM response)
    SELECT bytes, valid, CASE WHEN bytes <= ${maxParameter} THEN body ELSE NULL END AS body FROM sized`;
}
function response<T>(row: BoundedRow | undefined): T | null {
  if (!row) return null;
  if (row.valid !== true) throw new HistoryError('corrupt', 'History source identifiers do not match their original envelopes');
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new HistoryError('corrupt', 'Invalid history response size');
  if (row.body === null) throw new HistoryError('too_large', `History response requires ${row.bytes} bytes; narrow the search or increase the read budget (maximum 1048576)`, row.bytes);
  assertJson(row.body);
  return row.body as T;
}
function validateEntry(entry: HistoryEntry, miraId: string, request: HistoryReadRequest): void {
  try {
    kind(entry.kind); historyId(entry.id);
    if (entry.miraId !== miraId || entry.id !== request.id || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt))) throw Error();
    if (entry.kind === 'context') {
      assertRecord(entry.record);
      if (entry.record.id !== entry.id || entry.record.occurredAt !== entry.occurredAt) throw Error();
      integer(entry.version, 1, Number.MAX_SAFE_INTEGER, 'version');
    } else if (entry.kind === 'event') {
      if (entry.event.occurredAt !== entry.occurredAt || (entry.requestedWake !== null && (!entry.requestedWake.id || !entry.requestedWake.reason))) throw Error();
      string(entry.event.id, 'external event ID'); string(entry.event.type, 'event type');
      if (!['user', 'mira', 'system', 'extension', 'external'].includes(entry.event.source) || !Object.hasOwn(entry.event, 'payload')) throw Error();
    } else if (entry.kind === 'tool') {
      if (entry.intent.occurredAt !== entry.occurredAt || (entry.outcome !== null && entry.outcome.callId !== entry.intent.callId)) throw Error();
      historyId(entry.intent.assistantRecordId); string(entry.intent.callId, 'provider tool call ID'); string(entry.intent.toolName, 'tool name');
      for (const field of ['requestedArguments', 'arguments']) if (!Object.hasOwn(entry.intent, field)) throw Error();
      if (entry.outcome !== null && (!Number.isFinite(Date.parse(entry.outcome.occurredAt)) || !Object.hasOwn(entry.outcome, 'payload'))) throw Error();
      integer(entry.contextVersion, 1, Number.MAX_SAFE_INTEGER, 'version');
    } else {
      integer(entry.claimedVersion, 0, Number.MAX_SAFE_INTEGER, 'version');
      if (!['running', 'completed'].includes(entry.status) || !Array.isArray(entry.requests) || !entry.requests.length) throw Error();
      let previous = 0n;
      for (const request of entry.requests) {
        string(request.wakeReceiptId, 'wake receipt ID'); string(request.externalEventId, 'external event ID'); historyId(request.eventId);
        if (!/^\d+$/.test(request.receiptOrder) || BigInt(request.receiptOrder) <= previous) throw Error();
        previous = BigInt(request.receiptOrder);
      }
    }
  } catch { throw new HistoryError('corrupt', 'History source identifiers or envelope metadata are inconsistent'); }
}

/** Internal adapter constructed by PostgresPersistence.history. One independent
 * read-only transaction per request; it never registers a Mira or takes a lock. */
export class PostgresHistoryReader implements RunHistoryReader {
  readonly miraId: string;
  readonly #options: PostgresOptions;
  constructor(options: PostgresOptions, miraId: string) {
    string(miraId, 'Mira ID'); this.miraId = miraId; this.#options = { ...options };
  }
  async #query(sql: string, parameters: unknown[]): Promise<BoundedRow | undefined> {
    const client = new Client({
      connectionString: this.#options.connectionString,
      application_name: this.#options.applicationName ?? 'mira-history-reader',
      connectionTimeoutMillis: 5_000,
    });
    let failure: Error | undefined;
    let inTransaction = false;
    client.on('error', (error: Error) => { failure = error; });
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      inTransaction = true;
      await client.query(`SET LOCAL search_path TO "${this.#options.schema ?? 'public'}"`);
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const result = await client.query<BoundedRow>(sql, parameters);
      await client.query('COMMIT');
      inTransaction = false;
      if (failure) throw failure;
      return result.rows[0];
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await client.end().catch(() => {}); }
  }
  async findEventRun(externalEventId: string): Promise<HistoryEventRun | null> {
    string(externalEventId, 'external event ID', 65_536);
    return response<HistoryEventRun>(await this.#query(bound(`SELECT
      json_build_object('eventId', e.history_id, 'runId', r.run_id) AS body, true AS valid
      FROM life_events e LEFT JOIN wake_requests w ON w.mira_id = e.mira_id AND w.event_id = e.event_id
      LEFT JOIN wake_run_requests r ON r.mira_id = w.mira_id AND r.wake_id = w.wake_id
      WHERE e.mira_id = $1 AND e.event_id = $2`, '$3'), [this.miraId, externalEventId, MAX_PAGE_BYTES]));
  }
  async pageRuns(request: Pick<HistoryPageRequest, 'before' | 'limit'> = {}): Promise<{ items: HistoryRunHeader[]; nextCursor: string | null }> {
    const page = await this.page({ ...request, kinds: ['wake'] });
    if (!page.hits.length) return { items: [], nextCursor: page.nextCursor };
    // page() carries only immutable reference metadata. Never read the original
    // unbounded Wake envelope to show a fixed-size management summary.
    const sql = `SELECT json_build_object('items', coalesce(json_agg(json_build_object(${runHeaderBody}) ORDER BY ids.n), '[]'::json)) AS body,
      count(s.run_id) = cardinality($2::uuid[]) AS valid
      FROM unnest($2::uuid[]) WITH ORDINALITY ids(id, n)
      JOIN wake_runs s ON s.mira_id = $1 AND s.run_id = ids.id`;
    const result = response<{ items: HistoryRunHeader[] }>(await this.#query(bound(sql, '$3'),
      [this.miraId, page.hits.map(hit => hit.id), MAX_PAGE_BYTES]));
    if (!result) throw new HistoryError('corrupt', 'Missing run metadata page');
    result.items.forEach(run => validateRunHeader(run, this.miraId));
    return { items: result.items, nextCursor: page.nextCursor };
  }
  async readRunRequests(request: HistoryRunPageRequest): Promise<HistoryRunRequestsPage | null> {
    object(request); historyId(request.id);
    const limit = request.limit ?? 50; integer(limit, 1, 100, 'limit');
    const scope = createHash('sha256').update(JSON.stringify([this.miraId, request.id, 'run-requests'])).digest('hex');
    let boundary: string | null = null;
    if (request.before !== undefined) {
      string(request.before, 'run requests cursor', 1024);
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(request.before)) throw Error();
        const bytes = Buffer.from(request.before, 'base64url');
        if (bytes.toString('base64url') !== request.before) throw Error();
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(value) || value.length !== 2 || value[0] !== scope || typeof value[1] !== 'string'
          || !/^[1-9][0-9]{0,18}$/.test(value[1]) || BigInt(value[1]) > 9223372036854775807n) throw Error();
        boundary = value[1];
      } catch { invalid('Invalid run requests cursor'); }
    }
    type Result = { items: Array<HistoryRunRequestsPage['items'][number] & { receiptOrder: string }>; hasMore: boolean };
    // Bound both membership count and each public trigger description, without
    // loading event payloads. Oversized descriptions remain explicit unavailable
    // references; the complete original stays accessible through History.read.
    const description = `json_build_object('source', e.event->>'source', 'type', e.event->>'type', 'reason', w.wake->>'reason')`;
    const sql = `WITH members AS MATERIALIZED (
      SELECT e.history_id AS event_id, w.receipt_order, ${description} AS description
      FROM wake_run_requests r JOIN wake_requests w ON w.mira_id = r.mira_id AND w.wake_id = r.wake_id
      JOIN life_events e ON e.mira_id = w.mira_id AND e.event_id = w.event_id
      WHERE r.mira_id = $1 AND r.run_id = $2::uuid AND ($4::bigint IS NULL OR w.receipt_order < $4::bigint)
      ORDER BY w.receipt_order DESC LIMIT $3 + 1),
      numbered AS (SELECT *, row_number() OVER (ORDER BY receipt_order DESC) AS n FROM members)
      SELECT json_build_object('hasMore', (SELECT count(*) > $3 FROM numbered),
        'items', (SELECT coalesce(json_agg(json_build_object('eventId', event_id, 'receiptOrder', receipt_order::text,
          'source', CASE WHEN octet_length(description::text) <= 2048 THEN description->>'source' ELSE 'unavailable' END,
          'type', CASE WHEN octet_length(description::text) <= 2048 THEN description->>'type' ELSE 'unavailable' END,
          'reason', CASE WHEN octet_length(description::text) <= 2048 THEN description->>'reason' ELSE NULL END)
          ORDER BY n DESC) FILTER (WHERE n <= $3), '[]'::json) FROM numbered)) AS body, true AS valid
      FROM wake_runs s WHERE s.mira_id = $1 AND s.run_id = $2::uuid`;
    const result = response<Result>(await this.#query(bound(sql, '$5'), [this.miraId, request.id, limit, boundary, MAX_PAGE_BYTES]));
    if (!result) return null;
    const oldest = result.items[0];
    return { items: result.items.map(({ eventId, source, type, reason }) => ({ eventId, source, type, reason })),
      nextCursor: result.hasMore && oldest ? Buffer.from(JSON.stringify([scope, oldest.receiptOrder])).toString('base64url') : null };
  }
  async readRun(request: HistoryRunPageRequest): Promise<HistoryRunPage | null> {
    object(request); historyId(request.id);
    const limit = request.limit ?? 50; integer(limit, 1, 100, 'limit');
    // Cursor contains only a scoped version/kind/UUID boundary, never payload.
    const scope = createHash('sha256').update(JSON.stringify([this.miraId, request.id, 'run-records'])).digest('hex');
    let boundary: [number, string, string] | null = null;
    let inclusive = false;
    if (request.before !== undefined) {
      string(request.before, 'run cursor', 1024);
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(request.before)) throw Error();
        const bytes = Buffer.from(request.before, 'base64url');
        if (bytes.toString('base64url') !== request.before) throw Error();
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(value) || (value.length !== 4 && value.length !== 5) || value[0] !== scope || (value.length === 5 && value[4] !== true)) throw Error();
        inclusive = value.length === 5;
        integer(value[1], 1, Number.MAX_SAFE_INTEGER, 'cursor version'); historyId(value[3]);
        if (value[2] !== 'context' && value[2] !== 'tool') throw Error();
        boundary = [value[1], value[2], value[3]];
      } catch { invalid('Invalid run history cursor'); }
    }
    type Result = Omit<HistoryRunPage, 'nextCursor' | 'records'> & { records: Array<HistoryRunPage['records'][number] & { version: number }>; hasMore: boolean };
    // Claimed version excludes the previous Wake; final version closes a
    // completed Wake even after later requests or compaction append new records.
    // All header/checkpoint fields share one read-only snapshot. Trigger
    // membership is independently paginated; it never expands this response.
    const sql = `WITH run AS MATERIALIZED (SELECT s.*, f.version AS final_version FROM wake_runs s
        LEFT JOIN context_records f ON f.mira_id = s.mira_id AND f.record_id = s.final_record_id
        WHERE s.mira_id = $1 AND s.run_id = $2::uuid),
      matching AS (
        SELECT c.record_id AS id, 'context'::text AS kind, c.version, c.envelope->>'occurredAt' AS occurred_at
        FROM context_records c JOIN run r ON r.mira_id = c.mira_id
        WHERE c.version > r.claimed_version AND (r.final_version IS NULL OR c.version <= r.final_version)
        UNION ALL
        SELECT t.history_id, 'tool'::text, t.context_version, t.intent->>'occurredAt'
        FROM tool_executions t JOIN run r ON r.mira_id = t.mira_id
        WHERE t.context_version > r.claimed_version AND (r.final_version IS NULL OR t.context_version <= r.final_version)),
      limited AS MATERIALIZED (SELECT * FROM matching WHERE $4::bigint IS NULL OR
        ((version, kind COLLATE "C", id) < ($4::bigint, $5::text COLLATE "C", $6::uuid) OR
          ($8::boolean AND (version, kind COLLATE "C", id) = ($4::bigint, $5::text COLLATE "C", $6::uuid)))
        ORDER BY version DESC, kind COLLATE "C" DESC, id DESC LIMIT $3 + 1),
      numbered AS (SELECT *, row_number() OVER (ORDER BY version DESC, kind COLLATE "C" DESC, id DESC) AS n FROM limited)
      SELECT json_build_object('run', json_build_object(${runHeaderBody}),
        'memory', CASE WHEN c.run_id IS NULL THEN NULL ELSE json_build_object('preparedAt', c.prepared_at,
          'receipt', CASE WHEN receipt.run_id IS NULL THEN NULL ELSE json_build_object('commit', receipt.commit_id) END) END,
        'hasMore', (SELECT count(*) > $3 FROM numbered),
        'records', (SELECT coalesce(json_agg(json_build_object('id', id, 'kind', kind, 'version', version,
          'occurredAt', occurred_at) ORDER BY n DESC) FILTER (WHERE n <= $3), '[]'::json) FROM numbered)) AS body,
        (s.final_record_id IS NULL OR s.final_version IS NOT NULL) AS valid
      FROM run s LEFT JOIN wake_memory_checkpoints c ON c.mira_id = s.mira_id AND c.run_id = s.run_id
      LEFT JOIN wake_memory_receipts receipt ON receipt.mira_id = s.mira_id AND receipt.run_id = s.run_id`;
    const result = response<Result>(await this.#query(bound(sql, '$7'),
      [this.miraId, request.id, limit, boundary?.[0] ?? null, boundary?.[1] ?? null, boundary?.[2] ?? null, MAX_PAGE_BYTES, inclusive]));
    if (!result) return null;
    validateRunHeader(result.run, this.miraId);
    for (const record of result.records) { historyId(record.id); integer(record.version, 1, Number.MAX_SAFE_INTEGER, 'version'); }
    const oldest = result.records[0];
    const newest = result.records.at(-1);
    // Freeze the exact observed tuple inclusively. A fabricated next-version
    // boundary could admit a later result or sibling intent and shift the page.
    const refreshCursor = request.before ?? (newest ? Buffer.from(JSON.stringify([scope, newest.version, newest.kind, newest.id, true])).toString('base64url') : undefined);
    return { ...(refreshCursor ? { refreshCursor } : {}), run: result.run, memory: result.memory,
      records: result.records.map(({ id, kind, occurredAt }) => ({ id, kind, occurredAt })),
      nextCursor: result.hasMore && oldest ? Buffer.from(JSON.stringify([scope, oldest.version, oldest.kind, oldest.id])).toString('base64url') : null };
  }
  async search(request: HistorySearchRequest): Promise<HistorySearchResult> {
    object(request); string(request.query, 'query', 1024);
    if (!request.query.trim()) invalid('History query must contain non-whitespace text');
    const mode = request.mode ?? 'full_text';
    if (mode !== 'full_text' && mode !== 'substring') invalid('Invalid history search mode');
    const limit = request.limit ?? 20; integer(limit, 1, 100, 'limit');
    const selected = selectedKinds(request.kinds);
    const matches = selected.map(sourceKind => {
      const source = sources[sourceKind];
      const vector = `to_tsvector('simple'::regconfig, left(${source.document}, ${FULL_TEXT_PREFIX_CHARS}))`;
      const query = "plainto_tsquery('simple'::regconfig, $2)";
      const predicate = mode === 'full_text' ? `${vector} @@ ${query}` : `strpos(lower(${source.document}), lower($2)) > 0`;
      const rank = mode === 'full_text' ? `ts_rank(${vector}, ${query})` : 'NULL::real';
      return `SELECT '${sourceKind}'::text AS kind, ${source.id}::text AS id, ${source.timestamp} AS occurred_at,
        ${source.document} AS document, ${rank} AS rank FROM ${source.table} WHERE mira_id = $1 AND ${predicate}`;
    }).join('\nUNION ALL\n');
    const snippet = mode === 'full_text'
      ? `left(ts_headline('simple'::regconfig, left(document, ${FULL_TEXT_PREFIX_CHARS}), plainto_tsquery('simple'::regconfig, $2),
        'MaxWords=32,MinWords=10,MaxFragments=1,StartSel=[,StopSel=]'), 512)`
      : 'substring(document FROM greatest(1, strpos(lower(document), lower($2)) - 80) FOR 512)';
    const sql = `WITH matches AS (${matches}), limited AS MATERIALIZED
      (SELECT * FROM matches ORDER BY rank DESC NULLS LAST, kind COLLATE "C", id COLLATE "C" LIMIT $3 + 1),
      numbered AS (SELECT *, row_number() OVER (ORDER BY rank DESC NULLS LAST, kind COLLATE "C", id COLLATE "C") AS n FROM limited)
      SELECT json_build_object('query', $2::text, 'mode', $4::text, 'fullTextPrefixChars', $5::integer,
        'hasMore', count(*) > $3, 'hits', coalesce(json_agg(json_build_object('kind', kind, 'id', id,
          'miraId', $1::text, 'occurredAt', occurred_at, 'snippet', ${snippet}, 'rank', rank)
          ORDER BY n) FILTER (WHERE n <= $3), '[]'::json)) AS body, true AS valid FROM numbered`;
    const result = response<HistorySearchResult>(await this.#query(bound(sql, '$6'),
      [this.miraId, request.query, limit, mode, mode === 'full_text' ? FULL_TEXT_PREFIX_CHARS : null, MAX_SEARCH_BYTES]));
    if (!result) throw new HistoryError('corrupt', 'History search returned no response');
    return result;
  }
  async page(request: HistoryPageRequest = {}): Promise<HistoryPageResult> {
    object(request);
    const limit = request.limit ?? 20; integer(limit, 1, 100, 'limit');
    const selected = selectedKinds(request.kinds);
    const scope = cursorScope(this.miraId, selected);
    const boundary = request.before === undefined ? null : decodeCursor(request.before, scope, selected);
    const matches = selected.map(sourceKind => {
      const source = sources[sourceKind];
      // Project only immutable reference metadata. Even a multi-megabyte private
      // system/runtime payload must not consume the history page's byte budget.
      const normalizable = `pg_input_is_valid(${source.timestamp}, 'timestamp with time zone')`;
      return `SELECT '${sourceKind}'::text AS kind, ${source.id}::text AS id, ${source.timestamp} AS occurred_at,
        CASE WHEN ${normalizable} THEN 1 ELSE 0 END AS time_group,
        CASE WHEN ${normalizable} THEN extract(epoch FROM (${source.timestamp})::timestamptz) ELSE 0 END AS occurred_time,
        CASE WHEN ${normalizable} THEN '' ELSE ${source.timestamp} END AS raw_timestamp,
        (${source.integrity}) AS valid FROM ${source.table} AS s WHERE mira_id = $1`;
    }).join('\nUNION ALL\n');
    const order = 'time_group DESC, occurred_time DESC, raw_timestamp COLLATE "C" DESC, kind COLLATE "C" DESC, id COLLATE "C" DESC';
    const sql = `WITH matches AS (${matches}), limited AS MATERIALIZED
      (SELECT * FROM matches WHERE $3::integer IS NULL OR
        (time_group, occurred_time, raw_timestamp COLLATE "C", kind COLLATE "C", id COLLATE "C") <
        ($3::integer, $4::numeric, $5::text COLLATE "C", $6::text COLLATE "C", $7::text COLLATE "C")
        ORDER BY ${order} LIMIT $2 + 1),
      numbered AS (SELECT *, row_number() OVER (ORDER BY ${order}) AS n FROM limited)
      SELECT json_build_object('hasMore', count(*) > $2,
        'hits', coalesce(json_agg(json_build_object('kind', kind, 'id', id, 'miraId', $1::text,
          'occurredAt', occurred_at, 'cursorGroup', time_group, 'cursorTimestamp', occurred_time::text, 'cursorRawTimestamp', raw_timestamp)
          ORDER BY n DESC) FILTER (WHERE n <= $2), '[]'::json)) AS body,
        coalesce(bool_and(valid IS TRUE), true) AS valid FROM numbered`;
    const result = response<PageBody>(await this.#query(bound(sql, '$8'),
      [this.miraId, limit, boundary?.group ?? null, boundary?.timestamp ?? null, boundary?.rawTimestamp ?? null, boundary?.kind ?? null, boundary?.id ?? null, MAX_PAGE_BYTES]));
    if (!result) throw new HistoryError('corrupt', 'History page returned no response');
    try {
      if (!Array.isArray(result.hits) || result.hits.length > limit || typeof result.hasMore !== 'boolean' || (result.hasMore && result.hits.length !== limit)) throw Error();
      for (const hit of result.hits) {
        kind(hit.kind); string(hit.id, 'ID', 65_536); timestampKey(hit.cursorTimestamp);
        if (hit.cursorGroup !== 0 && hit.cursorGroup !== 1) throw Error();
        if (hit.cursorGroup === 0) {
          string(hit.cursorRawTimestamp, 'original timestamp', 65_536);
          if (hit.cursorTimestamp !== '0' || hit.cursorRawTimestamp !== hit.occurredAt) throw Error();
        } else if (hit.cursorRawTimestamp !== '') throw Error();
        if (!selected.includes(hit.kind) || hit.miraId !== this.miraId || typeof hit.occurredAt !== 'string' || !Number.isFinite(Date.parse(hit.occurredAt))) throw Error();
      }
    } catch { throw new HistoryError('corrupt', 'Invalid history page metadata'); }
    const oldest = result.hits[0];
    return {
      hits: result.hits.map(({ kind, id, miraId, occurredAt, cursorGroup }) => ({ kind, id, miraId, occurredAt,
        ...(cursorGroup === 0 ? { timestampWarning: 'timestamp_not_normalized' as const } : {}) })),
      nextCursor: result.hasMore && oldest ? encodeCursor(scope, { group: oldest.cursorGroup, timestamp: oldest.cursorTimestamp, rawTimestamp: oldest.cursorRawTimestamp, kind: oldest.kind, id: oldest.id }) : null,
    };
  }
  async read(request: HistoryReadRequest): Promise<HistoryEntry | null> {
    object(request); historyId(request.id);
    if (Object.keys(request).some(key => key !== 'id' && key !== 'maxBytes')) invalid('History read accepts only id and maxBytes');
    const maxBytes = request.maxBytes ?? 65_536; integer(maxBytes, 1, 1_048_576, 'read budget');
    // The registry owns kind selection. A single read-only statement sees the
    // identity and its original detail in one database snapshot.
    const entry = response<HistoryEntry>(await this.#query(bound(originalSql(), '$3'), [this.miraId, request.id, maxBytes]));
    if (entry) validateEntry(entry, this.miraId, request);
    return entry;
  }
  async readBatch(request: { ids: string[]; maxBytes?: number }): Promise<Array<{ id: string; entry: HistoryEntry | null; tooLarge: boolean }>> {
    object(request);
    if (Object.keys(request).some(key => key !== 'ids' && key !== 'maxBytes') || !Array.isArray(request.ids) || request.ids.length > 10) invalid('Invalid history batch');
    request.ids.forEach(historyId);
    const maxBytes = request.maxBytes ?? 65_536; integer(maxBytes, 1, 1_048_576, 'read budget');
    if (!request.ids.length) return [];
    // Each original is bounded inside SQL, before transfer. The lateral lookup
    // retains read's registry/type/integrity checks and current-Mira scope.
    const sql = `SELECT json_build_object('items', json_agg(json_build_object('id', ids.id,
        'entry', CASE WHEN octet_length(original.body::text) <= $3 THEN original.body ELSE NULL END,
        'tooLarge', coalesce(octet_length(original.body::text) > $3, false)) ORDER BY ids.n)) AS body,
        bool_and(CASE WHEN original.body IS NULL THEN true ELSE original.valid IS TRUE END) AS valid
      FROM unnest($2::uuid[]) WITH ORDINALITY ids(id, n)
      LEFT JOIN LATERAL (${originalSql('ids.id')}) original ON true`;
    const result = response<{ items: Array<{ id: string; entry: HistoryEntry | null; tooLarge: boolean }> }>(await this.#query(bound(sql, '$4'),
      [this.miraId, request.ids, maxBytes, request.ids.length * (maxBytes + 1024)]));
    if (!result || !Array.isArray(result.items) || result.items.length !== request.ids.length) throw new HistoryError('corrupt', 'Invalid history batch response');
    for (const [index, item] of result.items.entries()) {
      if (item.id !== request.ids[index] || typeof item.tooLarge !== 'boolean' || (item.tooLarge && item.entry !== null)) throw new HistoryError('corrupt', 'Invalid history batch entry');
      if (item.entry) validateEntry(item.entry, this.miraId, { id: item.id, maxBytes });
    }
    return result.items;
  }
  async readText(request: HistoryTextRequest): Promise<HistoryTextPage | null> {
    object(request); historyId(request.id);
    if (Object.keys(request).some(key => !['id', 'offset', 'maxBytes', 'revision'].includes(key))) invalid('History text read accepts only id, offset, maxBytes and revision');
    integer(request.offset, 0, 2_147_483_646, 'text offset');
    const maxBytes = request.maxBytes ?? 4096; integer(maxBytes, 4, 65_536, 'text budget');
    if ((request.offset > 0 || request.revision !== undefined) && (typeof request.revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.revision))) invalid('History text continuation requires its first-page revision');
    // PostgreSQL substring counts code points. maxBytes / 4 guarantees a UTF-8
    // bound without splitting one. Only the page crosses the connection.
    const sql = `WITH original AS MATERIALIZED (${originalSql()}), serialized AS MATERIALIZED (
      SELECT body, valid, body::text AS text FROM original
    ), page AS MATERIALIZED (
      SELECT *, substring(text FROM $3::integer + 1 FOR $4::integer) AS part,
        char_length(text) AS chars, octet_length(text) AS bytes,
        encode(sha256(convert_to(text, 'UTF8')), 'hex') AS revision FROM serialized
    ) SELECT json_build_object('kind', body->>'kind', 'id', body->>'id', 'format', 'json-text', 'text', part, 'offset', $3::integer,
      'nextOffset', CASE WHEN $3::integer + char_length(part) < chars THEN $3::integer + char_length(part) ELSE NULL END,
      'totalChars', chars, 'totalBytes', bytes, 'revision', revision) AS body, valid FROM page`;
    const page = response<HistoryTextPage>(await this.#query(bound(sql, '$5'), [this.miraId, request.id, request.offset, Math.floor(maxBytes / 4), 6 * maxBytes + 2048]));
    if (!page) return null;
    try {
      kind(page.kind); historyId(page.id);
      if (Object.keys(page).sort().join(',') !== 'format,id,kind,nextOffset,offset,revision,text,totalBytes,totalChars' || page.id !== request.id
        || page.format !== 'json-text' || page.offset !== request.offset || typeof page.text !== 'string' || !page.text.isWellFormed()
        || Buffer.byteLength(page.text) > maxBytes || !/^[a-f0-9]{64}$/.test(page.revision)) throw Error();
      integer(page.totalChars, 0, 2_147_483_646, 'total text length'); integer(page.totalBytes, page.totalChars, Number.MAX_SAFE_INTEGER, 'total text bytes');
      const end = page.offset + [...page.text].length;
      if (page.offset <= page.totalChars && (end > page.totalChars || (end < page.totalChars && !page.text.length))) throw Error();
      if (page.nextOffset !== (end < page.totalChars ? end : null)) throw Error();
    } catch { throw new HistoryError('corrupt', 'Invalid bounded History text page'); }
    if (request.offset > page.totalChars) invalid('History text offset is beyond the end of the original');
    if (request.revision !== undefined && page.revision !== request.revision) invalid('History original changed; restart history_read with offset=0');
    return page;
  }
}
