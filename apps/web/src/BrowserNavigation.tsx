import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { normalizeBrowserAddress } from './browserAddress.ts';
import { GlobeIcon, LockIcon } from './BrowserChrome.tsx';

export type BrowserTab = { tabId: string; active: boolean; title: string; domain: string | null; url: string | null };
export { normalizeBrowserAddress };

/** Tabs and the current page URL from the authenticated viewer socket. */
export function useBrowserNavigation() {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  const onStreamMessage = useCallback((message: { type?: unknown; url?: unknown; tabs?: unknown }) => {
    if (message.type === 'url') { setUrl(typeof message.url === 'string' ? message.url : null); return; }
    if (message.type !== 'tabs' || !Array.isArray(message.tabs)) return;
    const next: BrowserTab[] = [];
    for (const item of message.tabs) {
      if (!item || typeof item !== 'object') continue;
      const tab = item as Record<string, unknown>;
      if (typeof tab.tabId !== 'string' || !/^[\w-]{1,128}$/.test(tab.tabId)) continue;
      next.push({ tabId: tab.tabId, active: tab.active === true, title: typeof tab.title === 'string' ? tab.title : '', domain: typeof tab.domain === 'string' ? tab.domain : null, url: typeof tab.url === 'string' ? tab.url : null });
      if (next.length >= 32) break;
    }
    setTabs(next);
    const active = next.find(tab => tab.active);
    if (active) setUrl(active.url);
  }, []);
  const reset = useCallback(() => { setTabs([]); setUrl(null); }, []);
  return { tabs, url, onStreamMessage, reset };
}

/** Title, or the URL's host + path when the page has no title (design §7). */
export function tabLabel(tab: BrowserTab): string {
  const title = tab.title.trim();
  if (title) return title;
  if (tab.url) { try { const url = new URL(tab.url); const path = url.pathname.replace(/\/$/, ''); return `${url.hostname}${path}`; } catch { /* fall through */ } }
  return tab.domain || '空白页';
}
const initial = (tab: BrowserTab) => (tab.domain || tabLabel(tab)).replace(/^www\./, '').charAt(0).toUpperCase() || '·';

/** Desktop tab strip: role="tablist"; arrows move focus, Enter/Space switch.
 * Read-only lists stay focusable and are marked aria-disabled. */
export function BrowserTabStrip({ tabs, enabled, pending, onSwitch, hint }: { tabs: BrowserTab[]; enabled: boolean; pending: boolean; onSwitch: (tabId: string) => void; hint?: string }) {
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.active));
  const [focus, setFocus] = useState(activeIndex);
  useEffect(() => { setFocus(activeIndex); }, [activeIndex, tabs.length]);
  const usable = enabled && !pending;
  const keys = (event: ReactKeyboardEvent, index: number) => {
    const move = (next: number) => { event.preventDefault(); const target = (next + tabs.length) % tabs.length; setFocus(target); refs.current[target]?.focus(); };
    if (event.key === 'ArrowRight') move(index + 1); else if (event.key === 'ArrowLeft') move(index - 1);
    else if (event.key === 'Home') move(0); else if (event.key === 'End') move(tabs.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const tab = tabs[index]; if (usable && tab && !tab.active) onSwitch(tab.tabId); }
  };
  return <div className={`bp-tabs${usable ? ' is-live' : ''}`}>
    <div className="bp-tablist" role="tablist" aria-label="标签页" {...(!usable ? { 'aria-disabled': true } : {})}>
      {tabs.map((tab, index) => <div key={tab.tabId} ref={node => { refs.current[index] = node; }} role="tab" aria-selected={tab.active} {...(!usable ? { 'aria-disabled': true } : {})} tabIndex={index === focus ? 0 : -1} className={`bp-tab${tab.active ? ' is-active' : ''}`} title={tab.url ?? undefined}
        onKeyDown={event => keys(event, index)} onFocus={() => setFocus(index)} onClick={() => { if (usable && !tab.active) onSwitch(tab.tabId); }}>
        <span className="bp-fav" aria-hidden="true">{initial(tab)}</span><span className="bp-tab-title">{tabLabel(tab)}</span>{tab.domain && <span className="bp-tab-domain">{tab.domain}</span>}
      </div>)}
    </div>
    {hint && <span className="bp-tabs-hint"><LockIcon />{hint}</span>}
  </div>;
}

