import { RunChildren } from './Subagents.tsx';
import { useEffect, useRef, useState } from 'react';
import { api, errorText, isAbort } from './api.ts';
import { memoryReceiptText } from './MemoryPanel.tsx';
import type { RunDetail, RunExecution, RunRequestsPage, RunSummary, RunsView } from './types.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';
import { acceptRunRecords, emptyRunRecords, nextRunRecords } from './run-records.ts';
import { acceptRunRequests, beginRunRequests, cancelRunRequests, emptyRunRequests, finishRunRequests, matchesRunRequests, seedRunRequests } from './run-requests.ts';

function dateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间未记录' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
const kindLabel: Record<RunExecution['kind'], string> = { model: '模型', tool: '工具', compaction: '压缩', recovery: '恢复', unavailable: '记录不可用' };
function mergeById<T extends { id: string }>(before: T[], incoming: T[]): T[] { const result = new Map(before.map(item => [item.id, item])); for (const item of incoming) result.set(item.id, item); return [...result.values()]; }

function RunRecord({ id, active, onBack }: { id: string; active: boolean; onBack: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [version, setVersion] = useState(0);
  const olderRef = useRef<AbortController | null>(null);
  const pagingRef = useRef(false);
  const recordsRef = useRef(emptyRunRecords());
  const [requests, setRequests] = useState(() => emptyRunRequests(id));
  const requestsRef = useRef(requests);
  const requestsAbort = useRef<AbortController | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  useEffect(() => () => { olderRef.current?.abort(); requestsAbort.current?.abort(); requestsRef.current = cancelRunRequests(requestsRef.current); }, []);
  useEffect(() => {
    if (!active) {
      olderRef.current?.abort(); pagingRef.current = false; setLoadingOlder(false);
      requestsAbort.current?.abort(); requestsRef.current = cancelRunRequests(requestsRef.current); setRequests(requestsRef.current);
    }
  }, [active]);
  useVisiblePoll(active, async signal => {
    try {
      const next = await api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, { signal });
      if (signal.aborted) return;
      if (next.id !== id) throw new Error('读取到其他 Wake 的记录，当前详情尚未确认');
      recordsRef.current = acceptRunRecords(recordsRef.current, next);
      requestsRef.current = seedRunRequests(requestsRef.current, next.id, next.requests, next.nextRequestsCursor); setRequests(requestsRef.current);
      setDetail({ ...next, executions: recordsRef.current.executions, nextCursor: nextRunRecords(recordsRef.current)?.cursor ?? null }); setError(null);
    } catch (cause) { if (!signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
  }, 5000, version);
  const older = async () => {
    const request = nextRunRecords(recordsRef.current);
    if (pagingRef.current || !request) return;
    pagingRef.current = true; setLoadingOlder(true); setOlderError(null);
    const controller = new AbortController(); olderRef.current = controller;
    try {
      const next = await api<RunDetail>(`/api/runs/${encodeURIComponent(id)}?before=${encodeURIComponent(request.cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (next.id !== id) throw new Error('无法核对此 Wake 的更多记录');
      recordsRef.current = acceptRunRecords(recordsRef.current, next, request);
      setDetail(current => current ? { ...current, executions: recordsRef.current.executions, nextCursor: nextRunRecords(recordsRef.current)?.cursor ?? null } : next);
    } catch (cause) { if (!controller.signal.aborted && !isAbort(cause)) setOlderError(errorText(cause)); }
    finally { if (olderRef.current === controller) { pagingRef.current = false; if (!controller.signal.aborted) setLoadingOlder(false); } }
  };
  const moreRequests = async () => {
    const nextState = beginRunRequests(requestsRef.current);
    if (nextState === requestsRef.current || !nextState.reading || !active) return;
    requestsRef.current = nextState; setRequests(nextState); setRequestsError(null);
    const request = nextState.reading;
    const controller = new AbortController(); requestsAbort.current = controller;
    try {
      const page = await api<RunRequestsPage>(`/api/runs/${encodeURIComponent(request.runId)}/requests?before=${encodeURIComponent(request.cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted || !matchesRunRequests(requestsRef.current, request)) return;
      requestsRef.current = acceptRunRequests(requestsRef.current, request, page); setRequests(requestsRef.current);
    } catch (cause) {
      if (!controller.signal.aborted && matchesRunRequests(requestsRef.current, request) && !isAbort(cause)) setRequestsError(errorText(cause));
    } finally {
      if (!controller.signal.aborted && matchesRunRequests(requestsRef.current, request)) {
        requestsRef.current = finishRunRequests(requestsRef.current, request); setRequests(requestsRef.current);
      }
    }
  };
  return <>
    <div className="management-heading"><button type="button" className="text-button" onClick={onBack}>返回运行列表</button><button type="button" className="text-button" onClick={() => setVersion(value => value + 1)}>刷新详情</button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!detail && !error && <p className="management-empty" role="status">正在读取运行详情…</p>}
    {detail && <article className="run-detail" aria-label="运行详情">
      <h3>Wake 运行</h3><p className="technical-id">{detail.id}</p><p className="field-hint">{dateTime(detail.occurredAt)} · {detail.status === 'completed' ? '已完成' : '尚未记录完成'}</p>
      {detail.error && <p className="field-notice">{detail.error}</p>}
      <section aria-label="触发请求"><h4>触发来源</h4><p className="field-hint">共 {detail.requestCount} 个触发请求，已读取 {requests.items.length} 个。</p>{requests.items.length ? <ul className="run-requests">{requests.items.map(request => <li key={request.eventId}><strong>{request.source === 'unavailable' && request.type === 'unavailable' ? '触发描述未展示' : `${request.source} · ${request.type}`}</strong><span className="technical-id">{request.eventId}</span>{request.source === 'unavailable' && request.type === 'unavailable' ? <p>原始触发描述超出展示大小限制，完整记录仍保留在 History 中。</p> : request.reason && <p>{request.reason}</p>}</li>)}</ul> : <p className="field-hint">没有可读取的触发来源记录。</p>}
        {requests.nextCursor && <button className="text-button" type="button" disabled={!!requests.reading} onClick={() => { void moreRequests(); }}>{requests.reading ? '正在读取触发请求…' : '更多触发请求'}</button>}
        {requestsError && <p className="inline-error" role="alert">{requestsError}</p>}
      </section>
      <section><h4>Memory</h4><p className="field-hint">{memoryReceiptText(detail.memory)}</p>{detail.memory.commit && <p className="technical-id">{detail.memory.commit}</p>}</section>
      <RunChildren key={id} runId={id} active={active} />
      <section><h4>模型、工具与压缩</h4><p className="field-hint">只展示已记录的名称、状态和安全诊断，不展示原始参数、工具结果或思考内容。</p>
        {!detail.executions.length ? <p className="management-empty">没有可展示的执行记录。</p> : <ol className="execution-list">{detail.executions.map(execution => <li key={execution.id}><div><span className="management-badge">{kindLabel[execution.kind]}</span><strong>{execution.name ?? '名称未记录'}</strong><span>{execution.status}</span></div><time dateTime={execution.occurredAt}>{dateTime(execution.occurredAt)}</time>{execution.error && <p className="inline-error">{execution.error}</p>}</li>)}</ol>}
        {detail.nextCursor && <button className="text-button" type="button" disabled={loadingOlder} onClick={() => { void older(); }}>{loadingOlder ? '正在读取更多记录…' : '读取更多执行记录'}</button>}
        {olderError && <p role="alert" className="inline-error">{olderError}</p>}
        <p className="field-notice">当前运行时没有持久化压缩失败记录。这里没有记录，不代表从未发生压缩错误。</p>
      </section>
      <section><h4>Mira 回复</h4>{detail.assistant ? <p className="run-reply">{detail.assistant.text}</p> : <p className="field-hint">此 Wake 没有可展示的文字回复。</p>}</section>
    </article>}
  </>;
}

export function RunsPanel({ active }: { active: boolean }) {
  const [items, setItems] = useState<RunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const busyRef = useRef(false);
  const olderAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!active || selected) return;
    const controller = new AbortController();
    setLoading(true); setLoadingOlder(false); setError(null);
    void api<RunsView>('/api/runs', { signal: controller.signal }).then(next => { if (!controller.signal.aborted) { setItems(next.items); setNextCursor(next.nextCursor); } }).catch((cause: unknown) => { if (!controller.signal.aborted && !isAbort(cause)) setError(errorText(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); olderAbort.current?.abort(); busyRef.current = false; };
  }, [active, selected, version]);
  const older = async () => {
    if (busyRef.current || !nextCursor) return;
    busyRef.current = true; setLoadingOlder(true); setError(null);
    const controller = new AbortController(); olderAbort.current = controller;
    try { const next = await api<RunsView>(`/api/runs?before=${encodeURIComponent(nextCursor)}`, { signal: controller.signal }); if (!controller.signal.aborted) { setItems(current => mergeById(current, next.items)); setNextCursor(next.nextCursor); } }
    catch (cause) { if (!controller.signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
    finally { if (olderAbort.current === controller) { busyRef.current = false; if (!controller.signal.aborted) setLoadingOlder(false); } }
  };
  return <div className="settings-body management-body">
    {selected ? <RunRecord key={selected} id={selected} active={active} onBack={() => setSelected(null)} /> : <>
      <div className="management-heading"><div><h3>运行记录</h3><p>同一个 Mira 的 Wake 历史，不创建新对话。</p></div><button type="button" className="text-button" disabled={loading} onClick={() => setVersion(value => value + 1)}>刷新运行列表</button></div>
      {loading ? <p className="management-empty" role="status">正在读取运行记录…</p> : !items.length && !error ? <p className="management-empty">还没有可读取的 Wake 运行。</p> : null}
      {error && <p role="alert" className="inline-error">{error}</p>}
      <ul className="runs-list">{items.map(item => <li key={item.id}><button type="button" className="run-list-button" onClick={() => setSelected(item.id)}><span><strong>{dateTime(item.occurredAt)}</strong><span>{item.status === 'completed' ? '已完成' : '尚未记录完成'} · {item.requestCount} 个触发请求</span></span><span className="technical-id">{item.id}</span></button></li>)}</ul>
      {nextCursor && <button className="text-button" type="button" disabled={loading || loadingOlder} onClick={() => { void older(); }}>{loadingOlder ? '正在读取…' : '查看更早的运行'}</button>}
    </>}
  </div>;
}
