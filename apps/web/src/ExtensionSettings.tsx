import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { ownDraft, secretUpdates } from './extension-settings-drafts.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';

type Field = { key: string; label: string; type: 'text' | 'secret' | 'boolean' | 'select'; value?: string | boolean; configured?: boolean; options?: Array<{ value: string; label: string }> };
type View = { revision: string; fields: Field[]; actions: Array<{ id: string; label: string }>;
  status: { state: 'unconfigured' | 'disconnected' | 'connecting' | 'pending' | 'connected' | 'error'; code?: string; details?: Array<{ label: string; value: string }>; authorization?: { url: string; label: string; qr?: boolean } };
  operation: { id: string; action: string; state: 'pending' | 'succeeded' | 'failed' | 'cancelled' } | null };
const labels = { unconfigured: '待配置', disconnected: '未连接', connecting: '连接中', pending: '等待操作', connected: '已连接', error: '连接异常' };
const operations = { pending: '操作仍在进行', succeeded: '操作已完成', failed: '操作失败，未公开原始错误', cancelled: '操作已取消' };
function safeLink(url: string): string | null { try { const value = new URL(url); return value.protocol === 'https:' && !value.username && !value.password ? value.href : null; } catch { return null; } }

function AuthorizationQr({ url }: { url: string }) {
  const code = useMemo(() => {
    try { const value = qrcode(0, 'M'); value.addData(url); value.make(); return value; } catch { return null; }
  }, [url]);
  if (!code) return <p className="field-hint">二维码暂不可用，请使用上方授权链接。</p>;
  const size = code.getModuleCount();
  const squares: string[] = [];
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) if (code.isDark(row, column)) squares.push(`M${column + 4},${row + 4}h1v1h-1z`);
  return <svg className="extension-authorization-qr" role="img" aria-label="授权二维码" viewBox={`0 0 ${size + 8} ${size + 8}`} width="224" height="224"><rect width="100%" height="100%" fill="white" /><path d={squares.join('')} fill="black" /></svg>;
}
/** Credentials exist only in transient input state and the protected POST body. */
export function ExtensionSettings({ id, active }: { id: string; active: boolean }) {
  const [view, setView] = useState<View | null>(null), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [editing, setEditing] = useState(false), [revision, setRevision] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({}), [secrets, setSecrets] = useState<Record<string, string>>({}), [clear, setClear] = useState<Record<string, boolean>>({});
  const alive = useRef(true), blocked = useRef(false), mutation = useRef<AbortController | null>(null), version = useRef(0);
  const base = `/api/extensions/${encodeURIComponent(id)}/settings`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutation.current?.abort(); }; }, []);
  const read = async (signal: AbortSignal, reconcile = false) => {
    const generation = version.current;
    try { const response = await api<{ settings: View | null }>(base, { signal }); if (!signal.aborted && alive.current && generation === version.current) { setView(response.settings); setLoaded(true); if (reconcile) { setUncertain(false); setError(null); } } }
    catch { if (!signal.aborted && alive.current) { setLoaded(true); setError('暂时无法读取扩展设置。'); } }
  };
  useVisiblePoll(active && !busy, signal => read(signal), 2000);
  const reset = () => { setEditing(false); setSecrets({}); setClear({}); setValues({}); };
  const send = async (suffix: string, body: unknown) => {
    if (blocked.current || uncertain) return;
    blocked.current = true; setBusy(true); setError(null); version.current++;
    const controller = new AbortController(); mutation.current = controller;
    try {
      await api(base + suffix, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      if (!suffix) reset();
      await read(controller.signal, true);
    } catch {
      if (alive.current && !controller.signal.aborted) { setUncertain(true); setError('操作结果尚未确认，或设置已变化。不会自动重试，请先重新读取并核对。'); }
    } finally { blocked.current = false; if (alive.current) setBusy(false); }
  };
  if (!loaded || !view) return error ? <p className="field-notice">{error}</p> : null;
  const pending = view.operation?.state === 'pending';
  const authorization = view.status.authorization, url = authorization ? safeLink(authorization.url) : null;
  return <section className="extension-settings" aria-label={`${id} 连接设置`}>
    <h4>连接与设置</h4><p role="status">{labels[view.status.state]}</p>
    {view.status.code && <p className="field-notice">{({ authentication: '认证失败，请核对凭据。', network: '连接异常，请稍后核对。', configuration: '请检查配置。', unknown: '扩展报告错误，原始诊断已隐藏。' } as Record<string, string>)[view.status.code] ?? '扩展报告错误。'}</p>}
    {view.status.details?.map((detail, index) => <p key={index}><strong>{detail.label}</strong>：{detail.value}</p>)}
    {authorization && url && <p><a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{authorization.label}</a></p>}
    {authorization?.qr && url && <AuthorizationQr url={url} />}
    {view.operation && <p role="status">{operations[view.operation.state]}</p>}
    {error && <p role="alert" className="field-notice">{error}</p>}
    {uncertain && <button type="button" className="secondary-button" disabled={busy} onClick={() => { const controller = new AbortController(); void read(controller.signal, true); }}>重新读取并核对设置</button>}
    <div className="management-actions">
      {view.actions.map(action => <button key={action.id} type="button" className="secondary-button" disabled={busy || uncertain || pending || editing} onClick={() => { void send('/actions', { action: action.id, expectedRevision: view.revision }); }}>{action.label}</button>)}
      {pending && <button type="button" className="secondary-button" disabled={busy || uncertain} onClick={() => { void send('/cancel', { operationId: view.operation!.id }); }}>取消当前操作</button>}
      <button type="button" className="text-button" disabled={busy || pending || uncertain} onClick={() => {
        if (editing) { reset(); return; }
        setRevision(view.revision); setValues(Object.fromEntries(view.fields.filter(field => field.type !== 'secret').map(field => [field.key, field.value ?? (field.type === 'boolean' ? false : '')]))); setEditing(true);
      }}>{editing ? '取消设置编辑' : '编辑连接设置'}</button>
    </div>
    {editing && <form className="extension-config" onSubmit={event => { event.preventDefault(); const updates = secretUpdates(view.fields.filter(field => field.type === 'secret').map(field => field.key), secrets, clear); void send('', { expectedRevision: revision, values, secrets: updates }); }}>
      {view.fields.map(field => <div key={field.key}>
        <label className="field-label" htmlFor={`${id}-setting-${field.key}`}>{field.label}</label>
        {field.type === 'boolean' ? <input id={`${id}-setting-${field.key}`} type="checkbox" checked={ownDraft(values, field.key) === true} disabled={busy} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.checked }))} />
          : field.type === 'select' ? <select id={`${id}-setting-${field.key}`} value={String(ownDraft(values, field.key) ?? '')} disabled={busy} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}><option value="">请选择</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : field.type === 'secret' ? <><input id={`${id}-setting-${field.key}`} type="password" autoComplete="new-password" value={ownDraft(secrets, field.key) ?? ''} disabled={busy || ownDraft(clear, field.key) === true} onChange={event => setSecrets(current => ({ ...current, [field.key]: event.target.value }))} placeholder={field.configured ? '已保存，留空保持不变' : '未保存'} /><label><input type="checkbox" checked={ownDraft(clear, field.key) === true} disabled={busy} onChange={event => { setClear(current => ({ ...current, [field.key]: event.target.checked })); setSecrets(current => ({ ...current, [field.key]: '' })); }} />明确清除此凭据</label></>
          : <input id={`${id}-setting-${field.key}`} type="text" autoComplete="off" value={String(ownDraft(values, field.key) ?? '')} disabled={busy} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} />}
      </div>)}
      <p className="field-hint">凭据不回显。保存后按现有扩展配置流程重载，连接状态以实际结果为准。取消或关闭设置会清除未保存输入。关闭窗口不会自动取消已开始的连接操作。</p>
      {revision !== view.revision && <p className="field-notice">状态已变化，请取消编辑后重新核对。</p>}
      <button className="secondary-button" disabled={busy || uncertain || revision !== view.revision} type="submit">保存连接设置</button>
    </form>}
    <p className="field-hint">停用、重载与更新保留凭据。卸载会删除此安装的凭据，保留扩展自身数据文件。</p>
  </section>;
}
