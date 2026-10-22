import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { api, ApiError, errorInfo } from './api.ts';
import { BrowserEmpty, BrowserSwitcher, CheckIcon, CloseIcon, CollapseIcon, ExpandIcon, EyeIcon, HandIcon, InfoIcon, KeyboardIcon, LockIcon, PlugIcon, ReloadIcon, ReopenConfirm, StatusPill, WarnIcon, useDocumentHidden, useMediaQuery } from './BrowserChrome.tsx';
import type { BrowserTone, SwitcherItem } from './BrowserChrome.tsx';
import { BrowserAddressBar, BrowserTabRows, BrowserTabSheet, BrowserTabStrip, useBrowserNavigation } from './BrowserNavigation.tsx';
import { useVisiblePoll } from './useVisiblePoll.ts';
import './browser.css';

const STREAM_CLOSED = '画面连接已断开。若你已接手，控制权会保持，重新连接后可继续。';

interface BrowserStatus {
  id: string;
  state: 'agent' | 'requesting' | 'human' | 'held' | 'returning' | 'unknown' | 'closed';
  epoch: number;
  ownerLabel: string;
  domain: string | null;
  message?: string;
  pressedButtons?: string[];
  cancelledInputs?: number;
  queuedInputs?: number;
  lock?: 'outcome' | 'cleanup';
  replacedBy?: string;
  replaces?: string;
  userActivity?: { navigations: number; tabSwitches: number; domain?: string };
}
interface PointerSample { clientX: number; clientY: number; button: number; detail: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
const replacedClosed = (browser: BrowserStatus) => browser.state === 'closed' && !!browser.replacedBy;
const toneOf = (browser: BrowserStatus): BrowserTone => browser.state === 'human' || browser.state === 'held' ? 'human' : browser.state === 'unknown' ? 'lock' : browser.state === 'closed' ? 'off' : 'agent';
/** Status pill text (role="status", announced on change). */
const pillText = (browser: BrowserStatus): string => ({
  agent: 'Mira 正在操作 · 你在旁观', requesting: '等待当前操作结束…', human: '由你操作 · Mira 已暂停', held: '你仍保留控制权',
  returning: '正在交还 Mira…', unknown: browser.lock === 'outcome' ? '状态待确认 · 只读' : '关闭未确认 · 已锁定', closed: '浏览器已关闭',
})[browser.state];
const shortState: Record<BrowserStatus['state'], string> = { agent: 'Mira 操作中', requesting: '等待当前操作结束', human: '由你操作', held: '你仍保留控制权', returning: '正在交还', unknown: '状态待确认', closed: '已关闭' };
const buttonNames: Record<string, string> = { left: '左键', middle: '中键', right: '右键' };
// Pointer scaling and CDP modifier/key mappings adapted from agent-browser v0.39.1
// packages/dashboard/src/components/viewport.tsx (Apache-2.0; see third-party notices).
function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
const sample = (event: PointerEvent | { clientX: number; clientY: number; button: number; detail: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): PointerSample => ({ clientX: event.clientX, clientY: event.clientY, button: event.button, detail: event.detail, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey });
const insecureRemote = () => window.location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

function PanelHead({ standalone, phone, onClose, switcher, pill, actions, view }: { standalone: boolean; phone: boolean; onClose?: () => void; switcher: ReactNode; pill: ReactNode; actions?: ReactNode; view?: ReactNode }) {
  const close = standalone && onClose ? <button type="button" className="bp-ib" aria-label="关闭浏览器" onClick={onClose}><CloseIcon /></button> : null;
  return <header className="bp-head">
    {phone && close}
    <div className="bp-title">{standalone ? <h2 id="browser-dialog-title">浏览器</h2> : <h3>浏览器</h3>}{switcher}</div>
    {!phone && pill}
    <div className="bp-acts">{!phone && actions}{view && (phone ? view : <><span className="bp-sep" aria-hidden="true" />{view}</>)}{!phone && close}</div>
  </header>;
}

/** Browser panel (standalone near-fullscreen dialog or Settings → 浏览器).
 * `preferOwner` selects that owner's browser first (the header entry opens
 * Mira's own browser); `standalone` renders the dialog title and close. */
export function BrowserPanel({ active, preferOwner, standalone = false, onClose }: { active: boolean; preferOwner?: string; standalone?: boolean; onClose?: () => void }) {
  const [browsers, setBrowsers] = useState<BrowserStatus[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});
  const phone = useMediaQuery('(max-width: 599px)');
  const statusRevision = useRef(0);
  useVisiblePoll(active, async signal => {
    const revision = statusRevision.current;
    try {
      const result = await api<{ browsers: BrowserStatus[] }>('/api/browser', { signal });
      if (signal.aborted || revision !== statusRevision.current) return;
      setBrowsers(result.browsers); setLoaded(true); setError(null);
      setSelected(current => {
        const chosen = result.browsers.find(browser => browser.id === current);
        const redirected = chosen && replacedClosed(chosen) && result.browsers.some(browser => browser.id === chosen.replacedBy && !replacedClosed(browser)) ? chosen.replacedBy! : current;
        if (result.browsers.some(browser => browser.id === redirected && !replacedClosed(browser))) return redirected;
        return (preferOwner ? result.browsers.find(browser => browser.ownerLabel === preferOwner && !replacedClosed(browser)) : undefined)?.id ?? result.browsers.find(browser => !replacedClosed(browser))?.id ?? '';
      });
    } catch { if (!signal.aborted && revision === statusRevision.current) { setLoaded(true); setError('暂时无法读取浏览器状态，请重试。'); } }
  }, 2500, version);
  const visible = browsers.filter(item => !replacedClosed(item));
  const browser = visible.find(item => item.id === selected);
  const items: SwitcherItem[] = visible.map((item, index) => ({ id: item.id, name: `${item.ownerLabel || 'Mira'} 的浏览器 ${visible.slice(0, index + 1).filter(other => other.ownerLabel === item.ownerLabel).length}`, short: `浏览器 ${index + 1}`, tone: toneOf(item),
    detail: [item.domain ?? '空白页', tabCounts[item.id] ? `${tabCounts[item.id]} 个标签页` : null, shortState[item.state]].filter(Boolean).join(' · ') }));
  const switcher = visible.length > 0 ? <BrowserSwitcher items={items} selected={selected} onSelect={setSelected} compact={phone} {...(browser && tabCounts[browser.id] ? { subtitle: `${tabCounts[browser.id]} 个标签页` } : {})} /> : null;
  const shell = `bp-panel${standalone ? ' is-standalone' : ' is-embedded'}${phone ? ' is-phone' : ''}`;
  if (!active || !browser) return <div className={shell}>
    <PanelHead standalone={standalone} phone={phone} {...(onClose ? { onClose } : {})} switcher={switcher} pill={<StatusPill tone="off">{loaded ? (error ? '状态未知' : '暂无浏览器') : '正在读取…'}</StatusPill>} />
    {error && <div className="bp-banner is-error" role="alert"><WarnIcon /><div>{error}</div><div className="bp-banner-acts"><button type="button" className="bp-btn" onClick={() => setVersion(value => value + 1)}>重试</button></div></div>}
    {!loaded && <div className="bp-stage"><p className="bp-placeholder" role="status">正在读取浏览器…</p></div>}
    {loaded && !error && <BrowserEmpty />}
    {phone && loaded && <div className="bp-pbar"><div className="bp-srow"><StatusPill tone="off">{error ? '状态未知' : '暂无浏览器'}</StatusPill></div></div>}
  </div>;
  return <BrowserSession key={browser.id} browser={browser} switcher={switcher} phone={phone} standalone={standalone} shell={shell} {...(onClose ? { onClose } : {})}
    onTabCount={count => setTabCounts(current => current[browser.id] === count ? current : { ...current, [browser.id]: count })}
    onStatus={next => { statusRevision.current += 1; setBrowsers(current => current.map(item => item.id === next.id && item.epoch <= next.epoch ? next : item)); }}
    onReplace={fresh => { statusRevision.current += 1; setBrowsers(current => { const next = current.map(item => item.id === fresh.replaces ? { ...item, state: 'closed' as const, replacedBy: fresh.id } : item); return next.some(item => item.id === fresh.id) ? next.map(item => item.id === fresh.id ? fresh : item) : [...next, fresh]; }); setSelected(fresh.id); setVersion(value => value + 1); }} />;
}

function BrowserSession({ browser, switcher, phone, standalone, shell, onClose, onStatus, onReplace, onTabCount }: { browser: BrowserStatus; switcher: ReactNode; phone: boolean; standalone: boolean; shell: string; onClose?: () => void; onStatus: (browser: BrowserStatus) => void; onReplace: (browser: BrowserStatus) => void; onTabCount: (count: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bridgeRef = useRef<HTMLTextAreaElement>(null);
  const reopenButtonRef = useRef<HTMLButtonElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const browserRef = useRef(browser); browserRef.current = browser;
  const statusRef = useRef(onStatus); statusRef.current = onStatus;
  const replaceRef = useRef(onReplace); replaceRef.current = onReplace;
  const readyRef = useRef(false);
  const composingRef = useRef(false);
  const pressedRef = useRef(false);
  const pressedButtonRef = useRef(0);
  const pressedClickCountRef = useRef(1);
  const mouseButtonsRef = useRef(new Map<number, number>());
  const mousePointerIdRef = useRef<number | null>(null);
  const compositionCommitRef = useRef<string | null>(null);
  const renderedRef = useRef<{ epoch: number; generation: number; seq: number; width: number; height: number } | null>(null);
  const generationRef = useRef(-1);
  const aliveRef = useRef(true);
  // HTTP control requests outlive an individual stream (reopen closes it before
  // returning). Only unmounting this keyed browser session invalidates them.
  useLayoutEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // Epoch before the user's own takeover/return; cleared once a stream for the
  // newer epoch renders (it survived) or after one automatic reconnect.
  const followEpochRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const connected = phase === 'open';
  const setConnected = (value: boolean) => setPhase(value ? 'open' : 'closed');
  const [hasFrame, setHasFrame] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [lockNotice, setLockNotice] = useState(false);
  const report = (summary: string | null, detail: string | null = null) => { setError(summary); setErrorDetail(detail); };
  const [confirming, setConfirming] = useState(false);
  const [ratio, setRatio] = useState(1.6);
  const [reopening, setReopening] = useState(false);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [currentDomain, setCurrentDomain] = useState(browser.domain);
  const [navPending, setNavPending] = useState(false);
  const navPendingRef = useRef(false);
  const navErrorRef = useRef(false);
  const navigation = useBrowserNavigation();
  const navigationRef = useRef(navigation); navigationRef.current = navigation;
  const clearInput = () => { pressedRef.current = false; mouseButtonsRef.current.clear(); if (bridgeRef.current) bridgeRef.current.value = ''; composingRef.current = false; compositionCommitRef.current = null; };
  // Cleanup-lock and closed browsers never mint tickets. An outcome lock stays
  // viewable and read-only; entering it changes the epoch, so reconnect then.
  const unavailable = browser.state === 'closed' || (browser.state === 'unknown' && browser.lock !== 'outcome');
  const lockEpoch = browser.state === 'unknown' ? browser.epoch : -1;
  useEffect(() => {
    if (unavailable) { setPhase('closed'); setHasFrame(false); return; }
    const controller = new AbortController();
    let socket: WebSocket | null = null;
    let serial = 0;
    let stopped = false;
    generationRef.current = -1;
    readyRef.current = false; renderedRef.current = null; setPhase('connecting'); setHasFrame(false); clearInput();
    navigationRef.current.reset(); navPendingRef.current = false; setNavPending(false); navErrorRef.current = false;
    const invalidate = () => { serial += 1; readyRef.current = false; renderedRef.current = null; setHasFrame(false); clearInput(); canvasRef.current?.getContext('2d')?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height); };
    void api<{ ticket: string; epoch: number }>(`/api/browser/${encodeURIComponent(browser.id)}/ticket`, { method: 'POST', body: '{}', signal: controller.signal }).then(result => {
      if (stopped) return;
      const url = new URL('/api/browser/stream', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url, ['mira-browser', result.ticket]); socketRef.current = socket;
      socket.onopen = () => { if (!stopped) { setConnected(true); report(null); } };
      socket.onmessage = event => {
        if (stopped || typeof event.data !== 'string') return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
        if (message.type === 'mira_state') {
          const next = message.browser as BrowserStatus;
          if (!next || next.id !== browser.id || !Number.isSafeInteger(next.epoch) || next.epoch < browserRef.current.epoch) return;
          if (next.epoch !== browserRef.current.epoch || next.state !== browserRef.current.state) invalidate();
          browserRef.current = next; statusRef.current(next); return;
        }
        if (message.type === 'nav_done') { navPendingRef.current = false; setNavPending(false); return; }
        if (message.type === 'nav_error') {
          navPendingRef.current = false; setNavPending(false); navErrorRef.current = true;
          report('浏览器导航未完成', typeof message.message === 'string' && message.message ? message.message : null);
          return;
        }
        if (message.type === 'tab_list') {
          // Title or background-tab update on the same page: list only, the rendered frame stays valid.
          if (Number.isSafeInteger(message.generation) && (message.generation as number) >= generationRef.current) navigationRef.current.onStreamMessage({ type: 'tabs', tabs: message.tabs });
          return;
        }
        if (message.type === 'tabs' || message.type === 'url') {
          invalidate();
          navPendingRef.current = false; setNavPending(false);
          navigationRef.current.onStreamMessage(message);
          if (message.type === 'url') setCurrentDomain(typeof message.domain === 'string' ? message.domain : null);
          else if (Array.isArray(message.tabs)) { const tab = message.tabs.find((item: { active?: boolean }) => item?.active) as { domain?: unknown } | undefined; if (tab) setCurrentDomain(typeof tab.domain === 'string' ? tab.domain : null); }
          if (Number.isSafeInteger(message.generation)) generationRef.current = Math.max(generationRef.current, message.generation as number);
          return;
        }
        if (message.type !== 'frame' || typeof message.data !== 'string' || typeof message.seq !== 'number' || !Number.isSafeInteger(message.generation) || message.epoch !== browserRef.current.epoch) return;
        const epoch = message.epoch as number; const seq = message.seq; const streamGeneration = message.generation as number;
        if (streamGeneration < generationRef.current) return;
        if (streamGeneration !== generationRef.current) { invalidate(); generationRef.current = streamGeneration; }
        if (renderedRef.current && renderedRef.current.epoch === epoch && seq <= renderedRef.current.seq) return;
        const generation = ++serial;
        const image = new Image();
        image.onload = () => {
          if (stopped || generation !== serial || epoch !== browserRef.current.epoch) return;
          const canvas = canvasRef.current; const context = canvas?.getContext('2d');
          if (!canvas || !context || !image.naturalWidth || !image.naturalHeight) return;
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; context.drawImage(image, 0, 0);
          const metadata = message.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
          if (followEpochRef.current !== null && epoch > followEpochRef.current) followEpochRef.current = null;
          renderedRef.current = { epoch, generation: streamGeneration, seq, width: metadata?.deviceWidth || image.naturalWidth, height: metadata?.deviceHeight || image.naturalHeight }; readyRef.current = true; setHasFrame(true);
          const nextRatio = Math.round(renderedRef.current.width / renderedRef.current.height * 1000) / 1000; if (Number.isFinite(nextRatio) && nextRatio > 0) setRatio(nextRatio);
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', seq }));
          image.onload = null; image.onerror = null; image.src = '';
        };
        image.onerror = () => { if (!stopped && generation === serial) { invalidate(); report('画面无法读取，请重新连接。'); } };
        image.src = `data:image/jpeg;base64,${message.data}`;
      };
      socket.onclose = () => { if (stopped) return; invalidate(); setConnected(false); if (!navErrorRef.current) report(STREAM_CLOSED); };
      socket.onerror = () => { if (!stopped) report('暂时无法连接浏览器画面。'); };
    }).catch(() => { if (!stopped) { setPhase('closed'); report('暂时无法连接浏览器画面，请重试。'); } });
    return () => { stopped = true; controller.abort(); invalidate(); socket?.close(); socketRef.current = null; };
  }, [browser.id, connectionVersion, unavailable, lockEpoch]);

  useLayoutEffect(() => { readyRef.current = false; renderedRef.current = null; clearInput(); }, [browser.epoch, browser.state]);
  // The server closes epoch-bound streams on every control change. After the
  // user's own takeover/return, reconnect once the new epoch is viewable instead
  // of leaving a "connection lost" error and a manual reconnect step.
  useEffect(() => {
    const from = followEpochRef.current;
    if (from === null || connected || browser.epoch <= from || !['agent', 'human', 'held'].includes(browser.state)) return;
    followEpochRef.current = null; report(null); setConnectionVersion(value => value + 1);
  }, [browser.epoch, browser.state, connected]);
  const send = (payload: Record<string, unknown>) => {
    const frame = renderedRef.current; const socket = socketRef.current; const current = browserRef.current;
    if (busyRef.current || !readyRef.current || !frame || frame.epoch !== current.epoch || current.state !== 'human' || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ ...payload, epoch: current.epoch, generation: frame.generation, frameSeq: frame.seq }));
  };
  const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (browserRef.current.state !== 'human' || !readyRef.current) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect(); const frame = renderedRef.current;
      if (!frame || !rect.width || !rect.height) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
      sendRef.current({ type: 'input_mouse', eventType: 'mouseWheel', x: (event.clientX - rect.left) * frame.width / rect.width, y: (event.clientY - rect.top) * frame.height / rect.height, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit, button: 'none', modifiers: modifiers(event) });
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, []);
  const text = (value: string) => {
    if (new TextEncoder().encode(value).length > 4096) report('一次输入或粘贴最多支持 4096 字节，请分段输入。');
    else if (value) send({ type: 'input_text', text: value });
    clearInput();
  };
  const mouse = (event: PointerSample, eventType: string, button = eventType === 'mouseReleased' ? pressedButtonRef.current : event.button, clickCount = pressedClickCountRef.current) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    if (eventType === 'mousePressed' && browserRef.current.state === 'human') bridgeRef.current?.focus({ preventScroll: true });
    const width = renderedRef.current?.width ?? canvas.width, height = renderedRef.current?.height ?? canvas.height;
    // Pointer capture continues outside the canvas; keep a legitimate drag/release
    // at the nearest viewport edge rather than sending invalid coordinates.
    const x = Math.max(0, Math.min(width, Math.round((event.clientX - rect.left) * width / rect.width)));
    const y = Math.max(0, Math.min(height, Math.round((event.clientY - rect.top) * height / rect.height)));
    send({ type: 'input_mouse', eventType, x, y, button: ['left', 'middle', 'right'][button] ?? 'none', clickCount: eventType === 'mouseMoved' ? 0 : clickCount, modifiers: modifiers(event) });
  };
  const releasePointer = (event: PointerSample) => {
    if (!pressedRef.current) return; pressedRef.current = false; mouse(event, 'mouseReleased');
  };
  const releaseMouse = (event: PointerSample) => {
    const clickCount = mouseButtonsRef.current.get(event.button);
    if (clickCount === undefined) return;
    mouseButtonsRef.current.delete(event.button);
    mouse(event, 'mouseReleased', event.button, clickCount);
  };
  // Cancellation/capture loss does not mean the user released the button.
  // Keep the remote press intact so return stays held until an explicit release.
  const abandonPointer = () => { pressedRef.current = false; mouseButtonsRef.current.clear(); };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>, eventType: string) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.key === 'Process') return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearInput(); bridgeRef.current?.blur(); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    event.preventDefault(); event.stopPropagation();
    if (eventType !== 'keyDown' || ['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return;
    if (!/^(?:Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|[a-zA-Z0-9])$/.test(event.key)) { report('此按键暂不支持；可使用普通文本输入或粘贴。'); return; }
    send({ type: 'input_key', key: event.key, modifiers: modifiers(event) });
  };
  const changeControl = async (action: 'takeover' | 'return') => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); report(null); setLockNotice(false); readyRef.current = false; clearInput();
    followEpochRef.current = browserRef.current.epoch;
    try {
      const next = await api<BrowserStatus>(`/api/browser/${encodeURIComponent(browser.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'return' ? { epoch: browserRef.current.epoch } : {}) });
      if (aliveRef.current && next.epoch >= browserRef.current.epoch) { browserRef.current = next; statusRef.current(next); }
    } catch (caught) {
      followEpochRef.current = null;
      if (aliveRef.current && caught instanceof ApiError && caught.status === 409 && caught.code === 'browser_locked') {
        setLockNotice(true);
        try {
          const listed = await api<{ browsers: BrowserStatus[] }>('/api/browser');
          const next = listed.browsers.find(item => item.id === browser.id);
          if (aliveRef.current && next && next.epoch >= browserRef.current.epoch) { browserRef.current = next; statusRef.current(next); }
        } catch { /* the status poll will catch up */ }
      } else {
        socketRef.current?.close();
        if (aliveRef.current) report('操作结果尚未确认，请刷新状态后再试。');
      }
    }
    finally { busyRef.current = false; if (aliveRef.current) setBusy(false); }
  };
  const confirmReopen = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setReopening(true); report(null);
    const previous = browserRef.current;
    try {
      const fresh = await api<BrowserStatus>(`/api/browser/${encodeURIComponent(previous.id)}/reopen`, { method: 'POST', body: JSON.stringify({ epoch: previous.epoch }) });
      if (!aliveRef.current) return;
      const { lock: _lock, ...rest } = previous;
      statusRef.current({ ...rest, state: 'closed', replacedBy: fresh.id, epoch: previous.epoch + 1 });
      replaceRef.current(fresh);
    } catch (caught) {
      if (!aliveRef.current) return;
      const info = errorInfo(caught); report(info.summary, info.detail); setConfirming(false); reopenButtonRef.current?.focus();
    } finally { busyRef.current = false; if (aliveRef.current) setReopening(false); }
  };
  const address = currentDomain || browser.domain || '原地址';
  const navEnabled = browser.state === 'human' && connected && hasFrame;
  const beginNav = (payload: Record<string, unknown>) => {
    const socket = socketRef.current; const current = browserRef.current;
    if (navPendingRef.current || current.state !== 'human' || !connected || !hasFrame || socket?.readyState !== WebSocket.OPEN) return;
    navPendingRef.current = true; setNavPending(true); navErrorRef.current = false; report(null);
    socket.send(JSON.stringify({ ...payload, epoch: current.epoch }));
  };
  // --- presentation state (redesign v2) ---
  const hidden = useDocumentHidden();
  const [keyboard, setKeyboard] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabCountRef = useRef<HTMLButtonElement>(null);
  const tabCount = useRef(onTabCount); tabCount.current = onTabCount;
  useEffect(() => { tabCount.current(navigation.tabs.length); }, [navigation.tabs.length]);
  useEffect(() => { if (!phone) { setZoomed(false); setSheet(false); } }, [phone]);
  // Opening the panel focuses the primary action once (design §4), unless the
  // user already moved focus somewhere specific.
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || !standalone || !primaryRef.current) return;
    focusedOnce.current = true;
    const activeElement = document.activeElement;
    if (!activeElement || activeElement === document.body || activeElement.closest('.bp-head') && !activeElement.closest('.bp-switcher')) primaryRef.current.focus();
  });
  // Phone 2× zoom: one finger still taps/types; a second finger within 120 ms
  // turns the gesture into a pan of the stage and nothing is sent.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const pendingRef = useRef<{ timer: number; sample: PointerSample; pointerId: number } | null>(null);
  const midpoint = () => { const points = [...touchesRef.current.values()]; return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length }; };
  const press = (value: PointerSample, pointerId: number, target: HTMLCanvasElement) => {
    if (browserRef.current.state !== 'human' || !readyRef.current) return;
    pressedRef.current = true; pressedButtonRef.current = value.button;
    pressedClickCountRef.current = Math.min(2, Math.max(1, value.detail));
    try { target.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    mouse(value, 'mousePressed');
  };
  const pressMouse = (value: PointerSample, target: HTMLCanvasElement) => {
    if (browserRef.current.state !== 'human' || !readyRef.current || mousePointerIdRef.current === null) return;
    const clickCount = Math.min(2, Math.max(1, value.detail));
    mouseButtonsRef.current.set(value.button, clickCount);
    try { target.setPointerCapture(mousePointerIdRef.current); } catch { /* pointer already gone */ }
    mouse(value, 'mousePressed', value.button, clickCount);
  };
  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    // Chromium pointer events have detail=0. Keep the native mouse event so its
    // click count uses the browser's own double-click timing and distance rules.
    if (event.pointerType === 'mouse') { mousePointerIdRef.current = event.pointerId; return; }
    event.preventDefault();
    if (zoomed && event.pointerType === 'touch') {
      touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchesRef.current.size >= 2) { if (pendingRef.current) { clearTimeout(pendingRef.current.timer); pendingRef.current = null; } panRef.current = midpoint(); return; }
      if (browserRef.current.state !== 'human' || !readyRef.current) return;
      const value = sample(event); const target = event.currentTarget; const pointerId = event.pointerId;
      pendingRef.current = { sample: value, pointerId, timer: window.setTimeout(() => { pendingRef.current = null; press(value, pointerId, target); }, 120) };
      return;
    }
    press(sample(event), event.pointerId, event.currentTarget);
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (touchesRef.current.has(event.pointerId)) {
      touchesRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (panRef.current) { const next = midpoint(); stageRef.current?.scrollBy(panRef.current.x - next.x, panRef.current.y - next.y); panRef.current = next; return; }
      if (pendingRef.current) return;
    }
    mouse(sample(event), 'mouseMoved');
  };
  const pointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    // Mouse pointerup only fires for the final button. Release it before native
    // capture loss, then let mouseup release intermediate buttons (or no-op).
    if (event.pointerType === 'mouse') {
      releaseMouse(sample(event));
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const wasTouch = touchesRef.current.delete(event.pointerId);
    if (panRef.current) { if (touchesRef.current.size === 0) panRef.current = null; return; }
    if (wasTouch && pendingRef.current?.pointerId === event.pointerId) { const pending = pendingRef.current; clearTimeout(pending.timer); pendingRef.current = null; press(pending.sample, event.pointerId, event.currentTarget); }
    releasePointer(sample(event));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerCancel = (event: PointerEvent<HTMLCanvasElement>) => {
    touchesRef.current.delete(event.pointerId); if (touchesRef.current.size === 0) panRef.current = null;
    if (pendingRef.current?.pointerId === event.pointerId) { clearTimeout(pendingRef.current.timer); pendingRef.current = null; }
    abandonPointer();
  };
  useEffect(() => () => { if (pendingRef.current) clearTimeout(pendingRef.current.timer); }, []);

  const state = browser.state;
  const tone = toneOf(browser);
  const locked = state === 'unknown';
  const offline = phase === 'closed' && !hasFrame;
  const zoomAvailable = !unavailable && hasFrame && !offline;
  useEffect(() => { if (!zoomAvailable) setZoomed(false); }, [zoomAvailable]);
  useLayoutEffect(() => { if (lockNotice && locked) reopenButtonRef.current?.focus(); }, [lockNotice, locked]);
  const mode = unavailable || offline ? 'off' : tone === 'agent' ? 'ai' : tone === 'human' ? 'user' : tone === 'lock' ? 'lock' : 'off';
  const pill = <StatusPill tone={tone}>{pillText(browser)}</StatusPill>;
  const releaseButtons = state === 'human' ? (browser.pressedButtons ?? []).map(button => <button key={button} type="button" className="bp-btn" disabled={!connected || !hasFrame} onClick={() => send({ type: 'input_release', button })}>松开{buttonNames[button] ?? '鼠标'}</button>) : [];
  const reconnect = <button type="button" className="bp-btn" disabled={busy || reopening} onClick={() => setConnectionVersion(value => value + 1)}><ReloadIcon />重新连接</button>;
  const secondary = state === 'held' ? (offline ? reconnect : <button type="button" className="bp-btn" disabled={busy || reopening} onClick={() => void changeControl('takeover')}><HandIcon />继续接手</button>)
    : (offline && !unavailable) ? reconnect : null;
  const primary = state === 'agent' ? <button ref={primaryRef} type="button" className="bp-btn is-primary" disabled={busy || reopening} onClick={() => void changeControl('takeover')}><HandIcon />接手操作</button>
    : state === 'requesting' ? <button ref={primaryRef} type="button" className="bp-btn" disabled={busy || reopening} onClick={() => void changeControl('return')}>交还 Mira</button>
    : state === 'human' || state === 'held' ? <button ref={primaryRef} type="button" className="bp-btn is-primary" disabled={busy || reopening} onClick={() => void changeControl('return')}><CheckIcon />交还 Mira</button>
    : state === 'returning' ? <button ref={primaryRef} type="button" className="bp-btn is-primary" disabled><CheckIcon />交还 Mira</button>
    : locked ? <button ref={node => { reopenButtonRef.current = node; primaryRef.current = node; }} type="button" className="bp-btn is-danger" disabled={reopening} aria-haspopup="dialog" aria-expanded={confirming} onClick={() => { report(null); setLockNotice(false); setConfirming(true); }}><ReloadIcon />关闭并重开浏览器</button>
    : null;
  const actions = <>{releaseButtons}{secondary}{primary}</>;
  const view = phone
    ? <button type="button" className="bp-ib" aria-label={zoomed ? '缩小画面' : '放大画面'} aria-pressed={zoomed} disabled={!zoomAvailable} onClick={() => setZoomed(value => !value)}>{zoomed ? <CollapseIcon /> : <ExpandIcon />}</button>
    : <button type="button" className="bp-ib" aria-label={focusMode ? '退出专注画面' : '专注画面'} title={focusMode ? '退出专注画面' : '专注画面（隐藏标签页和地址栏）'} aria-pressed={focusMode} disabled={unavailable} onClick={() => setFocusMode(value => !value)}>{focusMode ? <CollapseIcon /> : <ExpandIcon />}</button>;
  const chromeHint = locked ? '已锁定 · 不能切换标签页或输入网址' : state === 'held' ? '继续接手后可切换标签页、输入网址' : state === 'human' && !navEnabled ? '画面连接后可切换标签页、输入网址' : state === 'human' ? undefined : '接手后可切换标签页、输入网址';
  const closeWord = standalone ? '关闭此窗口' : '关闭设置';
  const banners: ReactNode[] = [];
  if (insecureRemote()) banners.push(<div key="insecure" className="bp-banner is-amber" role="status"><WarnIcon /><div>当前远程连接未加密。输入账号密码前，请使用 HTTPS 连接 Mira。</div></div>);
  if (locked && browser.lock === 'outcome') banners.push(<div key="lock" className="bp-banner is-amber" role="status"><WarnIcon /><div><b>上一次操作没有确认结果，浏览器已锁定。</b>你可以只读查看当前画面，核对页面是否已经提交；在关闭并重开之前，你和 Mira 都不能再操作它，以免重复提交。</div></div>);
  if (locked && browser.lock !== 'outcome') banners.push(<div key="cleanup" className="bp-banner is-amber" role="status"><WarnIcon /><div><b>浏览器关闭未能确认。</b>画面已停止，可以重试关闭并重开。</div></div>);
  if (lockNotice && locked) banners.push(<div key="lock-takeover" className="bp-banner" role="status"><InfoIcon /><div>这个浏览器已锁定，不能接手。可以关闭并重开。</div></div>);
  if (state === 'closed') banners.push(<div key="closed" className="bp-banner" role="status"><InfoIcon /><div>这个浏览器已关闭。</div></div>);
  if ((state === 'held' || state === 'human') && offline) banners.push(<div key="offline" className="bp-banner is-blue" role="status"><PlugIcon /><div><b>画面连接中断，你仍保留着控制权。</b>{state === 'held' ? '上次关闭窗口或断网时没有交还，Mira 正在等你。' : ''}重新连接、看到最新画面后再继续操作。</div></div>);
  else if (state === 'held') banners.push(<div key="held" className="bp-banner is-blue" role="status"><HandIcon /><div><b>你仍保留着控制权。</b>上次关闭窗口或断网时没有交还，Mira 正在等你。点「继续接手」看到最新画面后再操作，或直接交还。</div></div>);
  if (browser.cancelledInputs) banners.push(<div key="cancelled" className="bp-banner is-blue" role="status"><InfoIcon /><div>已取消 {browser.cancelledInputs} 条尚未发送的输入。请核对页面结果，不要重复提交。</div></div>);
  if (state === 'returning' && browser.queuedInputs) banners.push(<div key="queued" className="bp-banner" role="status"><InfoIcon /><div>正在取消尚未发送的输入，并等待当前操作响应。</div></div>);
  if (browser.pressedButtons?.length) banners.push(<div key="pressed" className="bp-banner is-blue" role="status"><InfoIcon /><div>鼠标仍处于按下状态，暂不能交还。请继续接手，看到当前画面后显式松开鼠标。</div></div>);
  if (!locked && state !== 'closed' && browser.message && !browser.replaces && !browser.userActivity) banners.push(<div key="message" className="bp-banner" role="status"><InfoIcon /><div className="bp-banner-detail">{browser.message}</div></div>);
  // The held/offline banner already says the stream dropped; don't repeat it as an error.
  if (error && !((state === 'held' || state === 'human') && offline && error === STREAM_CLOSED)) banners.push(<div key="error" className="bp-banner is-error" role="alert"><WarnIcon /><div><span>{error}</span>{errorDetail && <span className="bp-error-detail">{errorDetail}</span>}</div></div>);
  const tag = mode === 'ai' && hasFrame ? <span className="bp-tag is-bl"><EyeIcon />{phone ? '只读 · 实时' : '只读画面 · Mira 实时操作中'}</span>
    : mode === 'user' && keyboard ? <span className="bp-tag is-blue is-br"><KeyboardIcon />{phone ? `键盘已连接${zoomed ? ' · 2× 放大' : ''}` : '键盘已连接 · 按 Esc 释放'}</span>
    : mode === 'user' && zoomed ? <span className="bp-tag is-blue is-br">2× 放大</span>
    : mode === 'lock' && hasFrame ? <span className="bp-tag is-amber is-bl"><LockIcon />只读查看 · 已锁定</span> : null;
  const placeholder = unavailable ? (state === 'closed' ? '这个浏览器已关闭' : '关闭未确认，画面已停止')
    : offline ? null : !hasFrame ? (connected ? '等待当前页面画面…' : '正在连接画面…') : null;
  const showRows = phone && !zoomed && state !== 'human' && navigation.tabs.length > 0 && !unavailable;
  const footer = locked ? <span className="bp-foot-i"><InfoIcon />{closeWord}不会改变锁定状态</span>
    : state === 'human' ? <><span className="bp-foot-i"><KeyboardIcon />点击画面后可直接输入或粘贴文字 · <kbd>Esc</kbd> 释放键盘</span><span className="bp-foot-i bp-foot-r"><InfoIcon />{closeWord}不会自动交还，Mira 会一直等你点「交还 Mira」</span></>
    : state === 'held' ? <span className="bp-foot-i"><InfoIcon />{closeWord}不会自动交还；点「继续接手」看到最新画面后再操作</span>
    : state === 'closed' ? <span className="bp-foot-i"><InfoIcon />这个浏览器已关闭</span>
    : <><span className="bp-foot-i"><InfoIcon />接手后 Mira 会在当前这一步结束后暂停，等你交还再继续。</span><span className="bp-foot-r">文件选择、上传和下载暂不支持</span></>;
  const phoneNote = locked ? '已锁定：只能查看，不能操作。关闭窗口不会改变锁定状态。'
    : state === 'human' ? `点击画面输入文字${zoomed ? '；双指拖动查看其他区域' : ''}。关闭窗口不会自动交还。`
    : state === 'held' ? '你仍保留控制权。继续接手看到最新画面后再操作，或直接交还。'
    : state === 'closed' ? '这个浏览器已关闭。' : 'Mira 操作时画面只读。接手后可切换标签页、输入网址。';
  const tabsButton = <button ref={tabCountRef} type="button" className={`bp-tabcount${navEnabled ? ' is-live' : ''}`} aria-label={`标签页列表，共 ${navigation.tabs.length} 个`} aria-haspopup="dialog" onClick={() => setSheet(true)}>{navigation.tabs.length}</button>;
  const screenStyle = { '--bp-ratio': String(ratio) } as CSSProperties;
  return <div ref={rootRef} className={`${shell} is-${mode}${focusMode ? ' is-focus' : ''}`}>
    <PanelHead standalone={standalone} phone={phone} {...(onClose ? { onClose } : {})} switcher={switcher} pill={pill} actions={actions} view={view} />
    {locked && confirming && <ReopenConfirm domain={address} busy={reopening} onCancel={() => { setConfirming(false); reopenButtonRef.current?.focus(); }} onConfirm={() => void confirmReopen()} />}
    {banners.length > 0 && <div className="bp-banners">{banners}</div>}
    {!unavailable && !focusMode && (phone
      ? <div className="bp-chrome is-phone"><BrowserAddressBar url={navigation.url} enabled={navEnabled} pending={navPending} onNavigate={url => beginNav({ type: 'nav_open', url })} {...(chromeHint ? { hint: chromeHint } : {})} trailing={tabsButton} /></div>
      : <div className={`bp-chrome${navEnabled ? ' is-live' : ''}`}><BrowserTabStrip tabs={navigation.tabs} enabled={navEnabled} pending={navPending} onSwitch={tabId => beginNav({ type: 'nav_tab', tabId })} {...(chromeHint ? { hint: chromeHint } : {})} /><BrowserAddressBar url={navigation.url} enabled={navEnabled} pending={navPending} onNavigate={url => beginNav({ type: 'nav_open', url })} {...(chromeHint ? { hint: chromeHint } : {})} /></div>)}
    <div className="bp-stagewrap">
    <div ref={stageRef} className={`bp-stage${zoomed ? ' is-zoomed' : ''}`}>
      <div className={`bp-screen is-${mode}${hasFrame ? '' : ' is-empty'}${offline || unavailable ? ' is-hidden' : ''}${hidden ? ' is-paused' : ''}`} style={screenStyle}>
        <div className="bp-fx" aria-hidden="true"><i className="bp-glow"><b /></i><i className="bp-ring"><b /></i></div>
        <div className="bp-clip browser-viewport">
          <canvas ref={canvasRef} aria-label="远程浏览器画面" className={hasFrame ? '' : 'browser-canvas-empty'} onPointerDown={pointerDown} onMouseDown={event => { event.preventDefault(); pressMouse(sample(event), event.currentTarget); }} onMouseUp={event => releaseMouse(sample(event))} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={abandonPointer} onContextMenu={event => event.preventDefault()} />
          {placeholder && <span className="bp-placeholder">{placeholder}</span>}
          <textarea ref={bridgeRef} className="browser-input-bridge" aria-label="浏览器键盘输入，按 Escape 离开" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={browser.state !== 'human' || !connected || !hasFrame} onFocus={() => setKeyboard(true)} onKeyDown={event => key(event, 'keyDown')} onKeyUp={event => key(event, 'keyUp')} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={event => { composingRef.current = false; text(event.data); compositionCommitRef.current = event.data; setTimeout(() => { compositionCommitRef.current = null; }, 0); }} onInput={event => {
            if (composingRef.current) return;
            const value = event.currentTarget.value; const committed = compositionCommitRef.current; compositionCommitRef.current = null;
            if (committed !== null && value === committed) { event.currentTarget.value = ''; return; }
            text(value);
          }} onPaste={event => { event.preventDefault(); text(event.clipboardData.getData('text/plain')); }} onBlur={() => { clearInput(); setKeyboard(false); }} />
        </div>
        {!zoomed && tag}
      </div>
      {(offline || (unavailable && state !== 'closed')) && <div className="bp-offline" role="status"><PlugIcon /><b>画面尚未连接</b><span>{unavailable ? '浏览器已锁定，画面已停止' : '连接恢复前不会发送任何输入'}</span></div>}
      {showRows && <>{zoomAvailable && <p className="bp-under">点右上角放大按钮可按 2 倍查看细节。</p>}<BrowserTabRows tabs={navigation.tabs} enabled={false} pending={navPending} onSwitch={() => undefined} header={<div className="bp-tlh"><span>标签页 · {navigation.tabs.length}</span><span className="bp-tlh-hint"><LockIcon />{locked ? '已锁定' : '接手后可切换'}</span></div>} /></>}
    </div>
    {zoomed && tag}
    </div>
    {!phone && !focusMode && <footer className="bp-foot">{footer}</footer>}
    {phone && <div className="bp-pbar">
      <div className="bp-srow">{pill}{releaseButtons}</div>
      <p className="bp-note">{phoneNote}</p>
      <div className="bp-brow">{state === 'human' && <button type="button" className="bp-btn is-sm" disabled={!keyboard} onPointerDown={event => event.preventDefault()} onClick={() => bridgeRef.current?.blur()}>释放键盘</button>}{secondary}{primary}</div>
    </div>}
    {phone && sheet && <BrowserTabSheet tabs={navigation.tabs} enabled={navEnabled} pending={navPending} onSwitch={tabId => beginNav({ type: 'nav_tab', tabId })} onClose={() => { setSheet(false); tabCountRef.current?.focus(); }} />}
  </div>;
}
