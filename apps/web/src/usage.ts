/** Read DTO for GET /api/usage (ADR 0048): tokens and request counts, never cost. */
export type UsageRange = 'today' | '7d' | '30d';
export interface UsageCounts { requests: number; failedRequests: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
export interface UsageReport {
  range: UsageRange; timeZone: string; generatedAt: string; since: string;
  totals: UsageCounts; previous: UsageCounts;
  days: Array<{ date: string } & UsageCounts>;
  bySource: Array<{ source: 'main' | 'subagent' | 'compaction' | 'dreaming'; tasks: number } & UsageCounts>;
  topWakes: Array<{ runId: string; claimedAt: string; trigger: { source: string; type: string } | null; preview: string | null } & UsageCounts>;
  byModel: Array<{ provider: string; model: string } & UsageCounts>;
}
export const usageRanges: Array<{ id: UsageRange; label: string; previous: string }> = [
  { id: 'today', label: '今天', previous: '昨天' }, { id: '7d', label: '最近 7 天', previous: '前 7 天' }, { id: '30d', label: '最近 30 天', previous: '前 30 天' },
];
/** Browser time zone, falling back to UTC when Intl has none. */
export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
/** 1234 → 1,234; 12345 → 12.3K; 1960000 → 1.96M. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 10_000) return Math.round(value).toLocaleString('en-US');
  const [unit, size] = value >= 1e9 ? ['B', 1e9] : value >= 1e6 ? ['M', 1e6] : ['K', 1e3];
  const scaled = value / size;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${unit}`.replace(/\.0+(?=[KMB])|(\.\d*?)0+(?=[KMB])/u, '$1');
}
/** Input tokens include cache reads and writes, as the provider bills them. */
export function inputTokens(counts: UsageCounts): number { return counts.input + counts.cacheRead + counts.cacheWrite; }
export function cacheShare(counts: UsageCounts): number | null {
  const input = inputTokens(counts); return input > 0 ? Math.round(counts.cacheRead / input * 100) : null;
}
export const sourceLabels: Record<UsageReport['bySource'][number]['source'], { label: string; hint?: string }> = {
  main: { label: '主对话', hint: '和你的聊天、定时与扩展唤醒' }, subagent: { label: '子任务' }, compaction: { label: '上下文压缩' }, dreaming: { label: 'Dreaming', hint: '记忆整理' },
};
export function triggerLabel(trigger: UsageReport['topWakes'][number]['trigger']): string {
  if (!trigger) return '唤醒';
  if (trigger.source === 'user') return '你的消息';
  if (trigger.source === 'system' && trigger.type === 'memory.dreaming') return 'Dreaming';
  if (trigger.source === 'system' && trigger.type.startsWith('schedule')) return '定时任务';
  if (trigger.source === 'extension') return '扩展';
  if (trigger.source === 'external') return '外部程序';
  return '系统';
}
/** Day label from a YYYY-MM-DD local date: weekday over month/day. */
export function dayLabel(date: string): { weekday: string; day: string } {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return { weekday: ['日', '一', '二', '三', '四', '五', '六'][value.getUTCDay()] ?? '', day: `${m}/${d}` };
}
