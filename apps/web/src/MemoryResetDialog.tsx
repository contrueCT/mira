import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText, isAbort } from './api.ts';
import { busyText, clearLifeStorage, confirmReady, impactRows, isBusy, LIFE_KEY, progressText, RESET_WORD, type ResetPreview, type ResetScope, type ResetStatus } from './memory-reset.ts';

interface Props { onClose: () => void; onMemoryCleared: (status: ResetStatus) => void }
/** Second-level native modal over Settings (ADR 0047). Default focus is 取消,
 * Esc cancels, the confirm button needs the typed word and a fresh preflight. */
export function MemoryResetDialog({ onClose, onMemoryCleared }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [scope, setScope] = useState<ResetScope>('life');
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [resetPersona, setResetPersona] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<ResetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const runningRef = useRef(false);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const executing = submitting || (progress !== null && progress.state !== 'failed');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    const cancel = (event: Event) => { event.preventDefault(); if (!runningRef.current) onCloseRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => { dialog?.removeEventListener('cancel', cancel); if (dialog?.open) dialog.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(current => current?.scope === scope ? current : null); setPreviewError(null);
    api<ResetPreview>('/api/memory/reset/preview', { method: 'POST', body: JSON.stringify({ scope }), signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setPreview(result); })
      .catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setPreviewError(errorText(cause)); });
    return () => controller.abort();
  }, [scope, version]);

  const poll = async (id: string) => {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 400));
      let status: ResetStatus;
      // The server restarts inside this loop; a missed poll is only retried as a read.
      try { status = await api<ResetStatus>(`/api/memory/reset/${encodeURIComponent(id)}`); }
      catch { continue; }
      setProgress(status);
      if (status.state === 'completed') {
        if (status.scope === 'life' && status.lifeId) {
          // A new life: drop this tab's envelopes for the old one and start fresh.
          try { clearLifeStorage(window.sessionStorage); window.sessionStorage.setItem(LIFE_KEY, status.lifeId); } catch { /* the reload below still shows the new life */ }
          window.location.replace(window.location.pathname);
        } else { runningRef.current = false; onMemoryCleared(status); onCloseRef.current(); }
        return;
      }
      if (status.state === 'failed') { runningRef.current = false; setError(status.error ?? '重置未完成。'); return; }
    }
  };
  const submit = async () => {
    if (!preview || !confirmReady(typed) || executing) return;
    setSubmitting(true); setError(null); runningRef.current = true;
    try {
      const { resetId } = await api<{ resetId: string }>('/api/memory/reset', { method: 'POST', body: JSON.stringify({ scope, token: preview.token, confirm: RESET_WORD, stopRunning: isBusy(preview), ...(preview.persona.custom ? { resetPersona } : {}) }) });
      setProgress({ id: resetId, scope, state: 'stopping', lifeId: null, archivePath: preview.archivePath, commit: null, error: null });
      setSubmitting(false);
      await poll(resetId);
    } catch (cause) {
      setSubmitting(false); runningRef.current = false;
      if (cause instanceof ApiError && cause.status === 409) {
        setError('确认已过期，或者情况已有变化（例如刚开始了新的任务）。已重新检查影响，请再次确认。');
        setVersion(value => value + 1);
      } else if (cause instanceof ApiError && cause.status === 400) setError(errorText(cause));
      else setError(`重置请求的结果尚未确认，不会自动重发。请稍后刷新页面查看。${errorText(cause)}`);
    }
  };
  const name = preview?.persona.name ?? 'Mira';
  const busy = preview ? busyText(preview, scope) : null;
  return <dialog ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="reset-title" aria-describedby="reset-description">
    <div className="confirm-head"><h2 id="reset-title">重置{name}的记忆？</h2>
      <p id="reset-description">选择要清空的范围。两种方式都不会立即删除数据：旧内容会留在 Git 历史或归档里，之后可以恢复；人设、模型等设置不受影响。</p></div>
    <div className="confirm-body">
      <div role="radiogroup" aria-label="重置范围">
        <label className={`scope-option${scope === 'memory' ? ' selected' : ''}`}><input type="radio" name="reset-scope" value="memory" checked={scope === 'memory'} disabled={executing} onChange={() => { setScope('memory'); setError(null); }} />
          <div><strong>只清空长期记忆</strong><span>清空 Memory 工作区（MEMORY.md 和其他记忆文件），作为一次 Git 提交保存，可回退。最近的聊天上下文保留，{name}仍记得这几天在聊什么。</span></div></label>
        <label className={`scope-option${scope === 'life' ? ' selected' : ''}`}><input type="radio" name="reset-scope" value="life" checked={scope === 'life'} disabled={executing} onChange={() => { setScope('life'); setError(null); }} />
          <div><strong>从头开始<span className="tag">推荐</span></strong><span>开始一段新的连续生命：长期记忆、工作上下文、聊天界面、待处理唤醒和定时任务都换成全新的。旧生命整体归档，{name}不会再读到它。</span></div></label>
      </div>
      <section className="impact" aria-label="这次会影响" aria-busy={!preview}>
        <h4>这次会影响</h4>
        {preview && preview.scope === scope ? <ul>{impactRows(preview, scope).map(row => <li key={row.label} className={row.kind}><span>{row.label}</span><b>{row.value}</b></li>)}</ul>
          : previewError ? <p role="alert" className="inline-error">暂时无法检查影响：{previewError}</p> : <p role="status" className="management-empty">正在检查…</p>}
      </section>
      {preview?.persona.custom && <label className="persona-check reset-persona"><input type="checkbox" checked={resetPersona} disabled={executing} onChange={event => setResetPersona(event.target.checked)} /><span>同时恢复默认人设（当前是「{preview.persona.name}」）</span></label>}
      {busy && <p className="busy-note">{busy}</p>}
      <div className="confirm-type"><label className="field-label" htmlFor="reset-confirm">输入“{RESET_WORD}”以确认</label>
        <input id="reset-confirm" autoComplete="off" spellCheck={false} value={typed} disabled={executing} onChange={event => setTyped(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} /></div>
      {progress && progress.state !== 'failed' && <p role="status" className="field-notice">{progressText(progress.state, progress.scope)}</p>}
      {error && <p role="alert" className="inline-error">{error}</p>}
    </div>
    <div className="confirm-foot"><span>{scope === 'life' ? `归档位置：${preview?.archivePath ?? '…'}` : '旧内容保存在 Memory 的 Git 历史中'}</span>
      <div><button ref={cancelRef} type="button" className="secondary-button" disabled={executing} onClick={() => onCloseRef.current()}>取消</button>
        <button type="button" className="danger-fill" disabled={!preview || preview.scope !== scope || !confirmReady(typed) || executing} onClick={() => { void submit(); }}>{isBusy(preview) ? '停止工作并重置' : '重置'}</button></div></div>
  </dialog>;
}
