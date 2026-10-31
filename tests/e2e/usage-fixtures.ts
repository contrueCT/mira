/** Shared, synthetic usage and balance payloads for UI tests and screenshots. */
const c = (requests: number, input: number, cacheRead: number, output: number, failedRequests = 0) => ({ requests, failedRequests, input, output, cacheRead, cacheWrite: 0, total: input + cacheRead + output });
export function usageReport(range: 'today' | '7d' | '30d', now = new Date()) {
  const n = range === '30d' ? 30 : 7;
  const days = Array.from({ length: n }, (_, index) => {
    const date = new Date(now.getTime() - (n - 1 - index) * 86_400_000);
    const scale = [0.55, 0.8, 0.35, 1, 0.7, 0.9, 0.45][index % 7]!;
    return { date: date.toLocaleDateString('en-CA'), ...c(Math.round(120 * scale), Math.round(520_000 * scale), Math.round(1_410_000 * scale), Math.round(36_400 * scale)) };
  });
  const totals = range === 'today' ? c(128, 510_000, 1_410_000, 36_400, 2) : range === '7d' ? c(831, 3_610_000, 9_340_000, 306_100, 4) : c(3_204, 14_200_000, 37_900_000, 1_180_000, 11);
  return {
    range, timeZone: 'UTC', generatedAt: now.toISOString(), since: now.toISOString(), totals,
    previous: range === 'today' ? c(171, 640_000, 1_620_000, 58_100) : c(702, 3_100_000, 8_000_000, 260_000),
    days,
    bySource: [
      { source: 'main', tasks: 0, ...c(612, 2_470_000, 6_840_000, 214_000) },
      { source: 'subagent', tasks: 23, ...c(204, 780_000, 1_960_000, 71_600) },
      { source: 'compaction', tasks: 0, ...c(9, 190_000, 422_000, 18_200) },
      { source: 'dreaming', tasks: 0, ...c(6, 170_000, 118_000, 2_300) },
    ],
    topWakes: [
      { runId: 'a0000000-0000-4000-8000-000000000001', claimedAt: '2026-10-28T06:02:00.000Z', trigger: { source: 'user', type: 'web.message' }, preview: '把浏览器面板的锁定状态重新设计一下', ...c(86, 320_000, 780_000, 20_000) },
      { runId: 'a0000000-0000-4000-8000-000000000002', claimedAt: '2026-10-30T14:40:00.000Z', trigger: { source: 'user', type: 'web.message' }, preview: '跑一遍完整测试，失败的修掉', ...c(61, 240_000, 590_000, 12_000) },
      { runId: 'a0000000-0000-4000-8000-000000000003', claimedAt: '2026-10-31T00:00:00.000Z', trigger: { source: 'system', type: 'schedule.delivery' }, preview: null, ...c(18, 60_000, 160_000, 6_000) },
    ],
    byModel: [{ provider: 'deepseek', model: 'deepseek-chat', ...totals }],
  };
}
export const pausedStatus = { state: 'paused', mode: 'live', model: 'deepseek-chat', error: null,
  pause: { reason: 'balance', since: '2026-10-31T01:12:00.000Z', status: 402, requestId: '0f3a9c1e-77b2-4d1a', provider: 'deepseek', model: 'deepseek-chat' } };
export const balanceTimeline = { nextCursor: null, items: [
  { id: 'b0000000-0000-4000-8000-000000000001', role: 'user', text: '帮我看看为什么 CI 这么慢', occurredAt: '2026-10-31T01:10:00.000Z' },
  { id: 'b0000000-0000-4000-8000-000000000002', role: 'assistant', text: '找到了，e2e 和 integration 两个 job 占了总时长的 80%。我再看下 integration 里是哪几个测试拖慢的。', occurredAt: '2026-10-31T01:11:00.000Z' },
  { id: 'b0000000-0000-4000-8000-000000000003', role: 'notice', notice: 'balance', balance: { status: 402, requestId: '0f3a9c1e-77b2-4d1a', provider: 'deepseek' },
    text: 'DeepSeek 因账户余额不足拒绝了请求，Mira 的所有动作都已停下，不会自行重试或继续。充值后发一条消息，Mira 就会接着做。', occurredAt: '2026-10-31T01:12:00.000Z' },
] };
