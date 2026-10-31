import { Client } from 'pg';
import type { UsageCounts, UsageProjection, UsageReader, UsageReport, UsageRequest } from '@mira/life';
import type { PostgresOptions } from './index.ts';

const ranges = { today: 1, '7d': 7, '30d': 30 } as const;
const path = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(part => typeof part === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(part));
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(value);
function validateProjection(projection: UsageProjection): void {
  const { message, checkpoint, fields } = projection ?? {} as UsageProjection;
  if (!message || !checkpoint || !fields || !key(message.kind) || !key(checkpoint.kind) || !key(message.roleValue)
    || ![message.role, message.usage, message.provider, message.model, message.stopReason, checkpoint.usage].every(path)
    || !Array.isArray(message.failedStopReasons) || !message.failedStopReasons.every(key) || ![fields.input, fields.output, fields.cacheRead, fields.cacheWrite].every(key))
    throw new Error('Invalid usage projection');
}
/** One aggregate JSON object. `f` is an SQL boolean filter over `items`. */
function counts(f: string): string {
  return `json_build_object('requests', count(*) FILTER (WHERE ${f}), 'failedRequests', count(*) FILTER (WHERE ${f} AND failed),
    'input', coalesce(sum(inp) FILTER (WHERE ${f}), 0), 'output', coalesce(sum(outp) FILTER (WHERE ${f}), 0),
    'cacheRead', coalesce(sum(cr) FILTER (WHERE ${f}), 0), 'cacheWrite', coalesce(sum(cw) FILTER (WHERE ${f}), 0),
    'total', coalesce(sum(inp + outp + cr + cw) FILTER (WHERE ${f}), 0))`;
}
const usageNumber = (alias: string) => `CASE WHEN jsonb_typeof(u->${alias}::text) = 'number' THEN (u->>${alias}::text)::numeric ELSE 0 END`;
/* Parameters: $1 life, $2 time zone, $3 range days, $4 chart days, $5..$10 message paths,
 * $10 failed stop reasons, $11 checkpoint usage path, $12..$15 usage keys, $16 message kind,
 * $17 checkpoint kind, $18 role value. Records before `earliest` are skipped through the
 * (mira_id, occurredAt) expression index; ISO instants from Pi compare as text. */
