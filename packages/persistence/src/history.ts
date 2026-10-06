import { Client } from 'pg';
import { assertJson, assertRecord } from '@mira/context';
import { HistoryError } from '@mira/life';
import type { HistoryEntry, HistoryKind, HistoryReader, HistoryReadRequest, HistorySearchRequest, HistorySearchResult } from '@mira/life';
import type { PostgresOptions } from './index.ts';

const FULL_TEXT_PREFIX_CHARS = 65_536;
const MAX_SEARCH_BYTES = 262_144;
const kinds: HistoryKind[] = ['event', 'context', 'tool', 'wake'];
interface Source { table: string; id: string; timestamp: string; document: string; body: string; integrity: string }
/** Runtime payloads are opaque JSON. The same bounded expression appears in
 * migration 0003; it must not make large original records impossible to write. */
const sources: Record<HistoryKind, Source> = {
  event: {
    table: 'life_events', id: 'event_id', timestamp: "event->>'occurredAt'",
    document: "event::text || E'\\n' || coalesce(requested_wake::text, '')",
    body: "'event', event, 'requestedWake', requested_wake",
    integrity: "event->>'id' = event_id",
  },
  context: {
    table: 'context_records', id: 'record_id', timestamp: "envelope->>'occurredAt'", document: 'envelope::text',
    body: "'version', version, 'record', envelope",
    integrity: "envelope->>'id' = record_id AND (envelope->>'parentId') IS NOT DISTINCT FROM parent_id",
  },
  tool: {
    table: 'tool_executions', id: 'call_id', timestamp: "intent->>'occurredAt'",
    document: "intent::text || E'\\n' || coalesce(outcome::text, '')",
    body: "'contextVersion', context_version, 'intent', intent, 'outcome', outcome",
    integrity: "intent->>'callId' = call_id AND intent->>'assistantRecordId' = assistant_record_id AND (outcome IS NULL OR outcome->>'callId' = call_id)",
  },
  wake: {
    table: 'wake_runs', id: 'run_id', timestamp: 'claimed_at',
    document: "run_id || E'\\n' || claimed_at || E'\\n' || coalesce(input_record_id, '') || E'\\n' || coalesce(final_record_id, '') || E'\\n' || CASE WHEN completed THEN 'completed' ELSE 'running' END",
    body: `'claimedVersion', claimed_version, 'inputRecordId', input_record_id, 'finalRecordId', final_record_id,
      'status', CASE WHEN completed THEN 'completed' ELSE 'running' END,
      'requests', (SELECT coalesce(json_agg(json_build_object('wakeId', w.wake_id, 'eventId', w.event_id,
        'receiptOrder', w.receipt_order::text) ORDER BY w.receipt_order), '[]'::json)
        FROM wake_run_requests AS r JOIN wake_requests AS w ON w.mira_id = r.mira_id AND w.wake_id = r.wake_id
        WHERE r.mira_id = s.mira_id AND r.run_id = s.run_id)`,
    integrity: 'true',
  },
};
function invalid(message: string): never { throw new HistoryError('invalid', message); }
function string(value: unknown, name: string, maxBytes?: number): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes)) invalid(`Invalid history ${name}`);
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
    if (entry.miraId !== miraId || entry.kind !== request.kind || entry.id !== request.id || typeof entry.occurredAt !== 'string' || !Number.isFinite(Date.parse(entry.occurredAt))) throw Error();
    if (entry.kind === 'context') {
      assertRecord(entry.record);
      if (entry.record.id !== entry.id || entry.record.occurredAt !== entry.occurredAt) throw Error();
      integer(entry.version, 1, Number.MAX_SAFE_INTEGER, 'version');
    } else if (entry.kind === 'event') {
      if (entry.event.id !== entry.id || entry.event.occurredAt !== entry.occurredAt || (entry.requestedWake !== null && (!entry.requestedWake.id || !entry.requestedWake.reason))) throw Error();
      string(entry.event.type, 'event type');
      if (!['user', 'mira', 'system', 'extension', 'external'].includes(entry.event.source) || !Object.hasOwn(entry.event, 'payload')) throw Error();
    } else if (entry.kind === 'tool') {
      if (entry.intent.callId !== entry.id || entry.intent.occurredAt !== entry.occurredAt || (entry.outcome !== null && entry.outcome.callId !== entry.id)) throw Error();
      string(entry.intent.assistantRecordId, 'assistant record ID'); string(entry.intent.toolName, 'tool name');
      for (const field of ['requestedArguments', 'arguments']) if (!Object.hasOwn(entry.intent, field)) throw Error();
      if (entry.outcome !== null && (!Number.isFinite(Date.parse(entry.outcome.occurredAt)) || !Object.hasOwn(entry.outcome, 'payload'))) throw Error();
      integer(entry.contextVersion, 1, Number.MAX_SAFE_INTEGER, 'version');
    } else {
      integer(entry.claimedVersion, 0, Number.MAX_SAFE_INTEGER, 'version');
      if (!['running', 'completed'].includes(entry.status) || !Array.isArray(entry.requests) || !entry.requests.length) throw Error();
      let previous = 0n;
      for (const request of entry.requests) {
        string(request.wakeId, 'wake ID'); string(request.eventId, 'event ID');
        if (!/^\d+$/.test(request.receiptOrder) || BigInt(request.receiptOrder) <= previous) throw Error();
        previous = BigInt(request.receiptOrder);
      }
    }
  } catch { throw new HistoryError('corrupt', 'History source identifiers or envelope metadata are inconsistent'); }
}

