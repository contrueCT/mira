import { useCallback, useEffect, useState } from 'react';
import { normalizeBrowserAddress } from './browserAddress.ts';

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

export function BrowserAddressBar({ url, enabled, pending, onNavigate }: { url: string | null; enabled: boolean; pending: boolean; onNavigate: (url: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = !enabled || pending;
  useEffect(() => { if (!enabled) { setDraft(null); setError(null); } }, [enabled]);
  const shown = enabled && draft !== null ? draft : (url ?? '');
  return <form className="browser-address" onSubmit={event => {
    event.preventDefault();
    if (locked) return;
    const result = normalizeBrowserAddress(shown);
    if ('error' in result) { setError(result.error); return; }
    setError(null); setDraft(null); onNavigate(result.url);
  }}>
    <label className="browser-address-label">地址<input aria-label="浏览器地址" value={shown} readOnly={locked} autoComplete="off" autoCapitalize="off" spellCheck={false} {...(!enabled ? { title: '接手后可以输入网址', 'aria-describedby': 'browser-address-hint' } : error ? { 'aria-invalid': true as const, 'aria-describedby': 'browser-address-error' } : {})} onChange={event => { if (!locked) { setDraft(event.target.value); setError(null); } }} /></label>
    <button type="submit" disabled={locked}>前往</button>
    {!enabled && <p id="browser-address-hint" className="browser-note">接手后可以输入网址</p>}
    {error && <p id="browser-address-error" className="browser-error" role="alert">{error}</p>}
  </form>;
}

export function BrowserTabList({ tabs, enabled, pending, onSwitch }: { tabs: BrowserTab[]; enabled: boolean; pending: boolean; onSwitch: (tabId: string) => void }) {
  return <ul className="browser-tabs" aria-label="标签页">{tabs.map(tab => {
    const label = tab.title.trim() || tab.domain || '空白页';
    const unavailable = !enabled || pending || tab.active;
    return <li key={tab.tabId}><button type="button" disabled={unavailable} {...(tab.active ? { 'aria-current': 'page' as const } : {})} onClick={() => { if (!unavailable) onSwitch(tab.tabId); }}><span className="browser-tab-title">{label}</span>{tab.domain ? <span className="browser-tab-domain">{tab.domain}</span> : null}{tab.active ? <span className="browser-tab-current">当前</span> : null}</button></li>;
  })}</ul>;
}