const SQL = `WITH b AS (
    SELECT date_trunc('day', now() AT TIME ZONE $2::text) AS today),
  bounds AS (
    SELECT (today - make_interval(days => $3::int - 1)) AT TIME ZONE $2::text AS since,
      (today - make_interval(days => 2 * $3::int - 1)) AT TIME ZONE $2::text AS previous,
      (today - make_interval(days => $4::int - 1)) AT TIME ZONE $2::text AS chart, today FROM b),
  earliest AS (SELECT to_char(least(previous, chart) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM bounds),
  streams AS (
    SELECT $1::text AS stream, false AS child UNION ALL
    SELECT stream_id, true FROM subagents WHERE parent_mira_id = $1),
  raw AS (
    SELECT s.child, s.stream, c.version, c.envelope::jsonb AS e
    FROM streams s JOIN context_records c ON c.mira_id = s.stream, earliest
    WHERE (c.envelope->>'occurredAt') >= earliest.at AND (c.envelope->>'kind') IN ($16::text, $17::text)),
  picked AS (
    SELECT child, stream, version, (e->>'occurredAt')::timestamptz AS at, (e->>'kind') = $17 AS checkpoint,
      CASE WHEN (e->>'kind') = $17 THEN e #> $11::text[] ELSE e #> $6::text[] END AS u,
      CASE WHEN (e->>'kind') = $16 THEN e #>> $7::text[] END AS provider,
      CASE WHEN (e->>'kind') = $16 THEN e #>> $8::text[] END AS model,
      (e->>'kind') = $16 AND (e #>> $9::text[]) = ANY($10::text[]) AS failed
    FROM raw WHERE ((e->>'kind') = $17 AND e #> $11::text[] IS NOT NULL) OR ((e->>'kind') = $16 AND (e #>> $5::text[]) = $18::text)),
  items AS (
    SELECT p.*, ${usageNumber('$12')} AS inp, ${usageNumber('$13')} AS outp, ${usageNumber('$14')} AS cr, ${usageNumber('$15')} AS cw,
      r.run_id, r.claimed_at, (r.run_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM wake_run_requests rr JOIN wake_requests wr ON wr.mira_id = rr.mira_id AND wr.wake_id = rr.wake_id
        JOIN life_events le ON le.mira_id = wr.mira_id AND le.event_id = wr.event_id
        WHERE rr.mira_id = $1 AND rr.run_id = r.run_id AND le.event->>'type' = 'memory.dreaming' AND le.event->>'source' = 'system')) AS dreaming,
      (p.at AT TIME ZONE $2::text)::date AS day
    FROM picked p LEFT JOIN LATERAL (
      SELECT w.run_id, w.claimed_at FROM wake_runs w WHERE NOT p.child AND w.mira_id = $1 AND w.claimed_version < p.version
      ORDER BY w.claimed_version DESC LIMIT 1) r ON true),
  classified AS (
    SELECT i.*, CASE WHEN child THEN 'subagent' WHEN checkpoint THEN 'compaction' WHEN dreaming THEN 'dreaming' ELSE 'main' END AS source,
      at >= (SELECT since FROM bounds) AS in_range, at >= (SELECT previous FROM bounds) AND at < (SELECT since FROM bounds) AS in_previous,
      at >= (SELECT chart FROM bounds) AS in_chart FROM items i),
  wakes AS (
    SELECT run_id, min(claimed_at) AS claimed_at, ${counts('true')} AS c, sum(inp + outp + cr + cw) AS total
    FROM classified WHERE in_range AND NOT child AND run_id IS NOT NULL GROUP BY run_id ORDER BY total DESC, run_id LIMIT 5),
  models AS (
    SELECT provider, model, ${counts('true')} AS c, sum(inp + outp + cr + cw) AS total
    FROM classified WHERE in_range AND provider IS NOT NULL AND model IS NOT NULL GROUP BY provider, model ORDER BY total DESC, provider, model LIMIT 10)
  SELECT json_build_object(
    'since', (SELECT to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM bounds),
    'totals', (SELECT ${counts('in_range')} FROM classified),
    'previous', (SELECT ${counts('in_previous')} FROM classified),
    'days', (SELECT json_agg(json_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'counts', (SELECT ${counts('day = d.day')} FROM classified WHERE in_chart)) ORDER BY d.day)
      FROM (SELECT generate_series((SELECT today FROM bounds) - make_interval(days => $4::int - 1), (SELECT today FROM bounds), interval '1 day')::date AS day) d),
    'bySource', (SELECT json_agg(json_build_object('source', s.source, 'tasks', (SELECT count(DISTINCT stream) FROM classified WHERE in_range AND child AND s.source = 'subagent'),
        'counts', (SELECT ${counts(`in_range AND source = s.source`)} FROM classified)) ORDER BY s.n)
      FROM (VALUES ('main', 1), ('subagent', 2), ('compaction', 3), ('dreaming', 4)) AS s(source, n)),
    'topWakes', (SELECT coalesce(json_agg(json_build_object('runId', w.run_id, 'claimedAt', w.claimed_at, 'counts', w.c,
        'trigger', (SELECT json_build_object('source', le.event->>'source', 'type', le.event->>'type',
            'preview', CASE WHEN json_typeof(le.event->'payload'->'text') = 'string' THEN left(le.event->'payload'->>'text', 80) END)
          FROM wake_run_requests rr JOIN wake_requests wr ON wr.mira_id = rr.mira_id AND wr.wake_id = rr.wake_id
          JOIN life_events le ON le.mira_id = wr.mira_id AND le.event_id = wr.event_id
          WHERE rr.mira_id = $1 AND rr.run_id = w.run_id ORDER BY wr.receipt_order LIMIT 1)) ORDER BY w.total DESC, w.run_id), '[]'::json) FROM wakes w),
    'byModel', (SELECT coalesce(json_agg(json_build_object('provider', m.provider, 'model', m.model, 'counts', m.c) ORDER BY m.total DESC, m.provider, m.model), '[]'::json) FROM models m)
  ) AS body`;

