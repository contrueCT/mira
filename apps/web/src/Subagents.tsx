import { useEffect, useRef, useState } from 'react';
import { mergeChildPage } from './child-records.ts';
import { api, errorText, isAbort } from './api.ts';
import type { ChildActivityView, ChildDetailView, ChildSummaryView, ChildrenView } from './types.ts';
import { latestPagination, olderPagination, nextHistoryRequest } from './timeline.ts';
import type { HistoryPagination } from './timeline.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';

const terminal = (status: string) => ['completed', 'failed', 'interrupted', 'cancelled'].includes(status);
export const childStatus = (status: string) => ({ queued: '等待执行', running: '执行中（最近记录）', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', unknown: '状态未确认' }[status] ?? '状态未确认');
const when = (value: string) => new Date(value).toLocaleString('zh-CN');
export function activityText(activity: ChildActivityView): string {
  if (activity.kind === 'progress') return activity.text ?? '进度已报告';
  const name = activity.kind === 'model' ? activity.name === 'context-compaction' ? '整理任务上下文' : '生成回复' : `工具 ${activity.name ?? '名称未记录'}`;
  if (activity.phase === 'started') return `${name} · 已开始`;
  return `${name} · ${{ succeeded: '已完成', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '结果未知' }[activity.status ?? ''] ?? '已结束'}`;
}
const endpoint = (runId: string, id: string) => `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(id)}`;

function ChildDialog({ runId, id, onClose }: { runId: string; id: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [detail, setDetail] = useState<ChildDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current; dialog?.showModal(); closeRef.current?.focus();
    return () => { dialog?.close(); focus?.focus(); };
  }, []);
  useVisiblePoll(true, async signal => {
    try {
      const next = await api<ChildDetailView>(endpoint(runId, id), { signal });
      if (signal.aborted) return;
      if (next.id !== id || next.runId !== runId) throw new Error('无法核对子任务所属的运行');
      setDetail(next); setError(null);
    } catch (cause) { if (!signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
  }, 2000, version);
  return <dialog ref={ref} className="child-dialog" aria-labelledby="child-dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="child-dialog-header"><div><p className="eyebrow">子代理 · 只读详情</p><h2 id="child-dialog-title">{detail?.title ?? '子任务'}</h2></div><button ref={closeRef} type="button" className="text-button" onClick={onClose}>关闭</button></header>
    <div className="child-dialog-body">
      <div className="management-heading"><span className="management-badge">{detail ? childStatus(detail.status) : '正在读取'}</span><button type="button" className="text-button" onClick={() => setVersion(v => v + 1)}>刷新子任务</button></div>
      {error && <p className="inline-error" role="alert">{error}。保留上次已确认的记录。</p>}
      {!detail && !error && <p role="status">正在读取子任务…</p>}
      {detail && <>
        <p className="technical-id">{detail.id}</p><p className="field-hint">创建于 {when(detail.createdAt)}</p>
        {detail.current && <p className="child-current" role="status">最近记录：{activityText(detail.current)}</p>}
        <p className="field-hint">{detail.updatedAt ? `活动记录更新于 ${when(detail.updatedAt)}。` : ''}以下是子代理主动报告的进度、运行时确认的活动与结果。子代理输出仍需 Mira 核对。</p>
        {detail.turns.map(turn => <section className="child-turn" key={turn.id} aria-label={`子任务第 ${turn.sequence} 轮`}>
          <h3>第 {turn.sequence} 轮 <span className="management-badge">{childStatus(turn.status)}</span></h3>
          <p className="field-hint">{turn.startedAt ? `开始 ${when(turn.startedAt)}` : `等待于 ${when(turn.createdAt)}`}{turn.finishedAt ? ` · 结束 ${when(turn.finishedAt)}` : ''}</p>
          {!turn.activities.length && <p className="field-hint">尚无公开活动记录。</p>}
          {!!turn.droppedActivities && <p className="field-hint">显示最近的活动，{turn.droppedActivities} 条较早活动未包含在此有界预览中。</p>}
          <ol className="child-activities">{turn.activities.map(activity => <li key={activity.sequence}><div><span className="child-source">{activity.source === 'worker' ? '子代理报告' : '运行时记录'}</span><time dateTime={activity.occurredAt}>{when(activity.occurredAt)}</time></div><p>{activityText(activity)}</p></li>)}</ol>
          {turn.result && <div className="child-result"><h4>子代理结果</h4><p>{turn.result.text}</p>{turn.result.truncated && <p className="field-notice">此处展示有界摘要；完整结果由 Mira 读取。文件仅在 Mira 显式发送附件后可下载。</p>}</div>}
          {['interrupted', 'cancelled'].includes(turn.status) && <p className="field-notice">停止执行不能撤销已开始的操作；未确认的结果仍为未知，不会自动重放。</p>}
        </section>)}
        {detail.olderTurns > 0 && <p className="field-hint">另有 {detail.olderTurns} 轮较早记录；此处展示最近 8 轮与仍在执行的一轮。</p>}
      </>}
    </div>
  </dialog>;
}

/** Each loaded child is observed by its own stable identity, independently from
 * parent history cursors. Offscreen/hidden cards pause; terminal cards check slowly
 * because a later followup can reuse the same child identity. */
export function ChildCard({ id, runId, initial, active = true }: { id: string; runId: string; initial?: ChildSummaryView; active?: boolean }) {
  const [summary, setSummary] = useState<ChildSummaryView | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = button.current; if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setNear(entries.at(-1)?.isIntersecting ?? false), { rootMargin: '160px' });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useVisiblePoll(active && near && !open, async signal => {
    try {
      const next = await api<ChildSummaryView>(`${endpoint(runId, id)}?view=summary`, { signal });
      if (signal.aborted) return;
      if (next.id !== id || next.runId !== runId) throw new Error('无法核对子任务所属的运行');
      setSummary(next); setError(null);
    } catch (cause) { if (!signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
  }, summary && terminal(summary.status) ? 5000 : 2000);
  return <>
    <button ref={button} type="button" className="child-card" onClick={() => setOpen(true)} aria-label={`查看子任务 ${summary?.title ?? '子任务'}`}>
      <span className="child-card-top"><strong>{summary?.title ?? '子任务'}</strong><span>{error ? '刷新未确认' : childStatus(summary?.status ?? 'unknown')}</span></span>
      <span className="child-card-activity">{summary?.current ? activityText(summary.current) : error ? '点击查看已保存的记录' : '查看进度与结果'}<span aria-hidden="true"> ›</span></span>
    </button>
    {open && <ChildDialog key={`${runId}:${id}`} runId={runId} id={id} onClose={() => setOpen(false)} />}
  </>;
}

export function RunChildren({ runId, active }: { runId: string; active: boolean }) {
  const [items, setItems] = useState<ChildSummaryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const paging = useRef<HistoryPagination>({ latestCursor: null, oldestCursor: null, gaps: [] });
  const itemsRef = useRef<ChildSummaryView[]>([]);
  const initialized = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (!active) { controller.current?.abort(); setReading(false); } }, [active]);
  useVisiblePoll(active, async signal => {
    try {
      const page = await api<ChildrenView>(`/api/runs/${encodeURIComponent(runId)}/subagents`, { signal });
      if (signal.aborted) return;
      if (page.items.some(item => item.runId !== runId)) throw new Error('无法核对子任务所属的运行');
      paging.current = latestPagination(paging.current, itemsRef.current, page, initialized.current); initialized.current = true;
      itemsRef.current = mergeChildPage(itemsRef.current, page.items); setItems(itemsRef.current); setCursor(nextHistoryRequest(paging.current)?.cursor ?? null); setError(null);
    } catch (cause) { if (!signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
  }, 5000, runId);
  const older = async () => {
    const request = nextHistoryRequest(paging.current);
    if (!request || reading) return; setReading(true); const abort = new AbortController(); controller.current = abort;
    try { const page = await api<ChildrenView>(`/api/runs/${encodeURIComponent(runId)}/subagents?before=${encodeURIComponent(request.cursor)}`, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (page.items.some(item => item.runId !== runId)) throw new Error('无法核对子任务所属的运行');
      paging.current = olderPagination(paging.current, request, page);
      itemsRef.current = mergeChildPage(itemsRef.current, page.items, request.cursor); setItems(itemsRef.current); setCursor(nextHistoryRequest(paging.current)?.cursor ?? null); setError(null);
    } catch (cause) { if (!abort.signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
    finally { if (!abort.signal.aborted) setReading(false); }
  };
  if (!items.length && !error) return null;
  return <section className="run-children" aria-label="子任务"><h4>子任务</h4>{error && <p className="inline-error" role="alert">{error}</p>}{items.map(item => <ChildCard key={item.id} id={item.id} runId={runId} initial={item} active={active} />)}{cursor && <button type="button" className="text-button" disabled={reading} onClick={() => { void older(); }}>{reading ? '正在读取…' : '更多子任务'}</button>}</section>;
}
