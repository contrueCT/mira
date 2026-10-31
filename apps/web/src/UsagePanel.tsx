import { useState } from 'react';
import { api, errorText, isAbort } from './api.ts';
import type { ServerStatus } from './types.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';
import { cacheShare, compactNumber, dayLabel, inputTokens, localTimeZone, sourceLabels, triggerLabel, usageRanges, type UsageRange, type UsageReport } from './usage.ts';

const timeFormat = (value: string, timeZone: string, withDate: boolean) => {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, ...(withDate ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
};

function Chart({ report }: { report: UsageReport }) {
  const days = report.days.slice(-7);
  const max = Math.max(1, ...days.map(day => day.total));
  const height = 110;
  return <div className="usage-chart">
    <div className="usage-bars" aria-hidden="true">{days.map((day, index) => {
      const scale = (value: number) => `${(value / max) * height}px`;
      return <div key={day.date} className={`usage-bar${index === days.length - 1 ? ' today' : ''}`} style={{ height: scale(day.total) }} title={`${day.date} · ${compactNumber(day.total)} token`}>
        <i className="in" style={{ height: scale(day.input + day.cacheWrite) }} /><i className="cache" style={{ height: scale(day.cacheRead) }} /><i className="out" style={{ height: scale(day.output) }} />
      </div>;
    })}</div>
    <div className="usage-days">{days.map((day, index) => { const label = dayLabel(day.date); return <span key={day.date}><b>{index === days.length - 1 ? '今天' : `周${label.weekday}`}</b>{label.day}</span>; })}</div>
    <div className="usage-legend"><span className="in">输入（未命中缓存）</span><span className="cache">缓存命中</span><span className="out">输出</span></div>
    <p className="sr-only">{days.map(day => `${day.date} ${compactNumber(day.total)} token`).join('；')}</p>
  </div>;
}

export function UsagePanel({ active }: { active: boolean }) {
  const [range, setRange] = useState<UsageRange>('today');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [pause, setPause] = useState<ServerStatus['pause']>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const timeZone = localTimeZone();
  useVisiblePoll(active, async signal => {
    setLoading(true);
    try {
      const [next, status] = await Promise.all([
        api<UsageReport>(`/api/usage?range=${range}&tz=${encodeURIComponent(timeZone)}`, { signal }),
        api<ServerStatus>('/api/status', { signal }).catch(() => null),
      ]);
      if (signal.aborted) return;
      if (next.range !== range) return;
      setReport(next); setPause(status?.pause ?? null); setError(null);
    } catch (cause) { if (!signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
    finally { if (!signal.aborted) setLoading(false); }
  }, 60_000, `${range}:${version}`);
  const rangeInfo = usageRanges.find(item => item.id === range)!;
  const shown = report?.range === range ? report : null;
  const totals = shown?.totals; const previous = shown?.previous;
  const share = totals ? cacheShare(totals) : null;
  const maxSource = Math.max(1, ...(shown?.bySource.map(item => item.total) ?? [1]));
  return <div className="settings-body management-body usage-panel">
    <div className="management-heading"><div><h3>用量</h3><p>按模型供应商每次返回的 usage 统计，包括主对话、子任务、上下文压缩和 Dreaming。这里只做记录，不限制用量，聊天里也不逐条显示。</p></div>
      <button type="button" className="text-button" disabled={loading} onClick={() => setVersion(value => value + 1)}>刷新</button></div>
    {pause && <div className="balance-card" role="status"><span className="status-dot warning" aria-hidden="true" /><div><strong>模型余额不足，Mira 已暂停</strong>
      Mira 的所有动作都已停下。充值后在聊天里发一条消息，Mira 就会接着做。</div></div>}
    <div className="usage-toolbar">
      <div className="usage-range" role="group" aria-label="统计范围">{usageRanges.map(item => <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}</div>
      {shown && <span className="as-of">统计到 {timeFormat(shown.generatedAt, timeZone, false)} · 按本机时区</span>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!shown && !error && <p className="management-empty">正在读取用量…</p>}
    {shown && totals && previous && <>
      <div className="usage-stats">
        <div className="usage-stat"><span>模型请求</span><strong>{compactNumber(totals.requests)}</strong><small>{totals.failedRequests ? `其中失败 ${compactNumber(totals.failedRequests)}` : `${rangeInfo.previous} ${compactNumber(previous.requests)}`}</small></div>
        <div className="usage-stat"><span>输入 token</span><strong>{compactNumber(inputTokens(totals))}</strong><small>{share === null ? '无缓存数据' : `缓存命中 ${share}%`}</small></div>
        <div className="usage-stat"><span>输出 token</span><strong>{compactNumber(totals.output)}</strong><small>{rangeInfo.previous} {compactNumber(previous.output)}</small></div>
        <div className="usage-stat"><span>合计 token</span><strong>{compactNumber(totals.total)}</strong><small>含缓存命中 {compactNumber(totals.cacheRead)}</small></div>
      </div>
      <div className="usage-section-title">最近 7 天<small>每天的 token，按输入 / 缓存命中 / 输出堆叠</small></div>
      <Chart report={shown} />
      <div className="usage-section-title">按来源<small>{rangeInfo.label}</small></div>
      <table className="usage-table"><thead><tr><th scope="col">来源</th><th scope="col">请求</th><th scope="col">输入</th><th scope="col">输出</th><th scope="col">合计</th></tr></thead><tbody>
        {shown.bySource.map(item => { const label = sourceLabels[item.source]; const hint = item.source === 'subagent' ? (item.tasks ? `${item.tasks} 个任务` : undefined) : label.hint; return <tr key={item.source}>
          <td>{label.label}{hint && <small>{hint}</small>}</td><td>{compactNumber(item.requests)}</td><td>{compactNumber(inputTokens(item))}</td><td>{compactNumber(item.output)}</td>
          <td>{compactNumber(item.total)}<span className="share" aria-hidden="true"><i style={{ width: `${Math.round(item.total / maxSource * 100)}%` }} /></span></td></tr>; })}
      </tbody></table>
      <div className="usage-section-title">用量最多的唤醒<small>{rangeInfo.label} · 在“运行记录”里查看详情</small></div>
      {shown.topWakes.length ? <table className="usage-table"><thead><tr><th scope="col">唤醒</th><th scope="col">请求</th><th scope="col">合计</th></tr></thead><tbody>
        {shown.topWakes.map(item => <tr key={item.runId}><td>{timeFormat(item.claimedAt, timeZone, true)} · {triggerLabel(item.trigger)}{item.preview && <small>“{item.preview}”</small>}</td><td>{compactNumber(item.requests)}</td><td>{compactNumber(item.total)}</td></tr>)}
      </tbody></table> : <p className="management-empty">这段时间还没有模型请求。</p>}
      {shown.byModel.length > 1 && <>
        <div className="usage-section-title">按模型<small>{rangeInfo.label}</small></div>
        <table className="usage-table"><thead><tr><th scope="col">模型</th><th scope="col">请求</th><th scope="col">合计</th></tr></thead><tbody>
          {shown.byModel.map(item => <tr key={`${item.provider}/${item.model}`}><td>{item.model}<small>{item.provider}</small></td><td>{compactNumber(item.requests)}</td><td>{compactNumber(item.total)}</td></tr>)}
        </tbody></table>
      </>}
    </>}
    <p className="usage-footnote">token 数来自供应商返回值；请求失败、被取消或没有返回 usage 的请求只计次数，不计 token。费用请以供应商账单为准。</p>
  </div>;
}
