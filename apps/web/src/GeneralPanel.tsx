import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { AccessPanel } from './AccessPanel.tsx';
interface Settings { revision: number; showExternalMessages: boolean }
export function GeneralPanel({ active, onClose, onSaved }: { active: boolean; onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const busyRef = useRef(false);
  const settingsRef = useRef<Settings | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!active || settingsRef.current) return;
    let current = true;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    setSettings(null); setError(null); setSaved(false);
    void api<Settings>('/api/settings/general', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      settingsRef.current = value; setSettings(value); setEnabled(value.showExternalMessages); setBlocked(false);
    }).catch(() => { if (current) setError('读取消息显示设置失败，请重新读取。'); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [active, version]);
  const save = async () => {
    if (!settings || busyRef.current || blocked) return;
    busyRef.current = true; setBusy(true); setError(null); setSaved(false);
    try {
      const next = await api<Settings>('/api/settings/general', { method: 'PUT', body: JSON.stringify({ ...settings, showExternalMessages: enabled }), signal: AbortSignal.timeout(15_000) });
      onSaved();
      if (alive.current) { settingsRef.current = next; setSettings(next); setEnabled(next.showExternalMessages); setSaved(true); }
    } catch (cause) {
      if (alive.current) { setBlocked(true); setError(cause instanceof ApiError && cause.status === 409 ? '设置已在其他设备修改，请重新读取。' : '保存结果未确认，请重新读取后核对。'); }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  return <>
    <section className="settings-body" aria-label="消息显示">
      <h3>消息显示</h3>
      {settings ? <><label className="access-toggle"><span><strong>显示其他渠道的消息</strong></span><input type="checkbox" role="switch" checked={enabled} disabled={busy || blocked} onChange={e => { setEnabled(e.target.checked); setSaved(false); }} /></label>
        <p className="muted">关闭后隐藏飞书等渠道的收发记录，Mira 的普通回复照常显示。所有设备共用此设置。</p>
        <button type="button" className="primary-button" disabled={busy || blocked || enabled === settings.showExternalMessages} onClick={() => { void save(); }}>{busy ? '正在保存…' : '保存消息显示设置'}</button></> : !error && <p role="status">正在读取消息显示设置…</p>}
      {saved && <p role="status">消息显示设置已保存</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => { settingsRef.current = null; setVersion(v => v + 1); }}>重新读取消息显示设置</button></div>}
    </section>
    <AccessPanel active={active} onClose={onClose} />
  </>;
}