/** Internal adapter constructed by PostgresPersistence.history. One independent
 * read-only transaction per request; it never registers a Mira or takes a lock. */
export class PostgresHistoryReader implements HistoryReader {
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
  async search(request: HistorySearchRequest): Promise<HistorySearchResult> {
    object(request); string(request.query, 'query', 1024);
    if (!request.query.trim()) invalid('History query must contain non-whitespace text');
    const mode = request.mode ?? 'full_text';
    if (mode !== 'full_text' && mode !== 'substring') invalid('Invalid history search mode');
    const limit = request.limit ?? 20; integer(limit, 1, 100, 'limit');
    const selected = request.kinds ?? kinds;
    if (!Array.isArray(selected) || !selected.length || selected.length > kinds.length || new Set(selected).size !== selected.length) invalid('Invalid history kinds');
    selected.forEach(kind);
    const matches = selected.map(sourceKind => {
      const source = sources[sourceKind];
      const vector = `to_tsvector('simple'::regconfig, left(${source.document}, ${FULL_TEXT_PREFIX_CHARS}))`;
      const query = "plainto_tsquery('simple'::regconfig, $2)";
      const predicate = mode === 'full_text' ? `${vector} @@ ${query}` : `strpos(lower(${source.document}), lower($2)) > 0`;
      const rank = mode === 'full_text' ? `ts_rank(${vector}, ${query})` : 'NULL::real';
      return `SELECT '${sourceKind}'::text AS kind, ${source.id} AS id, ${source.timestamp} AS occurred_at,
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
  async read(request: HistoryReadRequest): Promise<HistoryEntry | null> {
    object(request); kind(request.kind); string(request.id, 'ID', 65_536);
    const maxBytes = request.maxBytes ?? 65_536; integer(maxBytes, 1, 1_048_576, 'read budget');
    const source = sources[request.kind];
    const sql = `SELECT json_build_object('kind', '${request.kind}', 'id', ${source.id}, 'miraId', mira_id,
      'occurredAt', ${source.timestamp}, ${source.body}) AS body, (${source.integrity}) AS valid FROM ${source.table} AS s WHERE mira_id = $1 AND ${source.id} = $2`;
    const entry = response<HistoryEntry>(await this.#query(bound(sql, '$3'), [this.miraId, request.id, maxBytes]));
    if (entry) validateEntry(entry, this.miraId, request);
    return entry;
  }
}
