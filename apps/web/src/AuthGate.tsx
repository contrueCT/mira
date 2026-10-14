import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, api } from './api.ts';
import { acceptAuthStatus, beginAuthOperation, finishAuthOperation, getAccessSnapshot, HTTP_WARNING, parseAuthStatus, subscribeAccess } from './auth.ts';

export function AuthGate({ children }: { children: ReactNode }) {
  const access = useSyncExternalStore(subscribeAccess, getAccessSnapshot);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (access.status !== null) return;
    const controller = new AbortController();
    let mounted = true;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setError(null);
    void api<unknown>('/api/auth/status', { signal: controller.signal }, false).then(value => {
      if (mounted && !controller.signal.aborted) acceptAuthStatus(parseAuthStatus(value), access.epoch);
    }).catch(() => { if (mounted) setError('暂时无法确认访问状态。请检查服务连接后重试。'); }).finally(() => clearTimeout(timer));
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [access.epoch, access.status, attempt]);

  if (access.status && (!access.status.enabled || access.status.authenticated)) return children;
  return <main className="access-gate">
    <section className="access-card" aria-labelledby="access-title">
      <div className="mira-ring" aria-hidden="true" />
      <h1 id="access-title">Mira</h1>
      {access.status === null ? <>
        {error ? <><p className="access-error" role="alert">{error}</p><button type="button" className="primary-button" onClick={() => { setError(null); setAttempt(value => value + 1); }}>重新连接</button></> : <p className="access-description" role="status">正在确认访问状态…</p>}
      </> : access.operation && access.operation.kind !== 'login' ? <p className="access-description" role="status">正在确认访问设置…</p> : <LoginForm key={access.epoch} />}
    </section>
  </main>;
}

function LoginForm() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const requestRef = useRef<AbortController | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => { mountedRef.current = true; passwordRef.current?.focus(); return () => { mountedRef.current = false; requestRef.current?.abort(); }; }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || !password) return;
    busyRef.current = true; setBusy(true); setError(null);
    const operation = beginAuthOperation('login');
    const body = JSON.stringify({ password });
    setPassword('');
    const controller = new AbortController(); requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const status = parseAuthStatus(await api<unknown>('/api/auth/login', { method: 'POST', body, signal: controller.signal }, false));
      if (mountedRef.current && !controller.signal.aborted) {
        if (status.enabled && !status.authenticated) throw new Error('Login not confirmed');
        finishAuthOperation(operation, status);
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof ApiError && cause.status === 401 ? '密码不正确，请重新输入。' : cause instanceof ApiError && cause.status === 429 ? '尝试次数过多，请稍后再试。' : '暂时无法完成登录，请检查连接后重试。');
    } finally {
      clearTimeout(timer); finishAuthOperation(operation); busyRef.current = false;
      if (requestRef.current === controller) requestRef.current = null;
      if (mountedRef.current) { setBusy(false); passwordRef.current?.focus(); }
    }
  };
  return <form onSubmit={event => { void submit(event); }}>
    <p className="access-description">输入访问密码，继续与 Mira 对话。</p>
    <label className="field-label" htmlFor="access-login-password">访问密码</label>
    <input ref={passwordRef} id="access-login-password" type="password" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="current-password" value={password} disabled={busy} onChange={event => { setPassword(event.target.value); setError(null); }} required aria-describedby="access-login-warning" />
    {error && <p className="access-error" role="alert">{error}</p>}
    <button className="primary-button access-login-button" type="submit" disabled={busy || !password}>{busy ? '正在进入…' : '进入 Mira'}</button>
    <p id="access-login-warning" className="access-warning">{HTTP_WARNING}</p>
  </form>;
}
