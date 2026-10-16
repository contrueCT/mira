import { browserUuid } from './uuid.ts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { AttachmentList, AttachmentPreview } from './Attachments.tsx';
import { useAttachments } from './useAttachments.ts';
import { attachmentSize } from './attachments.ts';
import { api, errorText, isAbort } from './api.ts';
import { createStatusPolling } from './status-polling.ts';
import { ArrowUp, ChevronDown, SettingsIcon } from './icons.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { createMemoryRequest, readMemoryRequest, recoverMemoryRequest, writeMemoryRequest } from './management.ts';
import type { MemoryRequestIdentity } from './management.ts';
import { confirmsPending, replySnippet, timelineSpacing, latestPagination, mergeTimeline, nextHistoryRequest, olderPagination, readPending, reconcilePending, writePending } from './timeline.ts';
import type { HistoryPagination, HistoryRequest } from './timeline.ts';
import type { Attachment, MessageEnvelope, PendingMessage, ReplyReference, ServerStatus, TimelineItem, TimelinePage } from './types.ts';

const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
function timeLabel(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date); }
function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  return new Intl.DateTimeFormat('zh-CN', { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' }).format(date);
}
function initialPending(): { messages: PendingMessage[]; memoryRequest: MemoryRequestIdentity | null; error: string | null } {
  try {
    const messages = readPending(window.sessionStorage);
    const memoryRequest = recoverMemoryRequest(readMemoryRequest(window.sessionStorage), messages);
    return { messages, memoryRequest, error: null };
  }
  catch { return { messages: [], memoryRequest: null, error: '浏览器中的待确认消息无法读取。为避免丢失或重复发送，请先恢复此标签页的存储访问，再刷新页面。' }; }
}

export function App() {
  const [recovered] = useState(initialPending);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>(recovered.messages);
  const [memoryRequest, setMemoryRequest] = useState<MemoryRequestIdentity | null>(recovered.memoryRequest);
  const memoryRequestRef = useRef(memoryRequest);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(recovered.error);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasHistoryGap, setHasHistoryGap] = useState(false);
  const attachments = useAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRegistry = useRef(new Map<string, Attachment>());
  const [previewId, setPreviewId] = useState(() => window.location.hash.startsWith('#attachment=') ? window.location.hash.slice(12) : null);
  const closingPreviewRef = useRef(false);
  const previewFocusRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [composer, setComposer] = useState('');
  const [replyTarget, setReplyTarget] = useState<ReplyReference | null>(null);
  const [quoteSearch, setQuoteSearch] = useState(false);
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null);
  const quoteAbortRef = useRef<AbortController | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
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
  const restoreComposerFocusRef = useRef(false);
  const initializedRef = useRef(false);
  const paginationRef = useRef<HistoryPagination>({ latestCursor: null, oldestCursor: null, gaps: [] });
  const activeRef = useRef(true);
  const olderBusyRef = useRef(false);
  const closingSettingsRef = useRef(false);
  const prependAnchorRef = useRef<{ height: number; top: number; element: HTMLElement | null; offset: number } | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const postAbortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const pollingRef = useRef<ReturnType<typeof createStatusPolling> | null>(null);

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
      if (statusResult.status === 'fulfilled') {
        statusRef.current = statusResult.value; setStatus(statusResult.value);
        pollingRef.current?.statusChanged();
      }
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
    const polling = createStatusPolling(refresh, () => statusRef.current?.state === 'working', () => document.hidden);
    pollingRef.current = polling;
    void polling.poll();
    document.addEventListener('visibilitychange', polling.visibilityChanged);
    return () => {
      polling.stop(); pollingRef.current = null;
      activeRef.current = false; controller.abort(); postAbortRef.current?.abort(); quoteAbortRef.current?.abort();
      inFlightRef.current = null;
      document.removeEventListener('visibilitychange', polling.visibilityChanged);
    };
  }, [refresh]);

  useEffect(() => {
    const sync = () => { closingSettingsRef.current = false; closingPreviewRef.current = false; setSettingsOpen(window.location.hash === '#settings'); setPreviewId(window.location.hash.startsWith('#attachment=') ? window.location.hash.slice(12) : null); };
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
  }, [items, pending, loading]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`; }
  }, [composer]);

  useLayoutEffect(() => {
    if (!sending && restoreComposerFocusRef.current) {
      restoreComposerFocusRef.current = false;
      textareaRef.current?.focus();
    }
  }, [sending]);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const isNear = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    nearBottomRef.current = isNear;
    setNearBottom(isNear);
  };
  const cancelQuoteNavigation = () => {
    const controller = quoteAbortRef.current;
    if (!controller) return;
    // Release only this lookup's ownership before abort callbacks can run.
    quoteAbortRef.current = null;
    controller.abort(); olderBusyRef.current = false;
    setQuoteSearch(false); setLoadingOlder(false); setQuoteNotice(null);
  };
  const scrollToLatest = () => {
    cancelQuoteNavigation();
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

  const sendEnvelope = async (envelope: MessageEnvelope, retry = false, fromMemory = memoryRequestRef.current?.id === envelope.id) => {
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
        if (itemsRef.current.some(item => confirmsPending(envelope, item))) return;
      }
      if (!updatePending(current => [...current.filter(message => message.id !== envelope.id), { ...envelope, state: 'sending' }], true)) return;
      if (fromMemory) writeMemoryRequest(window.sessionStorage, envelope);
      if (!retry && !fromMemory) { setComposer(''); setReplyTarget(null); attachments.clear(); }
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
      if (activeRef.current) { restoreComposerFocusRef.current = !fromMemory; setSending(false); }
    }
  };
  const submitMemory = (text: string): boolean => {
    if (sendingRef.current || recovered.error) return false;
    const envelope = createMemoryRequest(text);
    // Stage the exact ordinary message before tracking it or starting network I/O.
    if (!updatePending(current => [...current, { ...envelope, state: 'uncertain' }], true)) return false;
    const identity = { id: envelope.id, occurredAt: envelope.occurredAt };
    memoryRequestRef.current = identity; setMemoryRequest(identity);
    void sendEnvelope(envelope, false, true);
    return true;
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = composer.trim();
    if ((!text && !attachments.drafts.length) || !attachments.ready || sendingRef.current || recovered.error) return;
    const envelope: MessageEnvelope = { ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}), id: browserUuid(), text, occurredAt: new Date().toISOString(), ...(attachments.attachments.length ? { attachmentIds: attachments.attachments.map(item => item.id) } : {}) };
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
  const addFiles = (files: File[]) => { if (sendingRef.current || recovered.error) return; setComposerError(attachments.add(files)); };
  for (const item of items) for (const attachment of item.attachments ?? []) previewRegistry.current.set(attachment.id, attachment);
  for (const attachment of attachments.attachments) previewRegistry.current.set(attachment.id, attachment);
  const preview = previewId ? previewRegistry.current.get(previewId) : undefined;
  const openPreview = (attachment: Attachment) => {
    previewRegistry.current.set(attachment.id, attachment); closingPreviewRef.current = false;
    previewFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.history.pushState({ ...window.history.state, miraAttachment: true }, '', `#attachment=${attachment.id}`); setPreviewId(attachment.id);
  };
  const closePreview = () => {
    if (closingPreviewRef.current) return; closingPreviewRef.current = true;
    if (window.history.state?.miraAttachment) window.history.back();
    else { window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`); closingPreviewRef.current = false; setPreviewId(null); }
  };
  const stateLabel = connectionError ? '连接中断' : !status ? '正在连接' : ({ idle: '在这里', working: '正在处理', error: '需要留意', stopped: '已停止' } as const)[status.state];
  const showEmpty = !loading && !items.length && !pending.length && !connectionError;
  const beginReply = (item: TimelineItem) => {
    if (item.role !== 'assistant' || sendingRef.current) return;
    cancelQuoteNavigation();
    setReplyTarget({ messageId: item.id, role: item.role, text: item.text, ...(item.attachments?.length ? { attachmentNames: item.attachments.map(file => file.name) } : {}), ...(item.source ? { source: item.source } : {}) });
    textareaRef.current?.focus();
  };
  const jumpToReply = async (messageId: string) => {
    cancelQuoteNavigation();
    setQuoteNotice(null);
    const reveal = () => {
      const target = [...scrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []].find(element => element.dataset['messageId'] === messageId);
      if (!target) return false;
      nearBottomRef.current = false; setNearBottom(false);
      target.scrollIntoView({ block: 'center', behavior: 'instant' }); target.focus({ preventScroll: true }); setHighlightId(messageId);
      return true;
    };
    if (reveal()) return;
    if (olderBusyRef.current) { setQuoteNotice('历史消息正在读取，请稍后再点引用。'); return; }
    const controller = new AbortController(); quoteAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    olderBusyRef.current = true; setLoadingOlder(true); setQuoteSearch(true);
    nearBottomRef.current = false;
    const cursors = new Set<string>();
    try {
      for (let pageCount = 0; pageCount < 8; pageCount++) {
        const request = nextHistoryRequest(paginationRef.current);
        if (!request || cursors.has(request.cursor)) break;
        cursors.add(request.cursor);
        const page = await api<TimelinePage>('/api/timeline', { method: 'POST', body: JSON.stringify({ before: request.cursor }), signal: controller.signal });
        if (!activeRef.current || quoteAbortRef.current !== controller || controller.signal.aborted) return;
        acceptPage(page, request);
        // Wait for React's DOM commit, including the normal prepend anchor correction.
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); });
        if (!activeRef.current || quoteAbortRef.current !== controller) return;
        if (controller.signal.aborted) { setQuoteNotice('查找已停止，引用内容仍保留。'); return; }
        if (reveal()) return;
      }
      setQuoteNotice('暂未找到原消息。可以继续查看更早的消息，再点引用。');
    } catch (error) {
      if (activeRef.current && quoteAbortRef.current === controller) setQuoteNotice(isAbort(error) ? '查找已停止，引用内容仍保留。' : '暂时无法读取原消息，请稍后重试。');
    } finally {
      clearTimeout(timeout);
      if (quoteAbortRef.current === controller) {
        quoteAbortRef.current = null; olderBusyRef.current = false;
        if (activeRef.current) { setQuoteSearch(false); setLoadingOlder(false); }
      }
    }
  };

  return <>
    <div className="mira-app" inert={settingsOpen || !!preview}>
      <header className="app-header">
        <div className="identity" aria-label="Mira">
          <div className="mira-ring" aria-hidden="true" />
          <h1>Mira</h1>
          <p className="identity-detail"><span className={`status-dot ${status?.state === 'working' ? 'working' : ''} ${connectionError || status?.state === 'error' ? 'warning' : ''}`} />{stateLabel}<span className="detail-divider">·</span>{status?.model ?? (status?.mode === 'synthetic' ? '模拟模式' : '本地连接')}{status?.mode === 'synthetic' && status.model ? <span className="mode-label">模拟</span> : null}</p>
        </div>
        <button ref={settingsButtonRef} className="icon-button settings-button" type="button" onClick={openSettings} aria-label="模型设置" title="模型设置"><SettingsIcon /></button>
      </header>

      {(connectionError || storageError || status?.error) && <div className="connection-notice" role="status" tabIndex={0} aria-label="运行状态与错误详情"><span>{!storageError && !connectionError && status?.error && <strong>运行错误 · </strong>}{storageError ?? connectionError ?? status?.error}</span>{connectionError && <button className="text-button" onClick={() => { void refresh(); }}>重新连接</button>}</div>}

      <main ref={scrollRef} className="timeline-scroll" onScroll={onScroll} aria-label="与 Mira 的消息记录" tabIndex={0}>
        <div className={`timeline-content ${showEmpty ? 'is-empty' : ''}`}>
          {loading && <div className="timeline-loading" role="status"><span className="loading-mark" />正在找回我们的消息…</div>}
          {nextCursor && <div className="history-controls"><button className="text-button" onClick={() => { void loadOlder(); }} disabled={loadingOlder}>{loadingOlder ? '正在读取…' : hasHistoryGap ? '补齐尚未读取的消息' : '查看更早的消息'}</button>{hasHistoryGap && <p className="history-gap-note">有一段消息尚未读取，点击后可继续补齐</p>}{olderError && <p className="inline-error" role="alert">{olderError}</p>}</div>}
          {showEmpty && <div className="empty-state"><span className="eyebrow">每一句，都会留在这里</span><h2>和 Mira 说点什么</h2><p>一个想法、一件小事，或今天的心情。</p><p className="empty-note">从这里开始，慢慢聊。</p></div>}
          <div className="message-list" role="log" aria-live="polite" aria-relevant="additions text" aria-label="消息">
            {items.map((item, index) => {
              const spacing = timelineSpacing(items[index - 1], item);
              return <div key={item.id} className={`message-group ${spacing.compact ? 'compact' : ''}`}>
                {spacing.divider && <p className="date-divider">{dateLabel(item.occurredAt)} {timeLabel(item.occurredAt)}</p>}
                <article tabIndex={0} data-message-id={item.id} className={`message-row ${item.role} ${highlightId === item.id ? 'quote-highlight' : ''}`} aria-label={item.source ? `${item.source.label} 扩展消息` : item.role === 'user' ? '你的消息' : item.role === 'assistant' ? 'Mira 的消息' : '服务通知'}>
                  {item.reply && <button type="button" className="reply-quote" aria-label="查看引用的消息" title={replySnippet(item.reply)} disabled={quoteSearch} onClick={() => { void jumpToReply(item.reply!.messageId); }}><span aria-hidden="true">↪</span><span>{replySnippet(item.reply)}</span></button>}
                  <div className="message-content-line">
                  <div className="message-payload">
                  {item.text && <div className="message-bubble">{item.text}</div>}
                  {!!item.attachments?.length && <AttachmentList attachments={item.attachments} onPreview={openPreview} />}
                  </div>
                  <div className="message-side">
                  {item.role === 'assistant' && <button className="reply-action" type="button" aria-label="回复这条消息" title="回复这条消息" disabled={sending} onClick={() => beginReply(item)}>↩</button>}
                  <div className="message-meta">
                  {item.source && <span className="message-source" title={`${item.source.label} · ${item.source.direction === 'inbound' ? '收到' : '已发送'} · 扩展 ${item.source.extensionId}${item.source.senderId ? ` · 来源身份 ${item.source.senderId}${item.source.senderVerified ? '（由扩展验证）' : ''}` : ''}`}>{item.source.label} · {item.source.extensionId} · {item.source.direction === 'inbound' ? '收到' : '已发送'}</span>}
                  <time className="message-time" dateTime={item.occurredAt}>{timeLabel(item.occurredAt)}</time>
                  </div>
                  </div>
                  </div>
                </article>
              </div>;
            })}
            {pending.map(message => <article className="message-row user pending-message" key={message.id} aria-label="待确认的消息">
              {message.replyToMessageId && <p className="reply-quote pending-quote"><span aria-hidden="true">↪</span><span>{(() => { const target = items.find(item => item.id === message.replyToMessageId); return target ? replySnippet({ messageId: target.id, role: 'assistant', text: target.text, attachmentNames: target.attachments?.map(file => file.name) ?? [] }) : '回复原消息'; })()}</span></p>}
              {message.text && <div className="message-bubble">{message.text}</div>}
              {!!message.attachmentIds?.length && <p className="pending-attachments">{message.attachmentIds.length} 个附件 · 已保留，等待消息确认</p>}
              <div className={`message-receipt ${message.state === 'uncertain' ? 'uncertain' : ''}`}>
                {message.state === 'sending' ? '正在发送…' : message.state === 'queued' ? '已接收 · 等待处理' : '接收结果待确认'}
                {message.state === 'uncertain' && <button className="text-button" disabled={sending} onClick={() => { void sendEnvelope({ id: message.id, text: message.text, occurredAt: message.occurredAt, ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}), ...(message.attachmentIds !== undefined ? { attachmentIds: [...message.attachmentIds] } : {}) }, true); }}>核对并重试</button>}
              </div>
              {message.state === 'uncertain' && <p className="pending-help">{message.error ?? '刷新前的发送尚未确认'}。不会自动重发</p>}
            </article>)}
          </div>
          {status?.state === 'working' && !connectionError && <div className="working-indicator" role="status"><span className="working-dots" aria-hidden="true">•••</span>{status.modelRetry ? (status.modelRetry.phase === 'waiting' ? `模型请求暂时失败，等待重试（第 ${status.modelRetry.attempt}/${status.modelRetry.maxAttempts} 次）` : `正在重试模型请求（第 ${status.modelRetry.attempt}/${status.modelRetry.maxAttempts} 次）`) : 'Mira 正在处理'}</div>}
        </div>
      </main>

      <footer className="composer-section">
        {(quoteSearch || quoteNotice) && <p className="quote-search-status" role="status">{quoteSearch ? '正在查找引用消息…' : quoteNotice}{quoteSearch && <button type="button" className="text-button" onClick={() => quoteAbortRef.current?.abort()}>取消查找</button>}</p>}
        {!nearBottom && <button className="latest-button" type="button" onClick={scrollToLatest}><ChevronDown />回到最新消息</button>}
        {replyTarget && <div className="composer-reply" aria-label="回复预览"><span aria-hidden="true">↪</span><span className="composer-reply-text"><strong>回复 {replyTarget.source?.label ?? 'Mira'}</strong><span>{replySnippet(replyTarget)}</span></span><button type="button" aria-label="取消回复" title="取消回复" onClick={() => { setReplyTarget(null); textareaRef.current?.focus(); }}>×</button></div>}
        <form className={`composer ${composer.includes('\n') || attachments.drafts.length ? 'expanded' : ''} ${dragging ? 'dragging' : ''}`} onSubmit={submit}
          onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={event => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); }}
          onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); addFiles(files); } }}>
          <input ref={fileInputRef} className="sr-only" type="file" multiple aria-label="选择附件" tabIndex={-1} onChange={event => { addFiles([...event.target.files ?? []]); event.target.value = ''; }} />
          {!!attachments.drafts.length && <div className="draft-attachments" aria-label="待发送附件">{attachments.drafts.map(draft => <div className="draft-attachment" key={draft.key}>
            {draft.attachment ? <AttachmentList attachments={[draft.attachment]} onPreview={openPreview} /> : <span className="draft-file-name">{draft.file.name}</span>}
            <div className="draft-attachment-detail"><span>{draft.attachment ? draft.attachment.name : attachmentSize(draft.file.size)}</span><button type="button" aria-label={`移除附件 ${draft.file.name}`} disabled={sending} onClick={() => attachments.remove(draft.key)}>×</button></div>
            {draft.error ? <div className="inline-error" role="alert">{draft.error}<button type="button" className="text-button" onClick={() => attachments.retry(draft.key)}>重新上传</button></div> : !draft.attachment && <span role="status">正在上传…</span>}
          </div>)}</div>}
          <button className="add-attachment-button icon-button" type="button" disabled={sending || !!recovered.error} onClick={() => fileInputRef.current?.click()} aria-label="添加附件" title="添加图片、视频或文件">+</button>
          <label className="sr-only" htmlFor="message-input">给 Mira 发消息</label>
          <textarea ref={textareaRef} id="message-input" placeholder="给 Mira 发消息…" value={composer} onChange={event => { setComposer(event.target.value); setComposerError(null); }} onKeyDown={onComposerKey} rows={1} disabled={sending || !!recovered.error} maxLength={50_000} />
          <button className="send-button" type="submit" disabled={(!composer.trim() && !attachments.drafts.length) || !attachments.ready || sending || !!recovered.error} aria-label={sending ? '正在发送' : '发送消息'} title="发送消息"><ArrowUp /></button>
        </form>
        {composerError && <p className="composer-error" role="alert">{composerError}</p>}
        <p className="composer-caption">Enter 发送<span>·</span>Shift + Enter 换行{status?.mode === 'synthetic' && <><span>·</span>当前为模拟模型</>}</p>
      </footer>
    </div>
    {preview && <AttachmentPreview key={preview.id} attachment={preview} onClose={closePreview} returnFocus={previewFocusRef.current} />}
    {settingsOpen && <SettingsDialog synthetic={status?.mode === 'synthetic'} onClose={closeSettings} onSaved={() => { void refresh(); }} returnFocus={settingsButtonRef} memoryRequest={memoryRequest} memoryPending={pending.find(message => message.id === memoryRequest?.id) ?? null} sending={sending} storageError={storageError} onMemorySubmit={submitMemory} onMemoryRetry={message => { void sendEnvelope(message, true, true); }} />}
  </>;
}
