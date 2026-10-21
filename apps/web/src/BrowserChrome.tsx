import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, SVGProps } from 'react';

/** Presentational pieces of the browser panel (redesign v2, see ADR 0034 and
 * apps/web/AGENTS.md). Control logic stays in BrowserPanel.tsx. */
type IconProps = SVGProps<SVGSVGElement>;
const icon = (path: ReactNode, viewBox = '0 0 16 16', stroke = 1.5) => function Icon(props: IconProps) { return <svg viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{path}</svg>; };
export const ChevronIcon = icon(<path d="M4 6l4 4 4-4" />, '0 0 16 16', 1.6);
export const ExpandIcon = icon(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />, '0 0 24 24', 1.7);
export const CollapseIcon = icon(<path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />, '0 0 24 24', 1.7);
export const GlobeIcon = icon(<><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c2 2.2 2 10.2 0 12.4M8 1.8c-2 2.2-2 10.2 0 12.4" /></>, '0 0 16 16', 1.4);
export const LockIcon = icon(<><rect x="3" y="7" width="10" height="7" rx="2" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>);
export const HandIcon = icon(<path d="M5 8V3.5a1 1 0 012 0V7m0-4.5a1 1 0 012 0V7m0-3a1 1 0 012 0v3.5m0-1.5a1 1 0 012 0V10a4.5 4.5 0 01-4.5 4.5H8A4 4 0 014.6 13L2.8 9.8a1 1 0 011.6-1.2L5 9.5" />);
export const KeyboardIcon = icon(<><rect x="1.5" y="4" width="13" height="8.5" rx="1.6" /><path d="M4 7h1m2 0h1m2 0h1M4.5 10h7" /></>, '0 0 16 16', 1.4);
export const WarnIcon = icon(<><path d="M10 2.8l7.6 13.4H2.4z" /><path d="M10 8v4M10 14.4v.2" /></>, '0 0 20 20', 1.6);
export const InfoIcon = icon(<><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.8v.2" /></>);
export const EyeIcon = icon(<><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>);
export const CheckIcon = icon(<path d="M3.5 8.5l3 3 6-7" />, '0 0 16 16', 1.8);
export const ReloadIcon = icon(<path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v2.8h-2.8" />, '0 0 16 16', 1.6);
export const PlugIcon = icon(<path d="M7 3v4M13 3v4M5 7h10v3a5 5 0 01-10 0zM10 15v3" />, '0 0 20 20', 1.6);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6L6 18" />, '0 0 24 24', 1.7);

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query); const sync = () => setMatches(list.matches);
    sync(); list.addEventListener('change', sync); return () => list.removeEventListener('change', sync);
  }, [query]);
  return matches;
}
/** True while the page is in the background; the glow animation pauses then. */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => { const sync = () => setHidden(document.hidden); document.addEventListener('visibilitychange', sync); return () => document.removeEventListener('visibilitychange', sync); }, []);
  return hidden;
}

export type BrowserTone = 'agent' | 'human' | 'lock' | 'off';
export function StatusPill({ tone, children }: { tone: BrowserTone; children: ReactNode }) {
  return <div className={`bp-status is-${tone}`} role="status"><span className="bp-dot" aria-hidden="true" />{children}</div>;
}

export interface SwitcherItem { id: string; name: string; short: string; detail: string; tone: BrowserTone }
/** Browser switcher: a button that opens a listbox popover. */
export function BrowserSwitcher({ items, selected, onSelect, subtitle, compact }: { items: SwitcherItem[]; selected: string; onSelect: (id: string) => void; subtitle?: string; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = items.find(item => item.id === selected) ?? items[0];
  useLayoutEffect(() => { if (open) listRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!listRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  if (!current) return null;
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const choose = (id: string) => { onSelect(id); close(); };
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length); return; }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setActive(event.key === 'Home' ? 0 : items.length - 1); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const item = items[active]; if (item) choose(item.id); return; }
    if (event.key === 'Tab') setOpen(false);
  };
  return <div className="bp-switcher">
    <button ref={buttonRef} type="button" className="bp-select" aria-haspopup="listbox" aria-expanded={open} aria-label={`切换浏览器，当前：${current.name}`} onClick={() => { setActive(Math.max(0, items.findIndex(item => item.id === current.id))); setOpen(value => !value); }}>
      <span className={`bp-dot is-${current.tone}`} aria-hidden="true" /><span className="bp-select-name">{compact ? current.short : current.name}</span>{!compact && subtitle && <span className="bp-select-sub">· {subtitle}</span>}<ChevronIcon className="bp-chev" />
    </button>
    {open && <div ref={listRef} className="bp-pop bp-menu" role="listbox" aria-label="Mira 的浏览器" tabIndex={-1} aria-activedescendant={`bp-option-${active}`} onKeyDown={keys}>
      {items.map((item, index) => <div key={item.id} id={`bp-option-${index}`} role="option" aria-selected={item.id === current.id} className={`bp-option${item.id === current.id ? ' is-current' : ''}${index === active ? ' is-active' : ''}`} onPointerEnter={() => setActive(index)} onClick={() => choose(item.id)}>
        <span className={`bp-dot is-${item.tone}`} aria-hidden="true" /><span className="bp-option-text"><span>{item.name}</span><span className="bp-option-detail">{item.detail}</span></span>{item.id === current.id && <CheckIcon className="bp-option-check" />}
      </div>)}
    </div>}
  </div>;
}

/** Close-and-reopen confirmation. Default focus is 取消; Esc cancels and
 * focus returns to the trigger; Tab stays inside the dialog. */
export function ReopenConfirm({ domain, busy, onCancel, onConfirm }: { domain: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { cancelRef.current?.focus(); }, []);
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0]!, last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div ref={ref} className="bp-pop bp-confirm" role="alertdialog" aria-modal="true" aria-labelledby="bp-confirm-title" aria-describedby="bp-confirm-body" onKeyDown={keys}>
    <h3 id="bp-confirm-title">关闭并重开这个浏览器？</h3>
    <div id="bp-confirm-body">会在 <b>{domain}</b> 打开一个全新的浏览器，旧的会被丢弃：<ul><li>当前页面、标签页和未保存的内容都会丢失</li><li>登录状态可能需要重新登录</li><li>Mira 下次查看浏览器时会得知旧页面已不存在</li></ul></div>
    {busy && <p className="bp-confirm-busy" role="status">正在关闭并重开…</p>}
    <div className="bp-confirm-row"><button ref={cancelRef} type="button" className="bp-btn" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="bp-btn is-danger-fill" disabled={busy} onClick={onConfirm}>确认关闭并重开</button></div>
  </div>;
}

export function BrowserEmpty() {
  return <div className="bp-empty">
    <div className="bp-ill" aria-hidden="true"><i style={{ left: 10 }} /><i style={{ left: 24 }} /><i style={{ left: 38 }} /><span className="bp-ln" style={{ top: 44, width: 120 }} /><span className="bp-ln" style={{ top: 62, width: 90 }} /><span className="bp-ln" style={{ top: 80, width: 104 }} /><span className="bp-ill-ring" /></div>
    <h3>Mira 还没有打开浏览器</h3>
    <p>当 Mira 需要查资料、填写网页表单时，会在这里打开自己的浏览器。打开后你可以实时观看，也可以随时接手操作。</p>
    <div className="bp-steps"><div className="bp-step"><b>实时观看</b>Mira 操作时画面只读，不会误触。</div><div className="bp-step"><b>随时接手</b>登录、验证码等交给你来完成。</div><div className="bp-step"><b>交还继续</b>点「交还 Mira」，它会接着往下做。</div></div>
  </div>;
}