interface RawCounts { requests: number | string; failedRequests: number | string; input: number | string; output: number | string; cacheRead: number | string; cacheWrite: number | string; total: number | string }
function number(value: unknown): number {
  const result = typeof value === 'string' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) throw new Error('Invalid usage aggregate');
  return result;
}
function toCounts(value: RawCounts): UsageCounts {
  return { requests: number(value.requests), failedRequests: number(value.failedRequests), input: number(value.input), output: number(value.output),
    cacheRead: number(value.cacheRead), cacheWrite: number(value.cacheWrite), total: number(value.total) };
}
const bounded = (value: unknown, limit: number): string | null => typeof value === 'string' ? Array.from(value).slice(0, limit).join('') : null;

/** Read-only usage aggregation over the active life's main and child streams. */
export class PostgresUsageReader implements UsageReader {
  readonly #options: PostgresOptions;
  readonly #miraId: string;
  constructor(options: PostgresOptions, miraId: string) { this.#options = { ...options }; this.#miraId = miraId; }
  async usage(request: UsageRequest, projection: UsageProjection): Promise<UsageReport> {
    if (!request || !Object.hasOwn(ranges, request.range) || typeof request.timeZone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/u.test(request.timeZone)) throw new Error('Invalid usage request');
    validateProjection(projection);
    const days = ranges[request.range]; const chart = Math.max(7, days);
    const { message: m, checkpoint: c, fields: f } = projection;
    const client = new Client({ connectionString: this.#options.connectionString, connectionTimeoutMillis: 5_000, application_name: 'mira-usage-reader' });
    let failure: Error | undefined;
    client.on('error', (error: Error) => { failure = error; });
    try {
      await client.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL search_path TO "${this.#options.schema ?? 'public'}"`);
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const result = await client.query<{ body: Record<string, unknown> }>(SQL, [this.#miraId, request.timeZone, days, chart,
        m.role, m.usage, m.provider, m.model, m.stopReason, m.failedStopReasons, c.usage, f.input, f.output, f.cacheRead, f.cacheWrite, m.kind, c.kind, m.roleValue]);
      await client.query('COMMIT');
      if (failure) throw failure;
      const body = result.rows[0]?.body as { since: string; totals: RawCounts; previous: RawCounts; days: Array<{ date: string; counts: RawCounts }>;
        bySource: Array<{ source: UsageReport['bySource'][number]['source']; tasks: number; counts: RawCounts }>;
        topWakes: Array<{ runId: string; claimedAt: string; counts: RawCounts; trigger: { source: unknown; type: unknown; preview: unknown } | null }>;
        byModel: Array<{ provider: string; model: string; counts: RawCounts }> } | undefined;
      if (!body || typeof body.since !== 'string' || !Array.isArray(body.days) || !Array.isArray(body.bySource) || !Array.isArray(body.topWakes) || !Array.isArray(body.byModel)) throw new Error('Invalid usage aggregate');
      return {
        range: request.range, timeZone: request.timeZone, generatedAt: new Date().toISOString(), since: body.since,
        totals: toCounts(body.totals), previous: toCounts(body.previous),
        days: body.days.map(day => ({ date: String(day.date), ...toCounts(day.counts) })),
        bySource: body.bySource.map(item => ({ source: item.source, tasks: number(item.tasks), ...toCounts(item.counts) })),
        topWakes: body.topWakes.map(item => ({ runId: String(item.runId), claimedAt: String(item.claimedAt), ...toCounts(item.counts),
          trigger: item.trigger ? { source: bounded(item.trigger.source, 32) ?? 'unknown', type: bounded(item.trigger.type, 64) ?? 'unknown' } : null,
          preview: item.trigger ? bounded(item.trigger.preview, 80) : null })),
        byModel: body.byModel.map(item => ({ provider: bounded(item.provider, 128) ?? '', model: bounded(item.model, 256) ?? '', ...toCounts(item.counts) })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await client.end().catch(() => {}); }
  }
}
