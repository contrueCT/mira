import { browserUuid } from './uuid.ts';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { ApiError, api, errorText } from './api.ts';
import { effectiveThinkingLevel, thinkingLabels, thinkingLevels } from './reasoning.ts';
import { ApiKeyField } from './ApiKeyField.tsx';
import { hasUsableApiKey, sameCredentialTarget, validateApiKey, withApiKey } from './credentials.ts';
import { CloseIcon } from './icons.tsx';
import { MemoryPanel } from './MemoryPanel.tsx';
import type { MemoryPanelProps } from './MemoryPanel.tsx';
import { ExtensionsPanel } from './ExtensionsPanel.tsx';
import { RunsPanel } from './RunsPanel.tsx';
import { AccessPanel } from './AccessPanel.tsx';
import type { BuiltinCatalog, CustomConnection, CustomConnectionWrite, CustomModel, CustomProtocol, Discovery, Settings, SettingsWrite, ThinkingLevel } from './types.ts';

interface Props { synthetic: boolean; onClose: () => void; onSaved: () => void; returnFocus: RefObject<HTMLButtonElement | null>; memoryRequest: MemoryPanelProps['request']; memoryPending: MemoryPanelProps['pending']; sending: boolean; storageError: string | null; onMemorySubmit: MemoryPanelProps['onSubmit']; onMemoryRetry: MemoryPanelProps['onRetry'] }
type SettingsTab = 'model' | 'memory' | 'extensions' | 'runs' | 'access';
const tabs: { id: SettingsTab; label: string }[] = [{ id: 'model', label: '模型' }, { id: 'memory', label: 'Memory' }, { id: 'extensions', label: '扩展' }, { id: 'runs', label: '运行记录' }, { id: 'access', label: '访问' }];
interface ModelDraft { originalId: string | null; id: string; name: string; contextWindow: string; maxTokens: string; reasoning: '' | 'true' | 'false'; input: '' | 'text' | 'image' | 'text-image' }
const blankModel = (id = '', name = ''): ModelDraft => ({ originalId: null, id, name, contextWindow: '', maxTokens: '', reasoning: '', input: '' });
function modelDraftFrom(model: CustomModel): ModelDraft {
  return { originalId: model.id, id: model.id, name: model.name ?? '', contextWindow: String(model.contextWindow), maxTokens: String(model.maxTokens), reasoning: model.reasoning ? 'true' : 'false', input: model.input.length === 2 ? 'text-image' : model.input[0] ?? '' };
}
function parseModel(model: ModelDraft): CustomModel {
  const contextWindow = Number(model.contextWindow); const maxTokens = Number(model.maxTokens);
  if (!model.id.trim()) throw new Error('请填写模型 ID');
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('请根据服务商文档填写上下文窗口与最大输出，均须为正整数');
  if (maxTokens > contextWindow) throw new Error('最大输出不能超过上下文窗口');
  if (!model.reasoning || !model.input) throw new Error('请明确选择推理能力和输入类型');
  return { id: model.id.trim(), ...(model.name.trim() ? { name: model.name.trim() } : {}), contextWindow, maxTokens, reasoning: model.reasoning === 'true', input: model.input === 'text-image' ? ['text', 'image'] : [model.input] };
}
function validateConnection(connection: CustomConnectionWrite): void {
  validateApiKey(connection);
  const validate = (raw: string) => {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('请填写完整的 http:// 或 https:// 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含密码、查询参数或片段');
    return url;
  };
  const base = validate(connection.baseUrl);
  if (connection.modelsUrl && validate(connection.modelsUrl).origin !== base.origin) throw new Error('模型发现地址需要与服务地址同源');
}
function modelSummary(model: CustomModel): string {
  return `${model.contextWindow.toLocaleString()} 上下文 · ${model.maxTokens.toLocaleString()} 最大输出 · ${model.input.includes('image') ? '含图片输入' : '文本输入'}${model.reasoning ? ' · 推理' : ''}`;
}

