import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errorText, isAbort } from './api.ts';
import { parseConfig } from './management.ts';
import type { ExtensionMutation, ExtensionMutationResult, ExtensionsView, ExtensionView } from './types.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';

const statusLabel: Record<ExtensionView['status'], string> = { disabled: '已停用', 'import-failed': '导入失败', waiting: '等待依赖', loading: '正在加载', active: '运行中', failed: '运行失败', disposed: '已卸载', unloading: '正在卸载' };
const persistenceLabel = { saved: '配置已保存', failed: '配置保存失败', 'not-required': '无需保存配置', 'not-attempted': '未尝试保存配置' } as const;
type Change = (extension: ExtensionView, mutation: ExtensionMutation) => Promise<boolean>;

function ExtensionCard({ extension, releases, busy, blocked, change }: { extension: ExtensionView; releases: { digest: string }[]; busy: boolean; blocked: boolean; change: Change }) {
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState('');
  const [configRevision, setConfigRevision] = useState(extension.revision);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState('');
  const [rollback, setRollback] = useState('');
  const disabled = busy || blocked;
  const invoke = (action: 'enable' | 'disable' | 'reload') => { void change(extension, { action, expectedRevision: extension.revision }); };
  return <article className="extension-card" aria-label={`扩展 ${extension.id}`}>
    <div className="extension-heading"><h3>{extension.id}</h3><span className={`management-badge ${extension.status === 'active' ? 'positive' : ''}`}>{statusLabel[extension.status]}</span></div>
    <dl className="management-facts"><div><dt>配置</dt><dd>{extension.enabled ? '已启用' : '已停用'}</dd></div><div><dt>版本</dt><dd className="technical-id">{extension.generated?.digest ?? '手工扩展，未记录版本摘要'}</dd></div>{extension.generated && <div><dt>激活修订</dt><dd className="technical-id">{extension.generated.revision}</dd></div>}</dl>
    <div className="capability-section"><h4>Tools</h4>{extension.tools.length ? <ul className="capability-list">{extension.tools.map(name => <li key={name}>{name}</li>)}</ul> : <p>当前没有注册工具</p>}</div>
    <div className="capability-section"><h4>ContextProviders</h4>{extension.contextProviders.length ? <ul className="capability-list">{extension.contextProviders.map(name => <li key={name}>{name}</li>)}</ul> : <p>当前没有注册上下文提供者</p>}</div>
    {extension.error && <p className="field-notice">最近错误：{extension.error}</p>}
    <div className="management-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => invoke(extension.enabled ? 'disable' : 'enable')}>{extension.enabled ? '停用' : '启用'}</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => invoke('reload')}>重载</button><button type="button" className="text-button" disabled={disabled} onClick={() => { if (!configOpen) setConfigRevision(extension.revision); setConfigOpen(value => !value); setConfig(''); setError(null); }}>{configOpen ? '取消配置编辑' : '替换配置'}</button></div>
    {configOpen && <form className="extension-config" onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      let value: unknown;
      try { value = parseConfig(config); setError(null); } catch (cause) { setError(errorText(cause)); return; }
      void change(extension, { action: 'configure', expectedRevision: configRevision, config: value }).then(applied => { if (applied) { setConfig(''); setConfigOpen(false); } });
    }}>
      <label className="field-label" htmlFor={`config-${extension.id}`}>完整扩展配置</label>
      <textarea id={`config-${extension.id}`} value={config} onChange={event => setConfig(event.target.value)} rows={5} spellCheck={false} autoComplete="off" placeholder={'{\n  "option": "value"\n}'} disabled={disabled} />
      <p className="field-hint">只写入你明确输入的完整 JSON 配置值，会替换原配置。已有内容和密钥不回显、不预填，不会写入浏览器存储。关闭设置或取消编辑会清除未保存输入。</p>
      {configRevision !== extension.revision && <p className="field-notice">扩展修订已变化，此草稿仍基于旧修订。取消配置编辑后重新打开，以确认使用最新修订。</p>}
      <button type="submit" className="secondary-button" disabled={disabled || !config.trim() || configRevision !== extension.revision}>保存配置</button>
      {error && <p role="alert" className="inline-error">{error}</p>}
    </form>}
    {extension.generated && <details className="extension-versions"><summary>更新与回滚</summary>
      <p className="field-hint">只使用已有 staged 版本。更新和回滚会激活相应版本，不是原子撤销。</p>
      <label className="field-label" htmlFor={`update-${extension.id}`}>已暂存版本</label><select id={`update-${extension.id}`} value={digest} disabled={disabled} onChange={event => setDigest(event.target.value)}><option value="">选择版本摘要</option>{releases.filter(item => item.digest !== extension.generated!.digest).map(item => <option key={item.digest} value={item.digest}>{item.digest}</option>)}</select>
      <button type="button" className="secondary-button" disabled={disabled || !digest || !releases.some(item => item.digest === digest)} onClick={() => { void change(extension, { action: 'update', digest, expectedRevision: extension.revision }).then(applied => { if (applied) setDigest(''); }); }}>应用已暂存更新</button>
      <label className="field-label" htmlFor={`rollback-${extension.id}`}>历史激活修订</label><select id={`rollback-${extension.id}`} value={rollback} disabled={disabled} onChange={event => setRollback(event.target.value)}><option value="">选择要重新激活的修订</option>{extension.generated.history.filter(item => item.id !== extension.generated!.revision).map(item => <option key={item.id} value={item.id}>{item.id} · {item.digest}</option>)}</select>
      <button type="button" className="secondary-button" disabled={disabled || !rollback || !extension.generated.history.some(item => item.id === rollback)} onClick={() => { void change(extension, { action: 'rollback', revision: rollback, expectedRevision: extension.revision }).then(applied => { if (applied) setRollback(''); }); }}>回滚到所选修订</button>
    </details>}
  </article>;
}

