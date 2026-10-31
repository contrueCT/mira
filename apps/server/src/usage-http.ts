import type { FastifyInstance } from 'fastify';
import type { UsageCounts, UsageRange, UsageReport } from '@mira/life';
import { WebHttpError } from './http.ts';

/** Read-only model usage (ADR 0048): tokens and request counts only, never cost. */
export interface UsageBackend { usage(range: UsageRange, timeZone: string): Promise<UsageReport> }
const ranges: readonly UsageRange[] = ['today', '7d', '30d'];
/** IANA names only; Intl is the validator, so the browser and server agree. */
export function validTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/u.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
const counts = (value: UsageCounts): UsageCounts => ({ requests: value.requests, failedRequests: value.failedRequests, input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, total: value.total });
/** Re-project so storage or adapter fields never reach the browser. */
export const usageView = (report: UsageReport): UsageReport => ({
  range: report.range, timeZone: report.timeZone, generatedAt: report.generatedAt, since: report.since,
  totals: counts(report.totals), previous: counts(report.previous),
  days: report.days.map(day => ({ date: day.date, ...counts(day) })),
  bySource: report.bySource.map(item => ({ source: item.source, tasks: item.tasks, ...counts(item) })),
  topWakes: report.topWakes.map(item => ({ runId: item.runId, claimedAt: item.claimedAt, trigger: item.trigger ? { source: item.trigger.source, type: item.trigger.type } : null, preview: item.preview, ...counts(item) })),
  byModel: report.byModel.map(item => ({ provider: item.provider, model: item.model, ...counts(item) })),
});
export function registerUsageHttp(app: FastifyInstance, backend: Partial<UsageBackend>): void {
  app.get<{ Querystring: { range?: string; tz?: string } }>('/api/usage', { schema: { querystring: {
    type: 'object', additionalProperties: false, required: ['range', 'tz'],
    properties: { range: { enum: [...ranges] }, tz: { type: 'string', minLength: 1, maxLength: 64 } },
  } } }, async request => {
    if (!backend.usage) throw new WebHttpError('unavailable');
    const { range, tz } = request.query as { range: UsageRange; tz: string };
    if (!validTimeZone(tz)) throw new WebHttpError('invalid_input');
    return usageView(await backend.usage(range, tz));
  });
}
