import { useRef, useState } from 'react';
import { api, errorText, isAbort } from './api.ts';
import type { MemoryRequestIdentity } from './management.ts';
import { MemorySummary } from './MemorySummary.tsx';
import type { MemoryReceipt, MemoryView, MessageEnvelope, MessageStatus, PendingMessage } from './types.ts';
import { useVisiblePoll } from './useVisiblePoll.ts';
import { MemoryResetDialog } from './MemoryResetDialog.tsx';
import type { ResetStatus } from './memory-reset.ts';

export interface MemoryPanelProps {
  /** Display name of the current persona, for honest copy only. */
  name?: string;
  request: MemoryRequestIdentity | null; pending: PendingMessage | null; sending: boolean; storageError: string | null;
  onSubmit: (text: string) => boolean; onRetry: (message: MessageEnvelope) => void;
}
export function memoryReceiptText(memory: MemoryReceipt): string {
  return ({ unavailable: '未记录 Memory checkpoint，无法确认记忆是否发生变化。', pending: 'Memory checkpoint 尚未完成，不能确认记忆变更。', unchanged: '此 Wake 的 Memory checkpoint 未记录文件变更。', changed: '此 Wake 的 Memory checkpoint 记录到文件变更；同一 Wake 可能包含其他请求，这不单独证明本请求已完成。' } as const)[memory.state];
}
export function MemoryPanel({ active, name = 'Mira', request, pending, sending, storageError, onSubmit, onRetry }: MemoryPanelProps & { active: boolean }) {
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<MessageStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [cleared, setCleared] = useState<ResetStatus | null>(null);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const currentRequestRef = useRef(request?.id); currentRequestRef.current = request?.id;

  const readMemory = async (signal: AbortSignal) => {
    try { const result = await api<MemoryView>('/api/memory', { signal }); if (!signal.aborted) { setMemory(result); setReadError(null); } }
    catch (cause) { if (!signal.aborted && !isAbort(cause)) setReadError(errorText(cause)); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  useVisiblePoll(active, readMemory, 5000, version);
  // The identity is part of the effect key. Old request replies can never become
  // the outcome for a newly submitted request, even if reads resolve out of order.
  const requestVersion = request ? `${request.id}:${version}` : '';
  useVisiblePoll(active && !!request, async signal => {
    const id = currentRequestRef.current; if (!id) return;
    try {
      const result = await api<MessageStatus>(`/api/messages/${encodeURIComponent(id)}/status`, { signal });
      if (signal.aborted || currentRequestRef.current !== id) return;
      if (result.id !== id) throw new Error('服务端返回了其他请求的状态，当前结果尚未确认');
      setStatus(result); setStatusError(null);
    } catch (cause) { if (!signal.aborted && currentRequestRef.current === id && !isAbort(cause)) setStatusError(errorText(cause)); }
  }, 1500, requestVersion);
  const currentStatus = status?.id === request?.id ? status : null;
  const unresolved = !!request && (!currentStatus || !['completed', 'failed'].includes(currentStatus.state));
  const label = pending?.state === 'sending' ? '正在发送…' : currentStatus ? ({ unknown: '接收结果尚未确认', submitted: '已接收，等待处理', processing: '此请求正在处理', completed: '此请求所在的 Wake 已结束', failed: '此请求处理遇到错误' } as const)[currentStatus.state] : pending?.state === 'queued' ? '已接收，正在查询处理结果' : '正在核对此请求';

  return <div className="settings-body management-body">
    <div className="management-heading"><div><h3>当前记忆</h3><p>这里是 Mira 记住的重要信息，来自当前记忆总览；细节可能另存于记忆文件。</p></div><button type="button" className="text-button" onClick={() => setVersion(value => value + 1)}>刷新摘要</button></div>
    <section className="memory-content" aria-label="记忆摘要" aria-busy={loading}>
      {loading ? <p role="status" className="management-empty">正在读取记忆…</p> : readError ? <p role="alert" className="inline-error">暂时无法读取记忆：{readError}</p> : memory && !memory.configured ? <p className="management-empty">此服务尚未配置 Memory 工作区。</p> : <MemorySummary text={memory?.content ?? ''} />}
    </section>
    <p className="field-hint">刷新摘要只重读文件，不会强制刷新 Mira 当前上下文中的 Memory。</p>
    <form className="memory-request-form" onSubmit={event => {
      event.preventDefault(); if (sending || unresolved) return;
      setFormError(null);
      try { if (onSubmit(draft)) setDraft(''); else setFormError('请求尚未提交，请检查浏览器存储与当前发送状态。'); }
      catch (cause) { setFormError(errorText(cause)); }
    }}>
      <label className="field-label" htmlFor="memory-edit-request">修改记忆</label>
      <textarea id="memory-edit-request" rows={4} maxLength={50_000} value={draft} onChange={event => { setDraft(event.target.value); setFormError(null); }} placeholder="例如：请把我的称呼改成小林，并记住我周五不安排早会。" disabled={sending || !!storageError} />
      <p className="field-hint">会作为明确的记忆修改请求发给同一个 Mira，由主模型使用普通工具修改文件并保存 Git。Mira 可能先澄清，也可能说明无需修改。请勿填写密码、API Key 等秘密。</p>
      <div className="management-actions"><button type="submit" className="primary-button" disabled={!draft.trim() || sending || unresolved || !!storageError}>提交记忆请求</button></div>
      {formError && <p className="inline-error" role="alert">{formError}</p>}
      {storageError && <p className="inline-error" role="alert">{storageError}</p>}
    </form>
    {request && <section className="request-result" aria-label="记忆请求结果" aria-live="polite">
      <h3>{label}</h3>
      <p className="field-hint">请求 ID：<span className="technical-id">{request.id}</span></p>
      {currentStatus?.runId && <p className="field-hint">Wake：<span className="technical-id">{currentStatus.runId}</span></p>}
      {pending?.state === 'uncertain' && <><p className="field-notice">{pending.error ?? '发送结果尚未确认'}。关闭设置或刷新不会自动重发。</p><button className="secondary-button" type="button" disabled={sending} onClick={() => onRetry(pending)}>核对并重试记忆请求</button></>}
      {statusError && <p className="inline-error" role="alert">无法读取此请求的处理状态：{statusError}</p>}
      {currentStatus?.error && <p className="inline-error">{currentStatus.error}</p>}
      {currentStatus?.assistant && <div className="request-reply"><h4>此 Wake 的 Mira 回复</h4><p>{currentStatus.assistant.text}</p><p className="field-hint">同一 Wake 可能合并处理多条请求，请结合回复内容核对。</p></div>}
      {currentStatus && <p className="field-hint">{memoryReceiptText(currentStatus.memory)}</p>}
      {currentStatus?.memory.commit && <p className="field-hint">Memory commit：<span className="technical-id">{currentStatus.memory.commit}</span></p>}
      {currentStatus?.state === 'completed' && !currentStatus.assistant && <p className="field-notice">此 Wake 没有可展示的文字回复，不能据此判断修改要求已实现。请核对上方当前记忆。</p>}
    </section>}
    <section className="danger-zone" aria-labelledby="memory-reset-title">
      <h3 id="memory-reset-title">重置记忆</h3>
      <p>清空{name}的长期记忆，或者让{name}从头开始认识你。旧数据先归档，不会立即删除。</p>
      {cleared && <p className="field-notice" role="status">长期记忆已清空，旧内容在 Memory Git 提交 <span className="technical-id">{cleared.commit?.slice(0, 7)}</span> 中，可回退。下一次唤醒时，{name}上下文里的记忆会刷新。</p>}
      <button ref={resetButtonRef} type="button" className="danger-button" onClick={() => setResetOpen(true)}>重置记忆…</button>
    </section>
    {resetOpen && <MemoryResetDialog onClose={() => { setResetOpen(false); resetButtonRef.current?.focus(); }} onMemoryCleared={status => { setCleared(status); setVersion(value => value + 1); }} />}
  </div>;
}