export function ExtensionsPanel({ active }: { active: boolean }) {
  const [view, setView] = useState<ExtensionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtensionMutationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [version, setVersion] = useState(0);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const mutationAbort = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; mutationAbort.current?.abort(); }; }, []);
  const read = async (signal: AbortSignal) => {
    try { const next = await api<ExtensionsView>('/api/extensions', { signal }); if (!signal.aborted) { setView(next); setError(null); } }
    catch (cause) { if (!signal.aborted && !isAbort(cause)) setError(errorText(cause)); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  useVisiblePoll(active && !busy, read, 5000, version);
  const reread = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const controller = new AbortController(); mutationAbort.current = controller;
    try { const next = await api<ExtensionsView>('/api/extensions', { signal: controller.signal }); if (!controller.signal.aborted && alive.current) { setView(next); setError(null); setUncertain(false); setMutationError(null); setResult(null); } }
    catch { if (alive.current && !controller.signal.aborted) setError('尚未读取到当前扩展状态，请保持操作暂停并重试核对。'); }
    finally { busyRef.current = false; if (alive.current) { setBusy(false); setLoading(false); } }
  };
  const change: Change = async (extension, mutation) => {
    if (busyRef.current || uncertain) return false;
    busyRef.current = true; setBusy(true); setMutationError(null); setResult(null);
    const controller = new AbortController(); mutationAbort.current = controller;
    try {
      const next = await api<ExtensionMutationResult>(`/api/extensions/${encodeURIComponent(extension.id)}`, { method: 'POST', body: JSON.stringify(mutation), signal: controller.signal });
      if (controller.signal.aborted || !alive.current) return false;
      if (next.extensionId !== extension.id || next.action !== mutation.action) throw new Error('无法核对操作回执');
      setResult(next);
      if (next.runtime) setView(current => current ? { ...current, extensions: current.extensions.map(item => item.id === extension.id ? next.runtime! : item) } : current);
      setVersion(value => value + 1);
      return next.status === 'applied';
    } catch (cause) {
      if (!controller.signal.aborted && alive.current) {
        setUncertain(true);
        setMutationError(cause instanceof ApiError && cause.status === 409 ? '扩展状态已变化，或暂时不能执行此操作。草稿仍保留，请先重新读取并核对。' : '尚未确认此次操作的结果。不会自动重试，请先重新读取并核对当前状态。');
      }
      return false;
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="settings-body management-body">
    <div className="management-heading"><div><h3>扩展</h3><p>查看实际宿主状态，管理已配置的扩展。</p></div><button type="button" className="text-button" disabled={busy} onClick={() => { void reread(); }}>{uncertain ? '重新读取并核对' : '刷新扩展'}</button></div>
    {loading ? <p className="management-empty" role="status">正在读取扩展…</p> : error ? <p className="inline-error" role="alert">{error}</p> : null}
    {mutationError && <p className="field-notice" role="alert">{mutationError}</p>}
    {busy && <p className="field-hint" role="status">正在等待管理操作的实际结果…</p>}
    {result && <div className={result.status === 'applied' ? 'saved-notice' : 'field-notice'} role="status"><p>{result.extensionId}：{result.status === 'applied' ? '操作已应用' : '操作未成功应用'}。{persistenceLabel[result.persistence]}。</p>{result.runtime && <p>当前运行状态：{statusLabel[result.runtime.status]}</p>}{result.error && <p>{result.error}</p>}</div>}
    {view?.error && <p className="field-notice">{view.error}</p>}
    {view && !view.available ? <p className="management-empty">此服务未启用扩展管理。</p> : view && !view.extensions.length ? <p className="management-empty">还没有已配置扩展。这里不会自动安装或激活新扩展。</p> : view?.extensions.map(extension => <ExtensionCard key={extension.id} extension={extension} releases={view.releases} busy={busy} blocked={uncertain} change={change} />)}
  </div>;
}
