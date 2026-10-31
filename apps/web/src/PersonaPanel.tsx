import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorText, isAbort, ApiError } from './api.ts';
import { PersonaAvatar } from './PersonaAvatar.tsx';
import { useVisiblePoll } from './useVisiblePoll.ts';
import {
  avatarFileProblem, avatarTypes, conflictMemoryRequest, defaultLimits, draftFrom, draftProblem, languageLabels, personaPayload, personaRings, renderedLength,
  ringColors, ringLabels, samePersona, uploadAvatar,
  type Persona, type PersonaHistoryItem, type PersonaLanguage, type PersonaLimits, type PersonaPreset, type PersonaState,
} from './persona.ts';

interface Props { active: boolean; sending: boolean; storageError: string | null; onSaved: () => void; onMemorySubmit: (text: string) => boolean; onDirtyChange?: (dirty: boolean) => void }
const savedLabel = (iso: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const count = (text: string) => [...text].length;
function Counter({ text, limit }: { text: string; limit: number }) {
  const used = count(text.trim());
  return <span className={`field-counter${used > limit ? ' over' : ''}`}>{used} / {limit}</span>;
}

export function PersonaPanel({ active, sending, storageError, onSaved, onMemorySubmit, onDirtyChange }: Props) {
  const [state, setState] = useState<PersonaState | null>(null);
  const [limits, setLimits] = useState<PersonaLimits>(defaultLimits);
  const [presets, setPresets] = useState<PersonaPreset[]>([]);
  const [draft, setDraft] = useState<Persona | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [tidy, setTidy] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [history, setHistory] = useState<PersonaHistoryItem[] | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const editRef = useRef(0);

  const dirty = !!draft && !!state && !samePersona(personaPayload(draft), state.persona);
  const revisionRef = useRef<string | null>(null); revisionRef.current = state?.revision ?? null;
  // Only the "applied" badge refreshes in the background; drafts and revisions never change under the user.
  useVisiblePoll(active && !!state, async signal => {
    try {
      const current = await api<PersonaState>('/api/persona', { signal });
      if (!signal.aborted && current.revision === revisionRef.current) setState(previous => previous && previous.revision === current.revision ? { ...previous, applied: current.applied } : previous);
    } catch { /* the badge keeps its last known value */ }
  }, 3000);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!active || (loadedRef.current && loadVersion === 0)) return;
    const controller = new AbortController(); const edit = editRef.current;
    setLoading(true); setLoadError(null);
    void Promise.all([api<PersonaState>('/api/persona', { signal: controller.signal }), api<{ presets: PersonaPreset[] }>('/api/persona/presets', { signal: controller.signal })]).then(([current, list]) => {
      if (controller.signal.aborted) return;
      loadedRef.current = true;
      setState(current); setLimits(current.limits ?? defaultLimits); setPresets(list.presets);
      // A late read never overwrites edits made while it was in flight.
      if (edit === editRef.current) { setDraft(draftFrom(current.persona)); setConflict(false); setError(null); }
    }).catch(cause => { if (!controller.signal.aborted && !isAbort(cause)) setLoadError(errorText(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, loadVersion]);

  const edit = (change: Partial<Persona> | ((current: Persona) => Persona)) => {
    editRef.current++; setNotice(null); setError(null); setPreview(null);
    setDraft(current => current && (typeof change === 'function' ? change(current) : { ...current, ...change }));
  };
  const choosePreset = (preset: PersonaPreset) => {
    // The uploaded image and how to address the user belong to the user, not the template.
    edit(current => { const next = draftFrom(preset.persona); if (preset.persona) { next.avatar = current.avatar; next.userCallName = current.userCallName; } return next; });
  };
  const reload = () => { editRef.current++; setLoadVersion(value => value + 1); setHistory(null); setPreview(null); };
  const chooseAvatar = async (file: File | undefined) => {
    if (!file) return;
    const problem = avatarFileProblem(file, limits.avatarBytes);
    if (problem) { setAvatarError(problem); return; }
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller;
    setUploading(true); setAvatarError(null);
    try { const result = await uploadAvatar(file, controller.signal); if (!controller.signal.aborted) edit({ avatar: result.id }); }
    catch (cause) { if (!controller.signal.aborted && !isAbort(cause)) setAvatarError(errorText(cause)); }
    finally { if (!controller.signal.aborted) setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const showPreview = async () => {
    if (preview !== null) { setPreview(null); return; }
    if (!draft) return;
    try { const result = await api<{ text: string | null }>('/api/persona/preview', { method: 'POST', body: JSON.stringify({ persona: personaPayload(draft) }) }); setPreview(result.text ?? '（未设置人设，使用默认的 Mira。）'); setPanelError(null); }
    catch (cause) { setPanelError(`无法生成注入内容：${errorText(cause)}`); }
  };
  const showHistory = async () => {
    if (history) { setHistory(null); return; }
    try { setHistory((await api<{ items: PersonaHistoryItem[] }>('/api/persona/history')).items); setPanelError(null); }
    catch (cause) { setPanelError(`无法读取历史版本：${errorText(cause)}`); }
  };
  const finish = (result: PersonaState, sent: boolean) => {
    setState(result); setDraft(draftFrom(result.persona)); setHistory(null); setPreview(null); editRef.current++;
    const name = result.persona?.name ?? 'Mira';
    setNotice(!result.changed ? '内容没有变化，未创建新版本。' : <>人设已保存为第 {result.version} 版，从下一次唤醒开始生效。{tidy ? (sent ? <>已请{name}整理冲突的记忆，结果可在 Memory 页查看。</> : <>整理记忆的请求未能发送，可稍后在 Memory 页手动提交。</>) : null}</>);
    onSaved();
  };
  const restore = async (item: PersonaHistoryItem) => {
    if (!state || saving) return;
    setSaving(true); setError(null);
    try {
      const result = await api<PersonaState>('/api/persona/restore', { method: 'POST', body: JSON.stringify({ revision: item.revision, expectedRevision: state.revision }) });
      finish(result, result.changed && tidy ? onMemorySubmit(conflictMemoryRequest(result.persona?.name ?? 'Mira')) : false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError('人设已在别处更新。请重新读取后再恢复。'); }
      else setError(errorText(cause));
    } finally { setSaving(false); }
  };
  const save = async () => {
    if (!draft || !state || saving || conflict) return;
    const problem = draftProblem(draft, limits);
    if (problem) { setError(problem); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const result = await api<PersonaState>('/api/persona', { method: 'PUT', body: JSON.stringify({ revision: state.revision, persona: personaPayload(draft) }) });
      finish(result, result.changed && tidy && !storageError ? onMemorySubmit(conflictMemoryRequest(result.persona?.name ?? 'Mira')) : false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError('人设已在别处更新。当前编辑没有保存；重新读取会放弃这些编辑。'); }
      else setError(`人设尚未保存：${errorText(cause)}`);
    } finally { setSaving(false); }
  };

  if (loading && !draft) return <div className="settings-loading" role="status">正在读取人设…</div>;
  if (loadError && !draft) return <div className="settings-load-error" role="alert"><p>暂时无法读取人设</p><p className="muted">{loadError}</p><button type="button" className="secondary-button" onClick={reload}>重新读取</button></div>;
  if (!draft || !state) return null;
  const name = draft.name.trim() || 'Mira';
  const total = renderedLength(draft);
  const applied = state.applied?.revision === state.revision;
  const selectedPreset = draft.presetId ?? (personaPayload(draft) === null ? 'default' : null);
  return <form className="settings-form persona-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-body management-body">
      <div className="management-heading"><div><h3>人设</h3><p>决定 {name} 怎样介绍自己、怎样说话。人设只影响身份呈现和语气，不会改变它能做什么，也不能绕过授权、工具和事实规则。</p></div><button type="button" className="text-button" aria-expanded={preview !== null} onClick={() => { void showPreview(); }}>{preview !== null ? '收起注入内容' : '查看注入内容'}</button></div>
      <div className="persona-applied">
        {state.version === 0 ? <span className="management-badge">未设置 · 使用默认 Mira</span> : <span className={`management-badge ${applied ? 'positive' : ''}`}>{applied ? '已生效' : '已保存'} · 第 {state.version} 版</span>}
        {state.updatedAt && <span>{savedLabel(state.updatedAt)} 保存{applied ? '' : '，下一次唤醒起使用'}</span>}
        {state.version > 0 && <button type="button" className="text-button" aria-expanded={!!history} onClick={() => { void showHistory(); }}>{history ? '收起历史版本' : '历史版本'}</button>}
      </div>
      {preview !== null && <pre className="persona-preview" aria-label="注入到系统提示词的人设内容">{preview}</pre>}
      {history && <ol className="persona-history" aria-label="历史版本">{history.map(item => <li key={item.revision}>
        <span>第 {item.version} 版 · {item.name ?? '默认 Mira'}</span><time dateTime={item.savedAt}>{savedLabel(item.savedAt)}</time>
        {item.revision === state.revision ? <span className="persona-current">当前</span> : <button type="button" className="text-button" disabled={saving || dirty} title={dirty ? '先保存或撤销当前编辑' : undefined} onClick={() => { void restore(item); }}>恢复</button>}
      </li>)}</ol>}
      {panelError && <p className="inline-error" role="alert">{panelError}</p>}
      <fieldset className="settings-fields" disabled={saving}>
        <legend className="sr-only">人设内容</legend>
        <p className="field-label persona-presets-label" id="persona-presets-label">从模板开始 <span className="optional">选中后填入下方，可继续修改</span></p>
        <div className="persona-presets" role="group" aria-labelledby="persona-presets-label">{presets.map(preset => <button key={preset.id} type="button" aria-pressed={selectedPreset === preset.id} onClick={() => choosePreset(preset)}>{preset.label}</button>)}</div>
        <div className="persona-identity">
          <div className="persona-avatar-column">
            <PersonaAvatar identity={{ name, ring: draft.ring, avatar: draft.avatar }} className="persona-ring" />
            <input ref={fileRef} id="persona-avatar-file" className="sr-only" type="file" accept={avatarTypes.join(',')} onChange={event => { void chooseAvatar(event.target.files?.[0]); }} />
            <button type="button" className="text-button" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? '正在上传…' : draft.avatar ? '更换图片' : '上传图片'}</button>
          </div>
          <div>
            <label className="field-label" htmlFor="persona-name">名字 <span className="optional">显示在顶部，也是它自称的名字</span></label>
            <input id="persona-name" value={draft.name} maxLength={limits.name * 2} autoComplete="off" onChange={event => edit({ name: event.target.value })} />
            {draft.avatar
              ? <div className="persona-image-note"><span>使用上传的图片</span><button type="button" className="text-button" onClick={() => edit({ avatar: null })}>移除图片</button></div>
              : <div className="ring-swatches" role="radiogroup" aria-label="头像环颜色"><span className="lbl" aria-hidden="true">头像环</span>{personaRings.map(ring => <button key={ring} type="button" role="radio" aria-checked={draft.ring === ring} aria-pressed={draft.ring === ring} aria-label={ringLabels[ring]} title={ringLabels[ring]} style={{ ['--c' as string]: ringColors[ring] }} onClick={() => edit({ ring })} />)}</div>}
            <p className="field-hint persona-avatar-hint">{draft.avatar ? '有图片时只显示图片；移除后恢复之前选的头像环颜色。' : `也可上传 PNG、JPEG 或 WebP 图片（不超过 ${Math.round(limits.avatarBytes / 1_048_576)} MB），上传后替代头像环。`}</p>
            {avatarError && <p className="inline-error" role="alert">{avatarError}</p>}
          </div>
        </div>
        <div className="field-grid">
          <div><label className="field-label" htmlFor="persona-user">怎么称呼你 <span className="optional">可选</span></label><input id="persona-user" value={draft.userCallName} maxLength={limits.userCallName * 2} placeholder="例如：你的昵称" autoComplete="off" onChange={event => edit({ userCallName: event.target.value })} /></div>
          <div><label className="field-label" htmlFor="persona-language">主要语言 <span className="optional">可选</span></label><select id="persona-language" value={draft.language} onChange={event => edit({ language: event.target.value as PersonaLanguage })}>{(Object.keys(languageLabels) as PersonaLanguage[]).map(language => <option key={language} value={language}>{languageLabels[language]}</option>)}</select></div>
        </div>
        <label className="field-label" htmlFor="persona-identity">身份与背景 <Counter text={draft.identity} limit={limits.identity} /></label>
        <textarea id="persona-identity" rows={3} value={draft.identity} placeholder="它是谁、平时和你一起做什么。" onChange={event => edit({ identity: event.target.value })} />
        <label className="field-label" htmlFor="persona-personality">性格与态度 <Counter text={draft.personality} limit={limits.personality} /></label>
        <textarea id="persona-personality" rows={2} value={draft.personality} onChange={event => edit({ personality: event.target.value })} />
        <label className="field-label" htmlFor="persona-style">说话方式 <Counter text={draft.speakingStyle} limit={limits.speakingStyle} /></label>
        <textarea id="persona-style" rows={3} value={draft.speakingStyle} onChange={event => edit({ speakingStyle: event.target.value })} />
        <label className="field-label" htmlFor="persona-boundaries">边界 <span className="optional">它不做或不扮演的事</span><Counter text={draft.boundaries} limit={limits.boundaries} /></label>
        <textarea id="persona-boundaries" rows={2} value={draft.boundaries} onChange={event => edit({ boundaries: event.target.value })} />
        <details className="discovery-options persona-examples" open={draft.examples.length > 0}>
          <summary>示例对话（可选，最多 {limits.examples} 组）</summary>
          {draft.examples.map((example, index) => <div className="persona-example" key={index} role="group" aria-label={`示例对话 ${index + 1}`}>
            <span>你说</span><input aria-label={`示例 ${index + 1}：你说`} value={example.user} onChange={event => edit(current => ({ ...current, examples: current.examples.map((item, at) => at === index ? { ...item, user: event.target.value } : item) }))} />
            <span>{name}</span><input aria-label={`示例 ${index + 1}：${name}的回答`} value={example.reply} onChange={event => edit(current => ({ ...current, examples: current.examples.map((item, at) => at === index ? { ...item, reply: event.target.value } : item) }))} />
            <button type="button" className="text-button persona-example-remove" onClick={() => edit(current => ({ ...current, examples: current.examples.filter((_item, at) => at !== index) }))}>删除这组</button>
          </div>)}
          {draft.examples.length < limits.examples && <button type="button" className="text-button persona-example-add" onClick={() => edit(current => ({ ...current, examples: [...current.examples, { user: '', reply: '' }] }))}>添加一组</button>}
        </details>
        <label className="field-label" htmlFor="persona-extra">补充说明 <span className="optional">可选</span><Counter text={draft.extra} limit={limits.extra} /></label>
        <textarea id="persona-extra" rows={2} value={draft.extra} placeholder="其他希望它记住的表达习惯，例如：早上第一条消息可以简短问候。" onChange={event => edit({ extra: event.target.value })} />
      </fieldset>
      <p className="persona-guard"><b>固定不变的部分</b>：如实说明工具结果、按你的授权范围行动、不编造经历。这些写在系统规则里，人设里写了相反的要求也不会生效。</p>
      <label className="persona-check"><input type="checkbox" checked={tidy} onChange={event => setTidy(event.target.checked)} disabled={!!storageError} /><span>保存后请{name}整理与新人设冲突的记忆<small>会作为一条普通的记忆修改请求发给它，结果在 Memory 页查看。</small></span></label>
      <p className="field-notice">保存后从下一次唤醒开始生效；当前正在进行的工作继续使用旧人设。之前的聊天记录不会改写。</p>
      {error && <div className="settings-error" role="alert"><p>{error}</p>{conflict && <button type="button" className="text-button" onClick={reload}>重新读取并放弃当前编辑</button>}</div>}
      {notice && <p className="saved-notice" role="status">{notice}</p>}
    </div>
    <div className="settings-footer"><span>{dirty ? '尚有未保存的更改' : '人设保存在本机服务端'}<span className="count-sep"> · </span><span className={`total-count${total > limits.total ? ' over' : ''}`}>共 {total.toLocaleString()} / {limits.total.toLocaleString()} 字</span></span>
      <div><button type="button" className="secondary-button" disabled={!dirty || saving} onClick={() => { editRef.current++; setDraft(draftFrom(state.persona)); setError(null); setAvatarError(null); }}>撤销修改</button><button type="submit" className="primary-button" disabled={saving || uploading || !dirty || conflict || (tidy && sending)}>{saving ? '正在保存…' : '保存人设'}</button></div>
    </div>
  </form>;
}