/** Phone tab rows (under the read-only screen and inside the bottom sheet). */
export function BrowserTabRows({ tabs, enabled, pending, onSwitch, header, autoFocus = false }: { tabs: BrowserTab[]; enabled: boolean; pending: boolean; onSwitch: (tabId: string) => void; header?: ReactNode; autoFocus?: boolean }) {
  const usable = enabled && !pending;
  const activeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (autoFocus) activeRef.current?.focus(); }, [autoFocus]);
  return <section className={`bp-tlist${usable ? '' : ' is-readonly'}`} aria-label="标签页">
    {header}
    <div role="tablist" aria-label="标签页" aria-orientation="vertical" {...(!usable ? { 'aria-disabled': true } : {})}>
      {tabs.map(tab => <button key={tab.tabId} ref={tab.active ? activeRef : undefined} type="button" role="tab" aria-selected={tab.active} {...(!usable ? { 'aria-disabled': true } : {})} className={`bp-tli${tab.active ? ' is-active' : ''}`} onClick={() => { if (usable && !tab.active) onSwitch(tab.tabId); }}>
        <span className="bp-fav" aria-hidden="true">{initial(tab)}</span><span className="bp-tli-text"><span>{tabLabel(tab)}</span>{tab.domain && <span className="bp-tli-domain">{tab.domain}</span>}</span>{tab.active && <span className="bp-tli-current">当前</span>}
      </button>)}
    </div>
  </section>;
}

/** Phone bottom sheet listing all tabs; Esc or 完成 closes it. */
export function BrowserTabSheet({ tabs, enabled, pending, onSwitch, onClose }: { tabs: BrowserTab[]; enabled: boolean; pending: boolean; onSwitch: (tabId: string) => void; onClose: () => void }) {
  return <div className="bp-sheet-layer" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="bp-sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="bp-sheet" role="dialog" aria-modal="true" aria-label="切换标签页">
      <div className="bp-grab" aria-hidden="true" />
      <BrowserTabRows tabs={tabs} enabled={enabled} pending={pending} autoFocus onSwitch={tabId => { onSwitch(tabId); onClose(); }} header={<div className="bp-tlh"><span>标签页 · {tabs.length}</span>{!enabled && <span className="bp-tlh-hint"><LockIcon />接手后可切换</span>}</div>} />
      <button type="button" className="bp-btn bp-sheet-done" onClick={onClose}>完成</button>
    </div>
  </div>;
}

function FormattedUrl({ url }: { url: string | null }) {
  if (!url) return <span className="bp-url-v">空白页</span>;
  try {
    const parsed = new URL(url); const rest = url.slice(url.indexOf(parsed.host) + parsed.host.length);
    return <span className="bp-url-v"><span className="bp-url-h">{parsed.protocol}//</span>{parsed.host}<span className="bp-url-h">{rest}</span></span>;
  } catch { return <span className="bp-url-v">{url}</span>; }
}

/** Address bar: editable only under the human lease; otherwise a read-only
 * textbox that still shows the current URL. */
export function BrowserAddressBar({ url, enabled, pending, onNavigate, hint, trailing }: { url: string | null; enabled: boolean; pending: boolean; onNavigate: (url: string) => void; hint?: string; trailing?: ReactNode }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!enabled) { setDraft(null); setError(null); } }, [enabled]);
  const shown = enabled && draft !== null ? draft : (url ?? '');
  return <form className={`bp-urlrow${enabled ? ' is-live' : ''}`} onSubmit={event => {
    event.preventDefault();
    if (!enabled || pending) return;
    const result = normalizeBrowserAddress(shown);
    if ('error' in result) { setError(result.error); return; }
    setError(null); setDraft(null); onNavigate(result.url);
  }}>
    {enabled
      ? <label className="bp-url is-live"><GlobeIcon /><input aria-label="浏览器地址" value={shown} readOnly={pending} autoComplete="off" autoCapitalize="off" spellCheck={false} inputMode="url" {...(error ? { 'aria-invalid': true as const, 'aria-describedby': 'bp-url-error' } : {})} onChange={event => { if (!pending) { setDraft(event.target.value); setError(null); } }} /></label>
      : <div className="bp-url" role="textbox" aria-readonly="true" aria-label="浏览器地址" tabIndex={0} title={hint} {...(hint ? { 'aria-description': hint } : {})}><LockIcon /><FormattedUrl url={url} /></div>}
    {trailing}
    {enabled && <button type="submit" className="bp-btn is-primary bp-go" disabled={pending}>前往</button>}
    {error && <p id="bp-url-error" className="bp-url-error" role="alert">{error}</p>}
  </form>;
}
