import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { api } from './api.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';
import './browser.css';

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
}
const stateLabels: Record<BrowserStatus['state'], string> = {
  agent: 'Mira 操作中 · 只读查看', requesting: '等待当前操作结束', human: '由你操作',
  held: '连接中断 · 已保留你的控制权', returning: '正在交还 Mira', unknown: '状态待确认', closed: '浏览器已关闭',
};
// Pointer scaling and CDP modifier/key mappings adapted from agent-browser v0.39.1
// packages/dashboard/src/components/viewport.tsx (Apache-2.0; see third-party notices).
function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/** `preferOwner` selects that owner's browser first (the header entry opens
 * Mira's own browser); `standalone` omits the heading when the dialog has one. */
export function BrowserPanel({ active, preferOwner, standalone = false }: { active: boolean; preferOwner?: string; standalone?: boolean }) {
  const [browsers, setBrowsers] = useState<BrowserStatus[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const statusRevision = useRef(0);
  useVisiblePoll(active, async signal => {
    const revision = statusRevision.current;
    try {
      const result = await api<{ browsers: BrowserStatus[] }>('/api/browser', { signal });
      if (signal.aborted || revision !== statusRevision.current) return;
      setBrowsers(result.browsers); setLoaded(true); setError(null);
      setSelected(current => result.browsers.some(browser => browser.id === current) ? current : (preferOwner ? result.browsers.find(browser => browser.ownerLabel === preferOwner) : undefined)?.id ?? result.browsers[0]?.id ?? '');
    } catch { if (!signal.aborted && revision === statusRevision.current) { setLoaded(true); setError('暂时无法读取浏览器状态，请重试。'); } }
  }, 2500, version);
  useEffect(() => {
    const dialog = document.querySelector('.settings-dialog');
    dialog?.classList.toggle('browser-expanded', active && expanded);
    return () => dialog?.classList.remove('browser-expanded');
  }, [active, expanded]);
  const browser = browsers.find(item => item.id === selected);
  return <div className="browser-panel">
    <div className="browser-heading"><div>{!standalone && <h3>浏览器</h3>}<p>查看 Mira 正在使用的浏览器，需要时接手操作。</p></div><button type="button" onClick={() => setVersion(value => value + 1)}>刷新</button></div>
    {error && <p className="browser-error" role="alert">{error}</p>}
    {!loaded && <p role="status">正在读取浏览器…</p>}
    {loaded && !error && browsers.length === 0 && <div className="browser-empty">还没有活动的浏览器。Mira 使用浏览器时会显示在这里。</div>}
    {browsers.length > 0 && <label className="browser-select">当前浏览器<select value={selected} onChange={event => setSelected(event.target.value)}>{browsers.map((item, index) => <option key={item.id} value={item.id}>{item.ownerLabel || `浏览器 ${index + 1}`} · {item.domain ?? '空白页'}</option>)}</select></label>}
    {active && browser && <BrowserViewport key={browser.id} browser={browser} expanded={expanded} onExpand={() => setExpanded(value => !value)} onStatus={next => { statusRevision.current += 1; setBrowsers(current => current.map(item => item.id === next.id && item.epoch <= next.epoch ? next : item)); }} />}
    {window.location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && <p className="browser-note">当前远程连接未加密。输入账号密码前，请使用 HTTPS 连接 Mira。</p>}
    <p className="browser-note">{standalone ? '关闭此窗口' : '关闭设置'}或连接中断不会自动交还控制权。文件选择、上传和下载暂不支持。</p>
  </div>;
}

function BrowserViewport({ browser, expanded, onExpand, onStatus }: { browser: BrowserStatus; expanded: boolean; onExpand: () => void; onStatus: (browser: BrowserStatus) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bridgeRef = useRef<HTMLTextAreaElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const browserRef = useRef(browser); browserRef.current = browser;
  const statusRef = useRef(onStatus); statusRef.current = onStatus;
  const readyRef = useRef(false);
  const composingRef = useRef(false);
  const pressedRef = useRef(false);
  const pressedButtonRef = useRef(0);
  const compositionCommitRef = useRef<string | null>(null);
  const renderedRef = useRef<{ epoch: number; generation: number; seq: number; width: number; height: number } | null>(null);
  const generationRef = useRef(-1);
  const aliveRef = useRef(true);
  // Epoch before the user's own takeover/return; cleared once a stream for the
  // newer epoch renders (it survived) or after one automatic reconnect.
  const followEpochRef = useRef<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [currentDomain, setCurrentDomain] = useState(browser.domain);
  const clearInput = () => { pressedRef.current = false; if (bridgeRef.current) bridgeRef.current.value = ''; composingRef.current = false; compositionCommitRef.current = null; };
  // Unknown/closed browsers never mint tickets (the server answers 409), so a
  // fail-closed browser shows an explanation instead of a dead reconnect loop.
  const unavailable = browser.state === 'unknown' || browser.state === 'closed';
  useEffect(() => {
    if (unavailable) { setConnected(false); setHasFrame(false); return; }
    const controller = new AbortController();
    let socket: WebSocket | null = null;
    let serial = 0;
    let stopped = false;
    aliveRef.current = true; generationRef.current = -1;
    readyRef.current = false; renderedRef.current = null; setConnected(false); setHasFrame(false); clearInput();
    const invalidate = () => { serial += 1; readyRef.current = false; renderedRef.current = null; setHasFrame(false); clearInput(); canvasRef.current?.getContext('2d')?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height); };
    void api<{ ticket: string; epoch: number }>(`/api/browser/${encodeURIComponent(browser.id)}/ticket`, { method: 'POST', body: '{}', signal: controller.signal }).then(result => {
      if (stopped) return;
      const url = new URL('/api/browser/stream', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url, ['mira-browser', result.ticket]); socketRef.current = socket;
      socket.onopen = () => { if (!stopped) { setConnected(true); setError(null); } };
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
        if (message.type === 'tabs' || message.type === 'url') {
          invalidate();
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
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', seq }));
          image.onload = null; image.onerror = null; image.src = '';
        };
        image.onerror = () => { if (!stopped && generation === serial) { invalidate(); setError('画面无法读取，请重新连接。'); } };
        image.src = `data:image/jpeg;base64,${message.data}`;
      };
      socket.onclose = () => { if (stopped) return; invalidate(); setConnected(false); setError('画面连接已断开。若你已接手，控制权会保持，重新连接后可继续。'); };
      socket.onerror = () => { if (!stopped) setError('暂时无法连接浏览器画面。'); };
    }).catch(() => { if (!stopped) setError('暂时无法连接浏览器画面，请重试。'); });
    return () => { stopped = true; aliveRef.current = false; controller.abort(); invalidate(); socket?.close(); socketRef.current = null; };
  }, [browser.id, connectionVersion, unavailable]);

  useLayoutEffect(() => { readyRef.current = false; renderedRef.current = null; clearInput(); }, [browser.epoch, browser.state]);
  // The server closes epoch-bound streams on every control change. After the
  // user's own takeover/return, reconnect once the new epoch is viewable instead
  // of leaving a "connection lost" error and a manual reconnect step.
  useEffect(() => {
    const from = followEpochRef.current;
    if (from === null || connected || browser.epoch <= from || !['agent', 'human', 'held'].includes(browser.state)) return;
    followEpochRef.current = null; setError(null); setConnectionVersion(value => value + 1);
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
    if (new TextEncoder().encode(value).length > 4096) setError('一次输入或粘贴最多支持 4096 字节，请分段输入。');
    else if (value) send({ type: 'input_text', text: value });
    clearInput();
  };
  const mouse = (event: MouseEvent<HTMLCanvasElement>, eventType: string) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    if (eventType === 'mousePressed' && browserRef.current.state === 'human') bridgeRef.current?.focus({ preventScroll: true });
    const width = renderedRef.current?.width ?? canvas.width, height = renderedRef.current?.height ?? canvas.height;
    // Pointer capture continues outside the canvas; keep a legitimate drag/release
    // at the nearest viewport edge rather than sending invalid coordinates.
    const x = Math.max(0, Math.min(width, Math.round((event.clientX - rect.left) * width / rect.width)));
    const y = Math.max(0, Math.min(height, Math.round((event.clientY - rect.top) * height / rect.height)));
    send({ type: 'input_mouse', eventType, x, y, button: ['left', 'middle', 'right'][eventType === 'mouseReleased' ? pressedButtonRef.current : event.button] ?? 'none', clickCount: eventType === 'mousePressed' ? Math.min(2, Math.max(1, event.detail)) : 0, modifiers: modifiers(event) });
  };
  const releasePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!pressedRef.current) return; pressedRef.current = false; mouse(event, 'mouseReleased');
  };
  // Cancellation/capture loss does not mean the user released the button.
  // Keep the remote press intact so return stays held until an explicit release.
  const abandonPointer = () => { pressedRef.current = false; };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>, eventType: string) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.key === 'Process') return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearInput(); bridgeRef.current?.blur(); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    event.preventDefault(); event.stopPropagation();
    if (eventType !== 'keyDown' || ['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return;
    if (!/^(?:Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|[a-zA-Z0-9])$/.test(event.key)) { setError('此按键暂不支持；可使用普通文本输入或粘贴。'); return; }
    send({ type: 'input_key', key: event.key, modifiers: modifiers(event) });
  };
  const changeControl = async (action: 'takeover' | 'return') => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); readyRef.current = false; clearInput();
    followEpochRef.current = browserRef.current.epoch;
    try {
      const next = await api<BrowserStatus>(`/api/browser/${encodeURIComponent(browser.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'return' ? { epoch: browserRef.current.epoch } : {}) });
      if (aliveRef.current && next.epoch >= browserRef.current.epoch) { browserRef.current = next; statusRef.current(next); }
    } catch { followEpochRef.current = null; socketRef.current?.close(); if (aliveRef.current) setError('操作结果尚未确认，请刷新状态后再试。'); }
    finally { busyRef.current = false; if (aliveRef.current) setBusy(false); }
  };
  return <div className="browser-view">
    <div className="browser-toolbar"><span className="browser-domain">当前标签页 · {currentDomain ?? browser.domain ?? '空白页'}</span><button type="button" onClick={onExpand}>{expanded ? '收起画面' : '放大画面'}</button></div>
    <p className="browser-control-state" role="status">{stateLabels[browser.state]}</p>
    {!!browser.cancelledInputs && <p className="browser-note" role="status">已取消 {browser.cancelledInputs} 条尚未发送的输入。请核对页面结果，不要重复提交。</p>}
    {browser.state === 'returning' && !!browser.queuedInputs && <p className="browser-note">正在取消尚未发送的输入，并等待当前操作响应。</p>}
    {!!browser.pressedButtons?.length && <p className="browser-note" role="status">鼠标仍处于按下状态，暂不能交还。请继续接手，看到当前画面后显式松开鼠标。</p>}
    {unavailable ? <p className="browser-note" role="status">{browser.state === 'closed' ? '这个浏览器已关闭。' : '上一次浏览器操作失败或结果无法确认。为避免重复操作，已停止查看和接手这个浏览器；请让 Mira 关闭它后重新打开。'}</p>
      : browser.message && <p className="browser-note">{browser.message}</p>}
    {!unavailable && <div className="browser-viewport">
      <canvas ref={canvasRef} aria-label="远程浏览器画面" className={hasFrame ? '' : 'browser-canvas-empty'} onPointerDown={event => { event.preventDefault(); if (browserRef.current.state !== 'human' || !readyRef.current) return; pressedRef.current = true; pressedButtonRef.current = event.button; event.currentTarget.setPointerCapture(event.pointerId); mouse(event, 'mousePressed'); }} onPointerMove={event => mouse(event, 'mouseMoved')} onPointerUp={event => { releasePointer(event); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={abandonPointer} onLostPointerCapture={abandonPointer} onContextMenu={event => event.preventDefault()} />
      {!hasFrame && <span className="browser-placeholder">{connected ? '等待当前页面画面…' : '画面尚未连接'}</span>}
      <textarea ref={bridgeRef} className="browser-input-bridge" aria-label="浏览器键盘输入，按 Escape 离开" autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={browser.state !== 'human' || !connected || !hasFrame} onKeyDown={event => key(event, 'keyDown')} onKeyUp={event => key(event, 'keyUp')} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={event => { composingRef.current = false; text(event.data); compositionCommitRef.current = event.data; setTimeout(() => { compositionCommitRef.current = null; }, 0); }} onInput={event => {
        if (composingRef.current) return;
        const value = event.currentTarget.value; const committed = compositionCommitRef.current; compositionCommitRef.current = null;
        if (committed !== null && value === committed) { event.currentTarget.value = ''; return; }
        text(value);
      }} onPaste={event => { event.preventDefault(); text(event.clipboardData.getData('text/plain')); }} onBlur={clearInput} />
    </div>}
    {error && <p className="browser-error" role="alert">{error}</p>}
    <div className="browser-actions">
      {browser.state === 'human' && browser.pressedButtons?.map(button => <button key={button} type="button" disabled={!connected || !hasFrame} onClick={() => send({ type: 'input_release', button })}>松开{({ left: '左键', middle: '中键', right: '右键' } as Record<string, string>)[button] ?? '鼠标'}</button>)}
      {(browser.state === 'agent' || browser.state === 'held') && <button type="button" disabled={busy} onClick={() => void changeControl('takeover')}>{browser.state === 'held' ? '继续接手' : '接手操作'}</button>}
      {['human', 'held', 'requesting'].includes(browser.state) && <button type="button" disabled={busy} onClick={() => void changeControl('return')}>交还 Mira</button>}
      {!connected && !unavailable && <button type="button" disabled={busy} onClick={() => setConnectionVersion(value => value + 1)}>重新连接</button>}
    </div>
    {browser.state === 'human' && !connected && <p className="browser-note">已保留控制权。请点击“重新连接”，看到新画面后再操作。</p>}
    {browser.state === 'human' && <p className="browser-note">点击画面后可输入或粘贴文字，按 Escape 离开键盘输入。完成后请点击“交还 Mira”。</p>}
  </div>;
}
