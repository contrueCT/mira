import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, errorText } from './api.ts';
import { beginAuthOperation, finishAuthOperation, getAccessSnapshot, HTTP_WARNING, parseAuthSettings, parseAuthStatus, subscribeAccess, validateNewPassword } from './auth.ts';
import type { AuthSettings } from './auth.ts';

export function AccessPanel({ active, onClose }: { active: boolean; onClose: () => void }) {
  const access = useSyncExternalStore(subscribeAccess, getAccessSnapshot);
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [busy, setBusy] = useState<'save' | 'logout' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const settingsRef = useRef<AuthSettings | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  // Submitted auth writes finish independently: closing the modal cannot undo a server rotation.
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    if (!active || settingsRef.current || access.operation) return;
    const controller = new AbortController();
    let mounted = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setLoading(true); setLoadError(null);
    void api<unknown>('/api/auth/settings', { signal: controller.signal }).then(value => {
      if (!mounted || controller.signal.aborted) return;
      const next = parseAuthSettings(value);
      settingsRef.current = next; setSettings(next); setEnabled(next.enabled); setChangingPassword(false); setBlocked(false);
    }).catch(() => { if (mounted) setLoadError('暂时无法读取访问设置，请检查连接后重试。'); }).finally(() => { clearTimeout(timer); if (mounted) setLoading(false); });
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [active, loadVersion, access.operation]);

  const clearPasswords = () => { setCurrentPassword(''); setPassword(''); setConfirmation(''); };
  const edit = () => { setError(null); setSaved(false); };
  const reload = () => {
    if (busyRef.current) return;
    clearPasswords(); setSettings(null); settingsRef.current = null; setChangingPassword(false); setError(null); setSaved(false); setLoading(true); setLoadVersion(value => value + 1);
  };
  const changed = !!settings && (enabled !== settings.enabled || changingPassword);
  const dirty = changed || !!currentPassword || !!password || !!confirmation;
  const needsNewPassword = enabled && (!settings?.enabled || changingPassword);
  const needsCurrentPassword = !!settings?.enabled && changed;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || !changed || blocked || busyRef.current) return;
    try {
      if (needsCurrentPassword && !currentPassword) throw new Error('请填写当前访问密码');
      if (needsNewPassword) {
        validateNewPassword(password);
        if (password !== confirmation) throw new Error('两次输入的新密码不一致');
      }
    } catch (cause) { setError(errorText(cause)); return; }
    const body = JSON.stringify({ revision: settings.revision, enabled, ...(needsCurrentPassword ? { currentPassword } : {}), ...(needsNewPassword ? { password } : {}) });
    const operation = beginAuthOperation('settings');
    busyRef.current = true; setBusy('save'); setError(null); setSaved(false); clearPasswords();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const value = await api<unknown>('/api/auth/settings', { method: 'PUT', body, signal: controller.signal });
      const next = parseAuthSettings(value); const status = parseAuthStatus(value);
      if (controller.signal.aborted || !finishAuthOperation(operation, status) || !mountedRef.current) return;
      settingsRef.current = next; setSettings(next); setEnabled(next.enabled); setChangingPassword(false); setSaved(true); setBlocked(false);
    } catch (cause) {
      if (mountedRef.current) {
        if (cause instanceof ApiError && cause.status === 403) setError('当前密码不正确，请重新填写密码后保存。');
        else if (cause instanceof ApiError && cause.status === 429) setError('尝试次数过多，请稍后重新填写密码再试。');
        else if (cause instanceof ApiError && cause.status === 409) { setError('访问设置已在别处更改。请重新读取后再编辑。'); setBlocked(true); }
        else if (cause instanceof ApiError && cause.status === 400) setError('访问设置未保存。请检查密码要求后重新填写。');
        else { setError('保存结果尚未确认。请重新读取访问设置，核对后再操作；若密码已更改，其他浏览器需要重新登录。'); setBlocked(true); }
      }
    } finally {
      clearTimeout(timer); finishAuthOperation(operation); busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };
  const logout = async () => {
    if (busyRef.current || !settings?.enabled) return;
    const operation = beginAuthOperation('logout');
    busyRef.current = true; setBusy('logout'); setError(null); setSaved(false); clearPasswords();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const status = parseAuthStatus(await api<unknown>('/api/auth/logout', { method: 'POST', body: '{}', signal: controller.signal }));
      if (!controller.signal.aborted) {
        if (status.enabled && status.authenticated) throw new Error('Logout not confirmed');
        finishAuthOperation(operation, status);
      }
    } catch { if (mountedRef.current) setError('退出结果尚未确认，请检查连接后重试。'); }
    finally {
      clearTimeout(timer); finishAuthOperation(operation); busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };

  if (loading) return <div className="settings-loading" role="status">正在读取访问设置…</div>;
  if (loadError || !settings) return <div className="settings-load-error" role="alert"><p>{loadError ?? '暂时无法读取访问设置'}</p><button type="button" className="secondary-button" onClick={reload}>重新读取</button></div>;
  return <form className="settings-form" onSubmit={event => { void submit(event); }}>
    <div className="settings-body management-body">
      <div className="management-heading"><div><h3>网页访问</h3><p>为这个 Mira 设置一个共用的访问密码。</p></div><button type="button" className="text-button" disabled={!!busy} onClick={reload}>重新读取{dirty ? '并放弃编辑' : ''}</button></div>
      <fieldset className="settings-fields" disabled={!!busy || blocked}><legend className="sr-only">网页访问密码设置</legend>
        <label className="access-toggle" htmlFor="access-enabled"><span><strong>使用访问密码</strong><span>{settings.enabled ? '当前已启用密码保护' : '当前未启用密码保护'}</span></span><input id="access-enabled" type="checkbox" role="switch" checked={enabled} onChange={event => { edit(); setEnabled(event.target.checked); setChangingPassword(false); clearPasswords(); }} /></label>
        <p className="access-warning">关闭后，任何能连接到此服务的人都可读取聊天、附件和设置，并向 Mira 发送消息。</p>
        <p className="access-warning">{HTTP_WARNING}</p>
        {enabled && settings.enabled && !changingPassword && <button type="button" className="secondary-button" onClick={() => { edit(); setChangingPassword(true); }}>更改访问密码</button>}
        {needsCurrentPassword && <><label className="field-label" htmlFor="access-current-password">当前访问密码</label><input id="access-current-password" type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="current-password" value={currentPassword} onChange={event => { edit(); setCurrentPassword(event.target.value); }} required /></>}
        {needsNewPassword && <>
          <label className="field-label" htmlFor="access-new-password">{settings.enabled ? '新访问密码' : '设置访问密码'}</label>
          <input id="access-new-password" type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="new-password" value={password} onChange={event => { edit(); setPassword(event.target.value); }} required aria-describedby="access-password-help" />
          <p className="field-hint" id="access-password-help">12–256 个字符，不能全部为空白。请使用独立、难以猜测的密码。</p>
          <label className="field-label" htmlFor="access-confirm-password">再次输入新密码</label>
          <input id="access-confirm-password" type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="new-password" value={confirmation} onChange={event => { edit(); setConfirmation(event.target.value); }} required />
          {changingPassword && <button type="button" className="text-button access-cancel-change" onClick={() => { edit(); setChangingPassword(false); clearPasswords(); }}>取消更改密码</button>}
        </>}
        {changed && <p className="field-notice">{enabled ? '保存后，当前浏览器保持登录，其他浏览器需使用新密码重新登录。' : '保存后立即取消密码保护，原有登录会失效。'}</p>}
      </fieldset>
      {error && <div className="settings-error" role="alert"><p>{error}</p>{blocked && <button type="button" className="text-button" disabled={!!busy} onClick={reload}>重新读取并放弃当前编辑</button>}</div>}
      {saved && <p className="saved-notice" role="status">{settings.enabled ? '访问密码已保存，当前浏览器已登录，其他浏览器需重新登录。' : '密码保护已关闭，能连接到此服务的人可以直接访问。'}</p>}
      {settings.enabled && <section className="access-session"><h4>当前浏览器</h4><p className="field-hint">登录有效期为 12 小时。服务重启或访问密码更改后，需要重新登录。退出会清除当前页面中的聊天和未保存输入。</p><button type="button" className="secondary-button" disabled={!!busy} onClick={() => { void logout(); }}>{busy === 'logout' ? '正在退出…' : '退出登录'}</button></section>}
    </div>
    <div className="settings-footer"><span>{dirty ? '尚有未保存的更改' : '密码不回填到浏览器'}</span><div><button type="button" className="secondary-button" onClick={onClose}>{dirty ? '取消' : '关闭'}</button><button type="submit" className="primary-button" disabled={!!busy || !changed || blocked}>{busy === 'save' ? '正在保存…' : '保存访问设置'}</button></div></div>
  </form>;
}