export function SettingsDialog({ synthetic, onClose, onSaved, returnFocus, memoryRequest, memoryPending, sending, storageError, onMemorySubmit, onMemoryRetry }: Props) {
  const [tab, setTab] = useState<SettingsTab>('model');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<SettingsWrite | null>(null);
  const [catalog, setCatalog] = useState<BuiltinCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mode, setMode] = useState<'builtin' | 'custom'>('builtin');
  const [providerId, setProviderId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [candidateId, setCandidateId] = useState('');
  const loadAbortRef = useRef<AbortController | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const saveBusyRef = useRef(false);
  const editVersionRef = useRef(0);
  const originalConnectionsRef = useRef<CustomConnection[]>([]);
  const originalCredentialsRef = useRef<Settings['configuration']['builtinCredentials']>({});
  const aliveRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    aliveRef.current = true;
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const cancel = (event: Event) => { event.preventDefault(); onCloseRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => {
      aliveRef.current = false;
      loadAbortRef.current?.abort(); discoveryAbortRef.current?.abort(); saveAbortRef.current?.abort();
      dialog?.removeEventListener('cancel', cancel);
      if (dialog?.open) dialog.close();
      // Parent removes inert in the same commit; restore focus once that commit finishes.
      queueMicrotask(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); });
    };
  }, [returnFocus]);

  useEffect(() => {
    const controller = new AbortController();
    loadAbortRef.current?.abort(); loadAbortRef.current = controller;
    const version = editVersionRef.current;
    setLoading(true); setLoadError(null);
    void Promise.all([api<Settings>('/api/settings', { signal: controller.signal }), api<BuiltinCatalog>('/api/models/catalog', { signal: controller.signal })]).then(([settings, models]) => {
      if (controller.signal.aborted || !aliveRef.current || version !== editVersionRef.current) return;
      originalConnectionsRef.current = structuredClone(settings.configuration.customConnections);
      originalCredentialsRef.current = structuredClone(settings.configuration.builtinCredentials);
      setDraft(settings); setCatalog(models); setDirty(false); setSaved(false); setConflict(false); setError(null); setModelDraft(null);
      const selection = settings.selection;
      setMode(selection?.kind ?? 'builtin');
      setProviderId(selection?.kind === 'builtin' ? selection.provider : models.providers.find(provider => provider.apiKeySupport.supported)?.id ?? models.providers[0]?.id ?? '');
      setConnectionId(selection?.kind === 'custom' ? selection.connection : settings.configuration.customConnections[0]?.id ?? '');
    }).catch((cause: unknown) => { if (!controller.signal.aborted && aliveRef.current) setLoadError(errorText(cause)); }).finally(() => { if (!controller.signal.aborted && aliveRef.current) setLoading(false); });
    return () => controller.abort();
  }, [loadVersion]);

  useEffect(() => {
    if (tab === 'model') return;
    discoveryAbortRef.current?.abort(); discoveryAbortRef.current = null; setDiscovering(false);
  }, [tab]);

  const touch = () => { editVersionRef.current += 1; setDirty(true); setSaved(false); setError(null); };
  const stopDiscovery = () => { discoveryAbortRef.current?.abort(); discoveryAbortRef.current = null; setDiscovering(false); setDiscovery(null); setDiscoveryError(null); setCandidateId(''); };
  const change = (update: (value: SettingsWrite) => SettingsWrite) => { touch(); setDraft(current => current ? update(current) : current); };
  const provider = catalog?.providers.find(item => item.id === providerId);
  const connection = draft?.configuration.customConnections.find(item => item.id === connectionId);
  const selection = draft?.selection;
  const selectedBuiltin = provider?.models.find(model => selection?.kind === 'builtin' && selection.provider === provider.id && model.id === selection.model);
  const selectedCustom = connection?.models.find(model => selection?.kind === 'custom' && selection.connection === connection.id && model.id === selection.model);
  const reasoningSupported = mode === 'builtin' ? selectedBuiltin?.reasoning : modelDraft ? modelDraft.reasoning === 'true' : selectedCustom?.reasoning;
  const availableThinkingLevels = mode === 'builtin' && selectedBuiltin?.thinkingLevels ? selectedBuiltin.thinkingLevels : reasoningSupported ? thinkingLevels.slice(0, 5) : ['off'] as ThinkingLevel[];
  const requestedThinkingLevel = draft?.configuration.defaultThinkingLevel ?? 'medium';
  const activeThinkingLevel = effectiveThinkingLevel(requestedThinkingLevel, availableThinkingLevels);
  const credential = draft?.configuration.builtinCredentials[providerId] ?? { hasApiKey: false };
  const originalConnection = originalConnectionsRef.current.find(item => item.id === connectionId);
  const targetChanged = !!connection && !!originalConnection && !sameCredentialTarget(connection, originalConnection);

  const editCredential = (value: string | null | undefined) => change(current => {
    const previous = current.configuration.builtinCredentials[providerId] ?? { hasApiKey: false };
    const builtinCredentials = { ...current.configuration.builtinCredentials, [providerId]: withApiKey(previous, value) };
    return { ...current, configuration: { ...current.configuration, builtinCredentials } };
  });
  const resetCredential = () => change(current => ({ ...current, configuration: { ...current.configuration, builtinCredentials: { ...current.configuration.builtinCredentials, [providerId]: originalCredentialsRef.current[providerId] ?? { hasApiKey: false } } } }));
  const chooseProvider = (id: string) => {
    setProviderId(id); const item = catalog?.providers.find(value => value.id === id);
    change(current => ({ ...current, selection: item?.models[0] ? { kind: 'builtin', provider: id, model: item.models[0].id } : null }));
  };
  const chooseConnection = (id: string) => {
    stopDiscovery(); setConnectionId(id); setModelDraft(null);
    const item = draft?.configuration.customConnections.find(value => value.id === id);
    change(current => ({ ...current, selection: item?.models[0] ? { kind: 'custom', connection: id, model: item.models[0].id } : null }));
  };
  const chooseMode = (next: 'builtin' | 'custom') => {
    if (next === mode) return;
    setMode(next); stopDiscovery(); setModelDraft(null);
    if (next === 'builtin') chooseProvider(providerId);
    else chooseConnection(connectionId);
  };
  const editConnection = (patch: Partial<CustomConnectionWrite>) => {
    stopDiscovery();
    change(current => ({ ...current, configuration: { ...current.configuration, customConnections: current.configuration.customConnections.map(item => {
      if (item.id !== connectionId) return item;
      const next = { ...item, ...patch };
      // Never reuse a stored or entered secret at a newly edited destination.
      return sameCredentialTarget(item, next) ? next : withApiKey({ ...next, hasApiKey: false }, undefined);
    }) } }));
  };
  const editConnectionCredential = (value: string | null | undefined) => {
    stopDiscovery();
    change(current => ({ ...current,
      configuration: { ...current.configuration, customConnections: current.configuration.customConnections.map(item => item.id === connectionId ? withApiKey(item, value) : item) },
    }));
  };
  const resetConnectionCredential = () => {
    stopDiscovery();
    change(current => ({ ...current, configuration: { ...current.configuration, customConnections: current.configuration.customConnections.map(item => item.id === connectionId ? withApiKey({ ...item, hasApiKey: !!originalConnection?.hasApiKey && sameCredentialTarget(item, originalConnection) }, undefined) : item) } }));
  };
  const reloadSettings = () => {
    stopDiscovery(); setDraft(null); setModelDraft(null); setLoading(true);
    originalConnectionsRef.current = []; originalCredentialsRef.current = {};
    setLoadVersion(value => value + 1);
  };
  const addConnection = () => {
    const id = `custom-${browserUuid().slice(0, 8)}`;
    const next: CustomConnectionWrite = { id, baseUrl: '', api: 'openai-completions', hasApiKey: false, models: [] };
    stopDiscovery(); setConnectionId(id); setModelDraft(blankModel());
    change(current => ({ ...current, selection: null, configuration: { ...current.configuration, customConnections: [...current.configuration.customConnections, next] } }));
  };
  const discardConnection = () => {
    if (!connection) return;
    stopDiscovery(); setModelDraft(null);
    const original = originalConnectionsRef.current.find(item => item.id === connection.id);
    const remaining = draft!.configuration.customConnections.flatMap(item => item.id !== connection.id ? [item] : original ? [structuredClone(original)] : []);
    const next = original ?? remaining[0];
    setConnectionId(next?.id ?? '');
    change(current => ({ ...current, configuration: { ...current.configuration, customConnections: remaining }, selection: next?.models[0] ? { kind: 'custom', connection: next.id, model: next.models[0].id } : null }));
  };
  const discover = async () => {
    if (!connection || discovering || discoveryAbortRef.current) return;
    setDiscoveryError(null); setDiscovery(null); setCandidateId('');
    try { validateConnection(connection); if (!hasUsableApiKey(connection)) throw new Error('请先填写此连接的 API Key'); } catch (cause) { setDiscoveryError(errorText(cause)); return; }
    const controller = new AbortController(); discoveryAbortRef.current = controller;
    const version = editVersionRef.current;
    setDiscovering(true);
    try {
      const result = await api<Discovery>('/api/models/discover', { method: 'POST', body: JSON.stringify({ connection }), signal: controller.signal });
      if (!controller.signal.aborted && aliveRef.current && version === editVersionRef.current) { setDiscovery(result); setCandidateId(result.models[0]?.id ?? ''); }
    } catch (cause) { if (!controller.signal.aborted && aliveRef.current) setDiscoveryError('无法获取模型，请检查服务地址、API Key 和服务权限'); }
    finally { if (discoveryAbortRef.current === controller) { discoveryAbortRef.current = null; if (aliveRef.current) setDiscovering(false); } }
  };
  const useCandidate = () => {
    const candidate = discovery?.models.find(item => item.id === candidateId);
    if (!candidate) return;
    const existing = connection?.models.find(item => item.id === candidate.id);
    touch(); setModelDraft(existing ? modelDraftFrom(existing) : blankModel(candidate.id, candidate.name));
  };
  const updateModelDraft = (patch: Partial<ModelDraft>) => { touch(); setModelDraft(current => current ? { ...current, ...patch } : current); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || saveBusyRef.current || loading) return;
    let next = structuredClone(draft);
    try {
      // Inactive connection edits also belong to the saved document. Explain how
      // to recover a partial draft instead of sending a known-invalid payload.
      for (const entry of Object.values(next.configuration.builtinCredentials)) validateApiKey(entry);
      for (const item of next.configuration.customConnections) {
        try { validateConnection(item); }
        catch { throw new Error(`自定义连接“${item.name ?? item.id}”尚未填写完整。请在自定义连接中完成填写，或使用“${originalConnectionsRef.current.some(original => original.id === item.id) ? '还原此连接' : '取消新增连接'}”保留其他编辑。`); }
      }
      if (mode === 'builtin') {
        if (!provider?.apiKeySupport.supported) throw new Error('此服务商目前仅展示目录，尚不支持 API Key 连接');
        if (credential.apiKey === null) next.selection = null;
        else {
          if (!selectedBuiltin || next.selection?.kind !== 'builtin') throw new Error('请选择一个内置模型');
          if (!hasUsableApiKey(credential)) throw new Error('请填写 API Key');
        }
      } else {
        if (!connection) throw new Error('请添加或选择自定义连接');
        validateConnection(connection);
        if (connection.apiKey !== null && !hasUsableApiKey(connection)) throw new Error('请填写此连接的 API Key；更改服务地址、协议或发现地址后也需要重新输入');
        if (modelDraft) {
          const model = parseModel(modelDraft);
          if (connection.models.some(item => item.id === model.id && item.id !== modelDraft.originalId)) throw new Error('此连接中已存在相同的模型 ID');
          next.configuration.customConnections = next.configuration.customConnections.map(item => item.id === connection.id ? { ...item, models: [...item.models.filter(existing => existing.id !== modelDraft.originalId), model] } : item);
          next.selection = connection.apiKey === null ? null : { kind: 'custom', connection: connection.id, model: model.id };
        } else if (connection.apiKey === null) next.selection = null;
        else if (!selectedCustom || next.selection?.kind !== 'custom') throw new Error('请选择模型，或手动填写模型 ID 和能力');
      }
    } catch (cause) { setError(errorText(cause)); return; }
    saveBusyRef.current = true; setSaving(true); setError(null); setSaved(false);
    const controller = new AbortController(); saveAbortRef.current = controller;
    const version = editVersionRef.current;
    try {
      const result = await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(next), signal: controller.signal });
      if (!controller.signal.aborted && aliveRef.current && version === editVersionRef.current) { originalConnectionsRef.current = structuredClone(result.configuration.customConnections); originalCredentialsRef.current = structuredClone(result.configuration.builtinCredentials); setDraft(result); setDirty(false); setSaved(true); setConflict(false); setModelDraft(null); onSaved(); }
    } catch (cause) {
      if (!controller.signal.aborted && aliveRef.current) {
        if (cause instanceof ApiError && cause.status === 409 && cause.message === 'Mira is working; retry when it is idle') setError('Mira 或子任务仍在运行，暂时不能修改配置。编辑仍保留，等全部结束后可以再次保存。');
        else if (cause instanceof ApiError && cause.status === 409) { setConflict(true); setError('配置已在别处更新。你的编辑仍保留，请重新读取最新配置后再修改。'); }
        else setError('尚未确认保存结果，请重新读取配置核对后再修改。');
      }
    } finally { saveBusyRef.current = false; if (aliveRef.current) setSaving(false); }
  };

  return <dialog ref={dialogRef} className="settings-dialog" aria-labelledby="settings-title" onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="settings-topbar"><div><span className="eyebrow">MIRA · PREFERENCES</span><h2 id="settings-title">设置</h2></div><button ref={closeRef} className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><CloseIcon /></button></div>
    <div className="settings-tabs" role="tablist" aria-label="设置分类">{tabs.map((item, index) => <button key={item.id} id={`settings-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); const target = tabs[next]!; setTab(target.id); document.getElementById(`settings-tab-${target.id}`)?.focus(); }
    }}>{item.label}</button>)}</div>
    <section id="settings-panel-model" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-model" hidden={tab !== 'model'}>
    {loading ? <div className="settings-loading" role="status">正在读取配置…</div> : loadError ? <div className="settings-load-error" role="alert"><p>暂时无法读取模型设置</p><p className="muted">{loadError}</p><button className="secondary-button" onClick={reloadSettings}>重新读取</button></div> : draft && catalog ? <form onSubmit={event => { void submit(event); }} className="settings-form">
      <div className="settings-body">
        <p className="settings-intro">为同一个 Mira 选择模型。直接输入 API Key，保存在本机服务的数据目录中。浏览器只暂存本次输入，不保存或回显已存密钥。</p>
        <fieldset disabled={saving} className="settings-fields">
          <legend className="sr-only">模型连接配置</legend>
          <div className="segmented-control" aria-label="模型来源"><button type="button" aria-pressed={mode === 'builtin'} className={mode === 'builtin' ? 'selected' : ''} onClick={() => chooseMode('builtin')}>内置服务商</button><button type="button" aria-pressed={mode === 'custom'} className={mode === 'custom' ? 'selected' : ''} onClick={() => chooseMode('custom')}>自定义连接</button></div>
          {mode === 'builtin' ? <section className="settings-group" aria-label="内置模型">
            <label className="field-label" htmlFor="builtin-provider">服务商</label>
            <select id="builtin-provider" value={providerId} onChange={event => chooseProvider(event.target.value)}><option value="" disabled>选择服务商</option>{catalog.providers.map(item => <option key={item.id} value={item.id}>{item.name}{item.apiKeySupport.supported ? '' : '（仅目录）'}</option>)}</select>
            {!provider?.apiKeySupport.supported && provider && <p className="field-notice">此服务商需要 OAuth、云账户或专用登录，目前仅可浏览目录。</p>}
            <label className="field-label" htmlFor="builtin-model">模型</label>
            <select id="builtin-model" value={selectedBuiltin?.id ?? ''} onChange={event => change(current => ({ ...current, selection: { kind: 'builtin', provider: providerId, model: event.target.value } }))}><option value="" disabled>选择模型</option>{provider?.models.map(model => <option key={model.id} value={model.id}>{model.name ?? model.id} · {model.id}</option>)}</select>
            {selectedBuiltin && <div className="model-facts"><span>{selectedBuiltin.protocol.name}</span><p>{modelSummary(selectedBuiltin)}</p></div>}
            <ApiKeyField id="builtin-key" credential={credential} onChange={editCredential} onReset={resetCredential} />
            <p className="catalog-note">目录来自 Pi 的内置数据。列出模型不代表账户已开通访问权限。</p>
          </section> : <section className="settings-group" aria-label="自定义模型连接">
            <div className="field-heading"><label className="field-label" htmlFor="custom-connection">连接</label><button type="button" className="text-button" onClick={addConnection}>添加连接</button></div>
            <select id="custom-connection" value={connectionId} onChange={event => chooseConnection(event.target.value)}><option value="" disabled>选择或添加连接</option>{draft.configuration.customConnections.map(item => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}</select>
            {connection && <div className="connection-draft-actions"><span>{connection.id}</span><button type="button" className="text-button" onClick={discardConnection}>{originalConnectionsRef.current.some(item => item.id === connection.id) ? '还原此连接' : '取消新增连接'}</button></div>}
            {!connection ? <div className="custom-empty"><p>连接兼容服务，或你在本地运行的模型。</p><button type="button" className="secondary-button" onClick={addConnection}>添加第一个连接</button></div> : <>
              <label className="field-label" htmlFor="connection-name">连接名称 <span className="optional">可选</span></label>
              <input id="connection-name" value={connection.name ?? ''} placeholder="例如 本地模型" onChange={event => { const name = event.target.value; if (name) editConnection({ name }); else { stopDiscovery(); change(current => ({ ...current, configuration: { ...current.configuration, customConnections: current.configuration.customConnections.map(item => { if (item.id !== connectionId) return item; const { name: _name, ...rest } = item; return rest; }) } })); } }} />
              <label className="field-label" htmlFor="connection-protocol">协议</label>
              <select id="connection-protocol" value={connection.api} onChange={event => editConnection({ api: event.target.value as CustomProtocol })}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select>
              <label className="field-label" htmlFor="connection-url">服务地址</label>
              <input id="connection-url" type="url" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={connection.baseUrl} onChange={event => editConnection({ baseUrl: event.target.value })} />
              <ApiKeyField id="custom-key" credential={connection} onChange={editConnectionCredential} onReset={resetConnectionCredential} />
              {targetChanged && !hasUsableApiKey(connection) && <p className="field-notice">服务地址、协议或发现地址已更改。原密钥不能用于新地址，请重新输入 API Key。</p>}
              <details className="discovery-options"><summary>指定模型发现地址</summary><label className="field-label" htmlFor="models-url">发现地址 <span className="optional">可选，与服务地址同源</span></label><input id="models-url" type="url" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1/models" value={connection.modelsUrl ?? ''} onChange={event => { const modelsUrl = event.target.value; if (modelsUrl) editConnection({ modelsUrl }); else { stopDiscovery(); change(current => ({ ...current, configuration: { ...current.configuration, customConnections: current.configuration.customConnections.map(item => { if (item.id !== connectionId) return item; const { modelsUrl: _url, ...rest } = item; return withApiKey({ ...rest, hasApiKey: false }, undefined); }) } })); } }} /></details>
              <div className="discovery-section"><button type="button" className="secondary-button" onClick={() => { void discover(); }} disabled={discovering}>{discovering ? '正在获取模型…' : '获取可用模型'}</button><p className="field-hint">会请求上方服务的模型目录。你也可以直接填写模型 ID。</p>
                {discoveryError && <p className="inline-error" role="alert">{discoveryError}。仍可手动填写模型</p>}
                {discovery && (discovery.models.length ? <div className="discovery-candidates"><label className="field-label" htmlFor="discovered-model">发现的候选模型</label><select id="discovered-model" value={candidateId} onChange={event => setCandidateId(event.target.value)}>{discovery.models.map(item => <option key={item.id} value={item.id}>{item.name ? `${item.name} · ` : ''}{item.id}</option>)}</select><button type="button" className="text-button" onClick={useCandidate}>使用此 ID，填写能力</button></div> : <p className="field-notice">此服务未返回候选模型，请手动填写 ID。</p>)}
              </div>
              <div className="field-heading"><label className="field-label" htmlFor="custom-model">已配置模型</label><button type="button" className="text-button" onClick={() => { touch(); setModelDraft(blankModel()); }}>手动添加</button></div>
              <select id="custom-model" value={modelDraft ? '' : selectedCustom?.id ?? ''} onChange={event => { setModelDraft(null); change(current => ({ ...current, selection: { kind: 'custom', connection: connection.id, model: event.target.value } })); }}><option value="" disabled>{modelDraft ? '正在填写模型' : '选择模型'}</option>{connection.models.map(item => <option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}</select>
              {selectedCustom && !modelDraft && <div className="model-facts"><p>{modelSummary(selectedCustom)}</p><button type="button" className="text-button" onClick={() => { touch(); setModelDraft(modelDraftFrom(selectedCustom)); }}>编辑模型能力</button></div>}
              {modelDraft && <div className="model-editor">
                <div className="field-heading"><h3>{modelDraft.originalId ? '编辑模型' : '配置模型'}</h3>{connection.models.length > 0 && <button type="button" className="text-button" onClick={() => setModelDraft(null)}>取消编辑</button>}</div>
                <p className="field-hint">发现结果只提供 ID 和名称。请查阅服务商文档，明确填写以下限额和能力。</p>
                <label className="field-label" htmlFor="model-id">模型 ID</label><input id="model-id" spellCheck={false} autoComplete="off" value={modelDraft.id} placeholder="服务商定义的精确 ID" onChange={event => updateModelDraft({ id: event.target.value })} />
                <label className="field-label" htmlFor="model-name">显示名称 <span className="optional">可选</span></label><input id="model-name" value={modelDraft.name} onChange={event => updateModelDraft({ name: event.target.value })} />
                <div className="field-grid"><div><label className="field-label" htmlFor="context-window">上下文窗口</label><input id="context-window" type="number" min="1" step="1" placeholder="tokens" value={modelDraft.contextWindow} onChange={event => updateModelDraft({ contextWindow: event.target.value })} /></div><div><label className="field-label" htmlFor="max-tokens">最大输出</label><input id="max-tokens" type="number" min="1" step="1" placeholder="tokens" value={modelDraft.maxTokens} onChange={event => updateModelDraft({ maxTokens: event.target.value })} /></div></div>
                <div className="field-grid"><div><label className="field-label" htmlFor="reasoning">推理能力</label><select id="reasoning" value={modelDraft.reasoning} onChange={event => updateModelDraft({ reasoning: event.target.value as ModelDraft['reasoning'] })}><option value="" disabled>请选择</option><option value="false">不支持</option><option value="true">支持</option></select></div><div><label className="field-label" htmlFor="model-input">输入类型</label><select id="model-input" value={modelDraft.input} onChange={event => updateModelDraft({ input: event.target.value as ModelDraft['input'] })}><option value="" disabled>请选择</option><option value="text">文本</option><option value="image">图片</option><option value="text-image">文本和图片</option></select></div></div>
              </div>}
            </>}
          </section>}
          <section className="settings-group" aria-label="默认推理设置">
            <label className="field-label" htmlFor="thinking-level">默认推理强度</label>
            <select id="thinking-level" value={activeThinkingLevel} disabled={!reasoningSupported} onChange={event => change(current => ({ ...current, configuration: { ...current.configuration, defaultThinkingLevel: event.target.value as ThinkingLevel } }))}>
              {availableThinkingLevels.map(level => <option key={level} value={level}>{thinkingLabels[level]}</option>)}
            </select>
            <p className="field-hint">用于 Mira、子任务和 Memory 整理；压缩摘要独立使用最低支持档位。更高强度可能增加耗时和费用，实际推理预算仍受总输出上限约束。</p>
            <p className="field-hint">{reasoningSupported ? `当前模型档位：${thinkingLabels[activeThinkingLevel]}。` : '当前模型不支持推理，使用关闭档位。'}{requestedThinkingLevel !== activeThinkingLevel ? `默认偏好“${thinkingLabels[requestedThinkingLevel]}”仍保留，切换模型时按能力适配。` : ''}</p>
          </section>
        </fieldset>
        {error && <div className="settings-error" role="alert"><p>{error}</p><button type="button" className="text-button" disabled={saving} onClick={reloadSettings}>重新读取并放弃当前编辑</button></div>}
        {saved && <p className="saved-notice" role="status">配置已保存。{draft.selection === null ? '当前未启用模型，请选择模型并填写 API Key 后再发送消息。' : synthetic ? '当前仍为模拟模式；重新启动服务并移除 --synthetic 后使用真实模型。' : '下一条新消息将使用所选模型。'}连接是否可用取决于密钥与服务商权限。</p>}
      </div>
      <div className="settings-footer"><span>{dirty ? '尚有未保存的更改' : '密钥保留在本地服务端'}</span><div><button type="button" className="secondary-button" onClick={onClose}>{dirty ? '取消' : '关闭'}</button><button type="submit" className="primary-button" disabled={saving || !dirty || conflict}>{saving ? '正在保存…' : '保存设置'}</button></div></div>
    </form> : null}
    </section>
    <section id="settings-panel-memory" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-memory" hidden={tab !== 'memory'}><MemoryPanel active={tab === 'memory'} request={memoryRequest} pending={memoryPending} sending={sending} storageError={storageError} onSubmit={onMemorySubmit} onRetry={onMemoryRetry} /></section>
    <section id="settings-panel-extensions" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-extensions" hidden={tab !== 'extensions'}><ExtensionsPanel active={tab === 'extensions'} /></section>
    <section id="settings-panel-runs" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-runs" hidden={tab !== 'runs'}><RunsPanel active={tab === 'runs'} /></section>
    <section id="settings-panel-access" className="settings-panel" role="tabpanel" aria-labelledby="settings-tab-access" hidden={tab !== 'access'}><AccessPanel active={tab === 'access'} onClose={onClose} /></section>
  </dialog>;
}
