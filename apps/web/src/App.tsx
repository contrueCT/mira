import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { api, errorText, isAbort } from './api.ts';
import { ArrowUp, ChevronDown, SettingsIcon } from './icons.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { latestPagination, mergeTimeline, nextHistoryRequest, olderPagination, readPending, reconcilePending, writePending } from './timeline.ts';
import type { HistoryPagination, HistoryRequest } from './timeline.ts';
import type { MessageEnvelope, PendingMessage, ServerStatus, TimelineItem, TimelinePage, ToolActivity } from './types.ts';

const toolLabels: Record<ToolActivity['status'], string> = { running: '进行中', completed: '已完成', failed: '未完成', unknown: '结果待核对' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
function timeLabel(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date); }
function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  return new Intl.DateTimeFormat('zh-CN', { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' }).format(date);
}
function initialPending(): { messages: PendingMessage[]; error: string | null } {
  try { return { messages: readPending(window.sessionStorage), error: null }; }
  catch { return { messages: [], error: '浏览器中的待确认消息无法读取。为避免丢失或重复发送，请先恢复此标签页的存储访问，再刷新页面。' }; }
}

export function App() {
  const [recovered] = useState(initialPending);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>(recovered.messages);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(recovered.error);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasHistoryGap, setHasHistoryGap] = useState(false);
  const [composer, setComposer] = useState('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [nearBottom, setNearBottom] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(() => window.location.hash === '#settings');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(pending);
  const statusRef = useRef(status);
  const itemsRef = useRef(items);
  const nearBottomRef = useRef(true);
  const sendingRef = useRef(false);
  const initializedRef = useRef(false);
  const paginationRef = useRef<HistoryPagination>({ latestCursor: null, oldestCursor: null, gaps: [] });
  const activeRef = useRef(true);
  const olderBusyRef = useRef(false);
  const closingSettingsRef = useRef(false);
  const prependAnchorRef = useRef<{ height: number; top: number; element: HTMLElement | null; offset: number } | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const postAbortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const updatePending = useCallback((change: (current: PendingMessage[]) => PendingMessage[], mustPersist = false) => {
    if (recovered.error) return false; // Never overwrite a queue we could not recover.
    const next = change(pendingRef.current);
    try { writePending(window.sessionStorage, next); if (mustPersist) setStorageError(null); }
    catch {
      setStorageError('浏览器暂时无法保存待确认消息。请保持此标签页打开，并恢复浏览器存储后重试。');
      if (mustPersist) return false;
    }
    pendingRef.current = next;
    setPending(next);
    return true;
  }, [recovered.error]);

  const acceptPage = useCallback((page: TimelinePage, request: HistoryRequest | null = null) => {
    if (request && scrollRef.current) {
      const container = scrollRef.current;
      const top = container.getBoundingClientRect().top;
      const element = [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.getBoundingClientRect().bottom > top) ?? null;
      prependAnchorRef.current = { height: container.scrollHeight, top: container.scrollTop, element, offset: element ? element.getBoundingClientRect().top - top : 0 };
    }
    paginationRef.current = request ? olderPagination(paginationRef.current, request, page) : latestPagination(paginationRef.current, itemsRef.current, page, initializedRef.current);
    const merged = mergeTimeline(itemsRef.current, page.items);
    itemsRef.current = merged;
    setItems(merged);
    updatePending(current => reconcilePending(current, merged));
    if (!request) setTools(page.tools);
    setNextCursor(nextHistoryRequest(paginationRef.current)?.cursor ?? null);
    setHasHistoryGap(paginationRef.current.gaps.length > 0);
    initializedRef.current = true;
    setLoading(false);
  }, [updatePending]);

  const refresh = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const signal = pollAbortRef.current?.signal;
    const request = (async () => {
      const results = await Promise.allSettled([
        api<ServerStatus>('/api/status', signal ? { signal } : {}),
        api<TimelinePage>('/api/timeline', signal ? { signal } : {}),
      ]);
      if (!activeRef.current || signal?.aborted) return;
      const statusResult = results[0]; const timelineResult = results[1];
      if (statusResult.status === 'fulfilled') { statusRef.current = statusResult.value; setStatus(statusResult.value); }
      if (timelineResult.status === 'fulfilled') acceptPage(timelineResult.value);
      else setLoading(false);
      const failed = results.find(result => result.status === 'rejected');
      setConnectionError(failed?.status === 'rejected' ? `暂时无法连接本地服务 · ${errorText(failed.reason)}` : null);
    })();
    inFlightRef.current = request;
    void request.finally(() => { if (inFlightRef.current === request) inFlightRef.current = null; });
    return request;
  }, [acceptPage]);

  useEffect(() => {
    activeRef.current = true;
    const controller = new AbortController();
    pollAbortRef.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let generation = 0;
    const poll = async () => {
      const currentGeneration = ++generation;
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      await refresh();
      if (!stopped && !document.hidden && currentGeneration === generation) timer = setTimeout(() => { void poll(); }, statusRef.current?.state === 'working' ? 1200 : 5000);
    };
    const onVisibility = () => { generation += 1; clearTimeout(timer); if (!document.hidden) void poll(); };
    void poll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true; activeRef.current = false; controller.abort(); postAbortRef.current?.abort(); clearTimeout(timer);
      inFlightRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    const sync = () => { closingSettingsRef.current = false; setSettingsOpen(window.location.hash === '#settings'); };
    window.addEventListener('hashchange', sync); window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (prependAnchorRef.current) {
      const anchor = prependAnchorRef.current;
      container.scrollTop = anchor.element?.isConnected ? container.scrollTop + anchor.element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset : anchor.top + container.scrollHeight - anchor.height;
      prependAnchorRef.current = null;
    } else if (nearBottomRef.current) container.scrollTop = container.scrollHeight;
  }, [items, pending, tools, loading]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`; }
  }, [composer]);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const isNear = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    nearBottomRef.current = isNear;
    setNearBottom(isNear);
  };
  const scrollToLatest = () => {
    nearBottomRef.current = true; setNearBottom(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };
  const loadOlder = async () => {
    const request = nextHistoryRequest(paginationRef.current);
    if (!request || olderBusyRef.current) return;
    olderBusyRef.current = true; setLoadingOlder(true); setOlderError(null);
    try {
      const page = await api<TimelinePage>('/api/timeline', { method: 'POST', body: JSON.stringify({ before: request.cursor }), signal: pollAbortRef.current!.signal });
      if (activeRef.current) acceptPage(page, request);
    } catch (error) { if (!isAbort(error) && activeRef.current) setOlderError(errorText(error)); }
    finally { olderBusyRef.current = false; if (activeRef.current) setLoadingOlder(false); }
  };

  const sendEnvelope = async (envelope: MessageEnvelope, retry = false) => {
    if (sendingRef.current || recovered.error) return;
    sendingRef.current = true; setSending(true);
    const controller = new AbortController(); postAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      if (retry) {
        // Look for the durable event first. A failed read does not authorize an automatic resend.
        const page = await api<TimelinePage>('/api/timeline', { signal: controller.signal });
        if (!activeRef.current) return;
        acceptPage(page);
        if (itemsRef.current.some(item => item.id === `event:${envelope.id}`)) return;
      }
      if (!updatePending(current => [...current.filter(message => message.id !== envelope.id), { ...envelope, state: 'sending' }], true)) return;
      if (!retry) setComposer('');
      const receipt = await api<{ id: string; receipt: 'inserted' | 'duplicate' }>('/api/messages', { method: 'POST', body: JSON.stringify(envelope), signal: controller.signal });
      if (!activeRef.current) return;
      if (receipt.id !== envelope.id || !['inserted', 'duplicate'].includes(receipt.receipt)) throw new Error('无法确认服务端的接收回执');
      updatePending(current => current.map(message => message.id === envelope.id ? { ...envelope, state: 'queued' } : message));
      void refresh();
    } catch (error) {
      if (activeRef.current) updatePending(current => current.map(message => message.id === envelope.id ? { ...envelope, state: 'uncertain', error: isAbort(error) ? '连接中断，接收结果尚未确认' : errorText(error) } : message));
    } finally {
      clearTimeout(timeout);
      if (postAbortRef.current === controller) postAbortRef.current = null;
      sendingRef.current = false;
      if (activeRef.current) { setSending(false); textareaRef.current?.focus(); }
    }
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = composer.trim();
    if (!text || sendingRef.current || recovered.error) return;
    const envelope = { id: crypto.randomUUID(), text, occurredAt: new Date().toISOString() };
    if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 65_536) { setComposerError('消息太长，请缩短后再发送（上限约 64 KB）'); return; }
    setComposerError(null);
    scrollToLatest();
    void sendEnvelope(envelope);
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); }
  };
  const openSettings = () => { if (window.location.hash === '#settings') return; closingSettingsRef.current = false; window.history.pushState({ ...window.history.state, miraSettings: true }, '', '#settings'); setSettingsOpen(true); };
  const closeSettings = () => {
    if (closingSettingsRef.current) return;
    closingSettingsRef.current = true;
    if (window.history.state?.miraSettings) window.history.back();
    else { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`); closingSettingsRef.current = false; setSettingsOpen(false); }
  };
  const stateLabel = connectionError ? '连接中断' : !status ? '正在连接' : ({ idle: '在这里', working: '正在处理', error: '需要留意', stopped: '已停止' } as const)[status.state];
  const showEmpty = !loading && !items.length && !pending.length && !connectionError;
  let lastDate = '';

  return <>
    <div className="mira-app" inert={settingsOpen}>
      <header className="app-header">
        <div className="identity" aria-label="Mira">
          <div className="mira-ring" aria-hidden="true" />
          <h1>Mira</h1>
          <p className="identity-detail"><span className={`status-dot ${status?.state === 'working' ? 'working' : ''} ${connectionError || status?.state === 'error' ? 'warning' : ''}`} />{stateLabel}<span className="detail-divider">·</span>{status?.model ?? (status?.mode === 'synthetic' ? '模拟模式' : '本地连接')}{status?.mode === 'synthetic' && status.model ? <span className="mode-label">模拟</span> : null}</p>
        </div>
        <button ref={settingsButtonRef} className="icon-button settings-button" type="button" onClick={openSettings} aria-label="模型设置" title="模型设置"><SettingsIcon /></button>
      </header>

      <main ref={scrollRef} className="timeline-scroll" onScroll={onScroll} aria-label="与 Mira 的消息记录" tabIndex={0}>
        <div className={`timeline-content ${showEmpty ? 'is-empty' : ''}`}>
          {(connectionError || storageError || status?.error) && <div className="connection-notice" role="status"><span>{storageError ?? connectionError ?? status?.error}</span>{connectionError && <button className="text-button" onClick={() => { void refresh(); }}>重新连接</button>}</div>}
          {loading && <div className="timeline-loading" role="status"><span className="loading-mark" />正在找回我们的消息…</div>}
          {nextCursor && <div className="history-controls"><button className="text-button" onClick={() => { void loadOlder(); }} disabled={loadingOlder}>{loadingOlder ? '正在读取…' : hasHistoryGap ? '补齐尚未读取的消息' : '查看更早的消息'}</button>{hasHistoryGap && <p className="history-gap-note">有一段消息尚未读取，点击后可继续补齐</p>}{olderError && <p className="inline-error" role="alert">{olderError}</p>}</div>}
          {showEmpty && <div className="empty-state"><span className="eyebrow">每一句，都会留在这里</span><h2>和 Mira 说点什么</h2><p>一个想法、一件小事，或今天的心情。</p><p className="empty-note">从这里开始，慢慢聊。</p></div>}
          <div className="message-list" role="log" aria-live="polite" aria-relevant="additions text" aria-label="消息">
            {items.map(item => {
              const date = dateLabel(item.occurredAt); const showDate = date !== lastDate; lastDate = date;
              return <div key={item.id}>
                {showDate && <p className="date-divider">{date}</p>}
                <article data-message-id={item.id} className={`message-row ${item.role}`} aria-label={item.role === 'user' ? '你的消息' : item.role === 'assistant' ? 'Mira 的消息' : '服务通知'}>
                  <div className="message-bubble">{item.text}</div>
                  <time className="message-time" dateTime={item.occurredAt}>{timeLabel(item.occurredAt)}</time>
                </article>
              </div>;
            })}
            {pending.map(message => <article className="message-row user pending-message" key={message.id} aria-label="待确认的消息">
              <div className="message-bubble">{message.text}</div>
              <div className={`message-receipt ${message.state === 'uncertain' ? 'uncertain' : ''}`}>
                {message.state === 'sending' ? '正在发送…' : message.state === 'queued' ? '已接收 · 等待处理' : '接收结果待确认'}
                {message.state === 'uncertain' && <button className="text-button" disabled={sending} onClick={() => { void sendEnvelope({ id: message.id, text: message.text, occurredAt: message.occurredAt }, true); }}>核对并重试</button>}
              </div>
              {message.state === 'uncertain' && <p className="pending-help">{message.error ?? '刷新前的发送尚未确认'}。不会自动重发</p>}
            </article>)}
          </div>
          {tools.length > 0 && <div className="tool-activity" aria-label="工具活动"><span className="activity-label">活动</span>{tools.map(tool => <span className={`tool-chip ${tool.status}`} key={tool.id}><span className="activity-dot" />{tool.name}<span className="tool-state">{toolLabels[tool.status]}</span></span>)}</div>}
          {status?.state === 'working' && !connectionError && <div className="working-indicator" role="status"><span className="working-dots" aria-hidden="true">•••</span>Mira 正在处理</div>}
        </div>
      </main>

      <footer className="composer-section">
        {!nearBottom && <button className="latest-button" type="button" onClick={scrollToLatest}><ChevronDown />回到最新消息</button>}
        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="message-input">给 Mira 发消息</label>
          <textarea ref={textareaRef} id="message-input" placeholder="给 Mira 发消息…" value={composer} onChange={event => { setComposer(event.target.value); setComposerError(null); }} onKeyDown={onComposerKey} rows={1} disabled={sending || !!recovered.error} maxLength={50_000} />
          <button className="send-button" type="submit" disabled={!composer.trim() || sending || !!recovered.error} aria-label={sending ? '正在发送' : '发送消息'} title="发送消息"><ArrowUp /></button>
        </form>
        {composerError && <p className="composer-error" role="alert">{composerError}</p>}
        <p className="composer-caption">Enter 发送<span>·</span>Shift + Enter 换行{status?.mode === 'synthetic' && <><span>·</span>当前为模拟模型</>}</p>
      </footer>
    </div>
    {settingsOpen && <SettingsDialog synthetic={status?.mode === 'synthetic'} onClose={closeSettings} onSaved={() => { void refresh(); }} returnFocus={settingsButtonRef} />}
  </>;
}
